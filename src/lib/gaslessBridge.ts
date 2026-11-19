import {
  createPublicClient,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  getContract,
  hexToBigInt,
  http,
  maxUint256,
  pad,
  type Address,
  type Chain,
  type Hex,
  type TypedDataDefinition,
} from 'viem'
import { createBundlerClient, toSimple7702SmartAccount } from 'viem/account-abstraction'
import { toAccount, type PrivateKeyAccount } from 'viem/accounts'
import type { SignedAuthorization } from 'viem'
import { getUsdc } from '@/onchain-facts'

/**
 * Gas-in-USDC bridging from a test network to Arc, for a normal wallet upgraded with EIP-7702.
 * Circle Paymaster pays the network's native gas and takes it back from the wallet in USDC, and Circle's
 * Forwarding Service mints on Arc, so one signed transaction on the source network is all it takes.
 * Sources: developers.circle.com/paymaster and developers.circle.com/cctp (Forwarding Service).
 */

const ARC_DOMAIN = 26
const TOKEN_MESSENGER_V2 = '0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA' as const
/** Circle Paymaster v0.8 on every supported testnet. */
const PAYMASTER_V08 = '0x3BA9A96eE3eFf3A69E2B18886AcF52027EFF8966' as const
/** Tells Circle's Forwarding Service to submit the mint on Arc. */
const FORWARDING_HOOK = '0x636374702d666f72776172640000000000000000000000000000000000000000' as const
const IRIS = 'https://iris-api-sandbox.circle.com'
/** Fast transfer. */
const FINALITY_THRESHOLD = 1000
/** Allowance the paymaster may use to charge gas. It only charges the real gas cost. */
const PERMIT_ALLOWANCE = 10_000_000n

/** Reliable public RPCs. The default endpoints that ship with viem can hang. */
const RPC_URL: Record<number, string> = {
  11155111: 'https://ethereum-sepolia-rpc.publicnode.com',
  421614: 'https://arbitrum-sepolia-rpc.publicnode.com',
  84532: 'https://base-sepolia-rpc.publicnode.com',
  80002: 'https://polygon-amoy-bor-rpc.publicnode.com',
}

/** Pimlico's public bundler. It is rate limited, so a production app should use its own key. */
const BUNDLER_URL = (chainId: number) => `https://public.pimlico.io/v2/${chainId}/rpc`

/** CCTP domain per source network, keyed by chain id. */
export const GASLESS_DOMAINS: Record<number, number> = {
  // Ethereum Sepolia is left out: the public bundler accepts operations there and then drops them while the
  // network's new state-gas rules are in effect. Add 11155111: 0 back once a bundler handles it.
  421614: 3, // Arbitrum Sepolia
  84532: 6, // Base Sepolia
  80002: 7, // Polygon Amoy
}

/** What the wallet has to provide. Everything is signed by the user's own wallet. */
export interface GaslessSigner {
  address: Address
  signTypedData: (data: TypedDataDefinition) => Promise<Hex>
  signAuthorization: (input: { contractAddress: Address; chainId: number; nonce: number }) => Promise<SignedAuthorization>
}

export interface Quote {
  /** Most the burn may charge for the protocol and the Forwarding Service. */
  maxFee: bigint
  /** What is burned on the source network: the amount that arrives plus the fees. */
  total: bigint
}

interface FeeRow {
  finalityThreshold: number
  minimumFee: number
  forwardFee: { med: number }
}

/** Fee for a fast transfer with forwarding. It changes, so fetch it right before sending. */
export async function quoteGaslessBridge(chainId: number, amount: bigint): Promise<Quote> {
  const domain = GASLESS_DOMAINS[chainId]
  if (domain === undefined) throw new Error('This network is not supported for gasless bridging')
  const res = await fetch(`${IRIS}/v2/burn/USDC/fees/${domain}/${ARC_DOMAIN}?forward=true`)
  if (!res.ok) throw new Error('Could not get the bridge fee')
  const rows = (await res.json()) as FeeRow[]
  const row = rows.find((r) => r.finalityThreshold === FINALITY_THRESHOLD)
  if (!row) throw new Error('Fast transfers are not available on this route right now')
  const protocolFee = (amount * BigInt(Math.round(row.minimumFee * 100))) / 1_000_000n
  const maxFee = BigInt(row.forwardFee.med) + protocolFee
  return { maxFee, total: amount + maxFee }
}

const permitAbi = [
  ...erc20Abi,
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
] as const

const tokenMessengerAbi = [
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

export type GaslessStage = 'upgrade' | 'permit' | 'send' | 'confirm'

/**
 * Approves and burns USDC on the source network in one user operation, paying gas in USDC.
 * Returns the transaction hash. Circle mints on Arc a short time after the burn confirms.
 */
export async function gaslessBridge(params: {
  chain: Chain
  signer: GaslessSigner
  quote: Quote
  onStage?: (stage: GaslessStage) => void
  /** Called with the user operation hash as soon as the bundler accepts it. */
  onSent?: (userOpHash: Hex) => void
}): Promise<{ txHash: Hex }> {
  const { chain, signer, quote, onStage, onSent } = params
  const domain = GASLESS_DOMAINS[chain.id]
  const usdc = getUsdc(chain.id)?.address as Address | undefined
  if (domain === undefined || !usdc) throw new Error('This network is not supported for gasless bridging')

  const client = createPublicClient({ chain, transport: http(RPC_URL[chain.id]) })

  // The wallet's own signer, shaped like the account viem's 7702 smart account expects.
  // The smart account only ever asks it to sign typed data.
  const owner = toAccount({
    address: signer.address,
    signMessage: () => Promise.reject(new Error('Message signing is not used here')),
    signTransaction: () => Promise.reject(new Error('Transaction signing is not used here')),
    signTypedData: (data) => signer.signTypedData(data as unknown as TypedDataDefinition),
  }) as unknown as PrivateKeyAccount
  const account = await toSimple7702SmartAccount({ client, owner })

  // Allow the paymaster to take its gas fee from the wallet's USDC with a signed permit, so no approve transaction is needed.
  onStage?.('permit')
  const token = getContract({ client, address: usdc, abi: permitAbi })
  const permitSignature = await account.signTypedData({
    domain: { name: await token.read.name(), version: await token.read.version(), chainId: chain.id, verifyingContract: usdc },
    types: {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'Permit',
    message: {
      owner: signer.address,
      spender: PAYMASTER_V08,
      value: PERMIT_ALLOWANCE,
      nonce: await token.read.nonces([signer.address]),
      // The paymaster cannot read the block time, so the deadline has to be the maximum.
      deadline: maxUint256,
    },
  })

  const paymasterData = {
    paymaster: PAYMASTER_V08,
    paymasterData: encodePacked(['uint8', 'address', 'uint256', 'bytes'], [0, usdc, PERMIT_ALLOWANCE, permitSignature]),
    paymasterVerificationGasLimit: 200_000n,
    paymasterPostOpGasLimit: 35_000n,
    isFinal: true,
  } as const
  const paymaster = { getPaymasterData: () => Promise.resolve(paymasterData) }

  const bundler = createBundlerClient({
    account,
    client,
    paymaster,
    userOperation: {
      estimateFeesPerGas: async ({ bundlerClient }) => {
        const { fast: standard } = (await bundlerClient.request({ method: 'pimlico_getUserOperationGasPrice' } as never)) as {
          fast: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex }
        }
        return { maxFeePerGas: hexToBigInt(standard.maxFeePerGas), maxPriorityFeePerGas: hexToBigInt(standard.maxPriorityFeePerGas) }
      },
    },
    transport: http(BUNDLER_URL(chain.id)),
  })

  // One-time upgrade: the wallet signs a 7702 authorization so its own address can send user operations.
  // It is skipped once the wallet is already upgraded on this network.
  const code = await client.getCode({ address: signer.address })
  const upgraded = code?.toLowerCase() === `0xef0100${account.authorization.address.slice(2)}`.toLowerCase()
  let authorization: SignedAuthorization | undefined
  if (!upgraded) {
    onStage?.('upgrade')
    authorization = await signer.signAuthorization({
      contractAddress: account.authorization.address,
      chainId: chain.id,
      nonce: await client.getTransactionCount({ address: signer.address }),
    })
  }

  onStage?.('send')
  const calls = [
    { to: usdc, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [TOKEN_MESSENGER_V2, quote.total] }) },
    {
      to: TOKEN_MESSENGER_V2,
      data: encodeFunctionData({
        abi: tokenMessengerAbi,
        functionName: 'depositForBurnWithHook',
        args: [quote.total, ARC_DOMAIN, pad(signer.address, { size: 32 }), usdc, pad('0x', { size: 32 }), quote.maxFee, FINALITY_THRESHOLD, FORWARDING_HOOK],
      }),
    },
  ]
  const delegation = authorization ? { authorization } : {}
  // Newer Ethereum networks charge extra state gas that the bundler's estimate can come in under, so the
  // user operation would be rejected after it was accepted. Pad the estimate; unused gas is not charged.
  const { signature: _stub, ...prepared } = await bundler.prepareUserOperation({ account, calls, ...delegation })
  const hash = await bundler.sendUserOperation({
    ...prepared,
    preVerificationGas: (prepared.preVerificationGas * 3n) / 2n,
    ...delegation,
  })

  onSent?.(hash)
  onStage?.('confirm')
  const receipt = await bundler.waitForUserOperationReceipt({ hash, timeout: 90_000 }).catch(async (e: unknown) => {
    // The bundler can accept an operation and then drop it. Say so instead of waiting forever.
    const status = await fetch(BUNDLER_URL(chain.id), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'pimlico_getUserOperationStatus', params: [hash] }),
    })
      .then((r) => r.json() as Promise<{ result?: { status?: string } }>)
      .then((j) => j.result?.status)
      .catch(() => undefined)
    if (status === 'rejected') throw new Error('The network bundler dropped this transaction')
    throw e
  })
  if (!receipt.success) throw new Error('The transaction was rejected onchain')
  return { txHash: receipt.receipt.transactionHash }
}
