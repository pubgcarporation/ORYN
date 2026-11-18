import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Address, type Hex } from 'viem'
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
  rpcUrls: { default: { http: ['https://rpc.mainnet.arc.io'] } },
})

export function makeClients(env: Env) {
  const testnetUrl = env.TESTNET_RPC_URL || arcTestnet.rpcUrls.default.http[0]
  // Same-tick reads are grouped into one Multicall3 call, which keeps the number of requests low.
  const testnet = createPublicClient({ chain: arcTestnet, transport: http(testnetUrl), batch: { multicall: true } })
  const mainnet = createPublicClient({ chain: arcMainnet, transport: http(env.MAINNET_RPC_URL || arcMainnet.rpcUrls.default.http[0]) })
  return { testnet, mainnet, testnetUrl }
}

export type Clients = ReturnType<typeof makeClients>

export function accountFrom(key: string | undefined) {
  if (!key) return undefined
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('A private key secret is not a 32-byte hex value')
  return privateKeyToAccount(key as Hex)
}

export function walletFor(env: Env, c: Clients, key: string | undefined) {
  const account = accountFrom(key)
  if (!account) return undefined
  return { account, client: createWalletClient({ account, chain: arcTestnet, transport: http(c.testnetUrl) }) }
}

export const poolAddress = (env: Env) => env.POOL_ADDRESS as Address

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const errText = (e: unknown): string => {
  const message = e instanceof Error ? (('shortMessage' in e && typeof e.shortMessage === 'string' ? e.shortMessage : e.message) as string) : String(e)
  return message.replace(/\s+/g, ' ').slice(0, 240)
}
