import { createPublicClient, createWalletClient, defineChain, fallback, http, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'
import type { Env } from './types'

export const WAD = 10n ** 18n

export const poolAbi = parseAbi([
  'function assets() view returns (address usdc, address eurc, address cirBtc)',
  'function isPriceFresh() view returns (bool)',
  'function paused() view returns (bool)',
  'function priceOf(address asset) view returns (uint256 price8)',
  'function getUserAccount(address user) view returns (uint256 collateralValueUsd8, uint256 debtValueUsd8, uint256 borrowCapacityUsd8, uint256 liquidationValueUsd8, uint256 healthFactorWad)',
  'function getUserPosition(address user) view returns ((uint256[3] supplyBalances, uint256[3] debtBalances, uint256 totalSupplyValueUsd, uint256 totalDebtValueUsd) p)',
  'function liquidate(address borrower, address debtAsset, address collateralAsset, uint256 repayAmount, bool receiveSupplyShares)',
  'function liquidationCloseFactor(address borrower) view returns (uint256)',
  'event Borrow(address indexed user, address indexed asset, uint256 amount, uint256 shares)',
  'event Liquidation(address indexed liquidator, address indexed borrower, address indexed debtAsset, address collateralAsset, uint256 repaid, uint256 seized, bool paidUnderlying)',
])

export const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

export const mirrorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function pushRound(int256 answer, uint256 sourceUpdatedAt, uint80 sourceRoundId)',
])

/** Arc mainnet is only read from: it is where the live Chainlink feeds are. */
export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  // Arc's own endpoints (docs.arc.io/arc/references/rpc-endpoints): Circle first, then the node providers.
  // All of them answer without an API key.
  rpcUrls: {
    default: {
      http: [
        'https://rpc.mainnet.arc.io',
        'https://rpc.blockdaemon.mainnet.arc.io',
        'https://rpc.drpc.mainnet.arc.io',
        'https://rpc.quicknode.mainnet.arc.io',
      ],
    },
  },
})

/** One transport that tries each endpoint in order and moves to the next when one refuses or rate-limits. */
function transportFor(urls: (string | undefined)[]) {
  // JSON-RPC batching sends calls made in the same moment as one HTTP request.
  const rpc = { batch: true, retryCount: 1, retryDelay: 1000, timeout: 8_000 } as const
  const unique = [...new Set(urls.filter((u): u is string => Boolean(u && u.trim())))]
  return fallback(unique.map((u) => http(u, rpc)))
}

export function makeClients(env: Env) {
  const testnetTransport = transportFor([env.TESTNET_RPC_URL, ...arcTestnet.rpcUrls.default.http])
  const mainnetTransport = transportFor([env.MAINNET_RPC_URL, ...arcMainnet.rpcUrls.default.http])
  // Same-tick reads are grouped into one Multicall3 call, which keeps the number of requests low.
  const testnet = createPublicClient({ chain: arcTestnet, transport: testnetTransport, batch: { multicall: true } })
  const mainnet = createPublicClient({ chain: arcMainnet, transport: mainnetTransport })
  return { testnet, mainnet, testnetTransport }
}

export type Clients = ReturnType<typeof makeClients>

/** Cleans a pasted key: removes spaces and quotes and adds the 0x prefix when it is missing. */
function normalizeKey(raw: string): string {
  const key = raw.trim().replace(/^["']|["']$/g, '').trim()
  return /^[0-9a-fA-F]{64}$/.test(key) ? `0x${key}` : key
}

export function accountFrom(key: string | undefined) {
  if (!key || key.trim() === '') return undefined
  const clean = normalizeKey(key)
  if (!/^0x[0-9a-fA-F]{64}$/.test(clean)) throw new Error('A private key secret is not a 32-byte hex value')
  return privateKeyToAccount(clean as Hex)
}

export function walletFor(env: Env, c: Clients, key: string | undefined) {
  const account = accountFrom(key)
  if (!account) return undefined
  return { account, client: createWalletClient({ account, chain: arcTestnet, transport: c.testnetTransport }) }
}

export const poolAddress = (env: Env) => env.POOL_ADDRESS as Address

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const errText = (e: unknown): string => {
  const message = e instanceof Error ? (('shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message) as string) : String(e)
  return message.replace(/\s+/g, ' ').slice(0, 240)
}
