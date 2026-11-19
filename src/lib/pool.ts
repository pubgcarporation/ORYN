import { parseAbi, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { getUsdc } from '@/onchain-facts'
import { formatUnitsFixed, parseUnitsExact } from '@/onchain-money'

export const ARC_ID = arcTestnet.id

const usdcFact = getUsdc(ARC_ID)
if (!usdcFact) throw new Error('USDC is not registered for Arc Testnet')

// Public deployment addresses on Arc Testnet. The env vars let a redeploy point at another market.
export const POOL_ADDRESS = ((import.meta.env.VITE_LENDING_POOL_ADDRESS as string | undefined) || '0x7123a2846d167e42489dc4496b3a3e6081117052') as Address
export const CIRBTC_ADDRESS = ((import.meta.env.VITE_CIRBTC_ADDRESS as string | undefined) || '0xf0C4a4CE82A5746AbAAd9425360Ab04fbBA432BF') as Address
export const EURC_ADDRESS = ((import.meta.env.VITE_EURC_ADDRESS as string | undefined) || '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a') as Address

export type AssetSymbol = 'USDC' | 'EURC' | 'cirBTC'

export interface AssetInfo {
  symbol: AssetSymbol
  name: string
  address: Address
  decimals: number
}

export const ASSETS: Record<AssetSymbol, AssetInfo> = {
  USDC: { symbol: 'USDC', name: 'USD Coin', address: usdcFact.address as Address, decimals: usdcFact.decimals },
  // EURC is a 6-decimal ERC-20 on Arc.
  EURC: { symbol: 'EURC', name: 'Euro Coin', address: EURC_ADDRESS, decimals: 6 },
  // Circle's wrapped Bitcoin on Arc has 8 decimals, like Bitcoin itself.
  cirBTC: { symbol: 'cirBTC', name: 'Circle Bitcoin', address: CIRBTC_ADDRESS, decimals: 8 },
}

export const ASSET_LIST: AssetInfo[] = [ASSETS.USDC, ASSETS.EURC, ASSETS.cirBTC]

/** Prices in 8-decimal USD for every asset, as the pool reads them from Chainlink. */
export type Prices = Record<AssetSymbol, bigint>

export const poolAbi = parseAbi([
  'function deposit(address asset, uint256 amount)',
  'function withdraw(address asset, uint256 amount)',
  'function borrow(address asset, uint256 amount)',
  'function repay(address asset, uint256 amount)',
  'function getReserveData(address asset) view returns (uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, uint256 utilization, uint256 supplyRateApr, uint256 borrowRateApr, uint256 supplyCap, uint256 borrowCap, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 price8)',
  'function liquidationCloseFactor(address borrower) view returns (uint256)',
  'function getUserAccount(address user) view returns (uint256 collateralValueUsd8, uint256 debtValueUsd8, uint256 borrowCapacityUsd8, uint256 liquidationValueUsd8, uint256 healthFactorWad)',
  'function supplyBalanceOf(address asset, address user) view returns (uint256)',
  'function debtBalanceOf(address asset, address user) view returns (uint256)',
  'function maxBorrowable(address asset, address user) view returns (uint256)',
  'function maxWithdrawable(address asset, address user) view returns (uint256)',
  'function previewBorrowLimit(address user, address token, uint256 amount) view returns (uint256 healthFactorAfterWad, bool withinBorrowLimit)',
  'function eurUsdPrice() view returns (uint256)',
  'function isPriceFresh() view returns (bool)',
  'function paused() view returns (bool)',
  'function OPTIMAL_UTILIZATION() view returns (uint256)',
  'function SLOPE1() view returns (uint256)',
  'function SLOPE2() view returns (uint256)',
  'function RESERVE_FACTOR() view returns (uint256)',
  'function priceUpdatedAt() view returns (uint256)',
  'function priceFeed() view returns (address)',
  'function aToken(address asset) view returns (address)',
  'function debtToken(address asset) view returns (address)',
  'function maxPriceAge() view returns (uint256)',
])

export const poolEventsAbi = parseAbi([
  'event Deposit(address indexed user, address indexed asset, uint256 amount, uint256 shares)',
  'event Withdraw(address indexed user, address indexed asset, uint256 amount, uint256 shares)',
  'event Borrow(address indexed user, address indexed asset, uint256 amount, uint256 shares)',
  'event Repay(address indexed user, address indexed payer, address indexed asset, uint256 amount, uint256 shares)',
  'event Liquidation(address indexed liquidator, address indexed borrower, address indexed debtAsset, address collateralAsset, uint256 repaid, uint256 seized, bool paidUnderlying)',
])

export const MAX_UINT = 2n ** 256n - 1n

export interface Reserve {
  totalSupplied: bigint
  totalBorrowed: bigint
  availableLiquidity: bigint
  utilization: bigint
  supplyRateApr: bigint
  borrowRateApr: bigint
  supplyCap: bigint
  borrowCap: bigint
  ltv: bigint
  liquidationThreshold: bigint
  liquidationBonus: bigint
  price8: bigint
}

export function reserveFromTuple(t: readonly bigint[]): Reserve {
  return {
    totalSupplied: t[0],
    totalBorrowed: t[1],
    availableLiquidity: t[2],
    utilization: t[3],
    supplyRateApr: t[4],
    borrowRateApr: t[5],
    supplyCap: t[6],
    borrowCap: t[7],
    ltv: t[8],
    liquidationThreshold: t[9],
    liquidationBonus: t[10],
    price8: t[11],
  }
}

function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** Token amount with thousands separators and a fixed number of fraction digits. */
export function fmtToken(raw: bigint, decimals: number, digits = 2): string {
  const fixed = formatUnitsFixed(raw, decimals, digits)
  const [whole, frac] = fixed.split('.')
  return frac === undefined ? group(whole) : `${group(whole)}.${frac}`
}

/** How many fraction digits to show per asset: stablecoins read best at 2, a Bitcoin token needs 6. */
export const DISPLAY_DIGITS: Record<AssetSymbol, number> = { USDC: 2, EURC: 2, cirBTC: 6 }

/** Token amount for display. A tiny nonzero amount reads "<0.000001" instead of a misleading zero. */
export function fmtAsset(raw: bigint, symbol: AssetSymbol, digits: number = DISPLAY_DIGITS[symbol]): string {
  const text = fmtToken(raw, ASSETS[symbol].decimals, digits)
  if (raw > 0n && /^[0.,]+$/.test(text)) return `<${(10 ** -digits).toFixed(digits)}`
  return text
}

/** USD value carried with 8 decimals, as the pool reports it. */
export function fmtUsd8(raw: bigint, digits = 2): string {
  return `$${fmtToken(raw, 8, digits)}`
}

/** A 1e18-scaled annual rate, shown as a percentage. */
export function fmtApr(wad: bigint): string {
  return `${(Number(wad / 10n ** 12n) / 10_000).toFixed(2)}%`
}

export function fmtBps(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(0)}%`
}

export function fmtHealth(wad: bigint): string {
  if (wad >= MAX_UINT / 2n) return 'No debt'
  return (Number(wad / 10n ** 12n) / 1_000_000).toFixed(2)
}

export function healthTone(wad: bigint): 'none' | 'safe' | 'warn' | 'danger' {
  if (wad >= MAX_UINT / 2n) return 'none'
  const hf = Number(wad / 10n ** 12n) / 1_000_000
  if (hf >= 1.5) return 'safe'
  if (hf >= 1.1) return 'warn'
  return 'danger'
}

/** Parses user input into base units; returns undefined for empty or invalid text. */
export function parseInput(value: string, decimals: number): bigint | undefined {
  if (value.trim() === '' || value === '.') return undefined
  try {
    const raw = parseUnitsExact(value, decimals)
    return raw > 0n ? raw : undefined
  } catch {
    return undefined
  }
}

/** Value of a token amount in 8-decimal USD, given the pool's Chainlink prices. */
export function valueUsd8(raw: bigint, symbol: AssetSymbol, prices: Prices): bigint {
  return (raw * prices[symbol]) / 10n ** BigInt(ASSETS[symbol].decimals)
}

export function parseError(error: unknown): string {
  const e = error as { code?: number; shortMessage?: string; message?: string; cause?: { shortMessage?: string } }
  const text = `${e?.shortMessage ?? ''} ${e?.cause?.shortMessage ?? ''} ${e?.message ?? ''}`.toLowerCase()
  if (e?.code === 4001 || text.includes('user rejected') || text.includes('user denied')) return 'cancelled'
  if (text.includes('stale')) return 'A Chainlink price is out of date, so this action is paused.'
  if (text.includes('insufficientborrowcapacity')) return 'That is more than your collateral allows.'
  if (text.includes('insufficientliquidity')) return 'Not enough liquidity in the market right now.'
  if (text.includes('supplycapexceeded')) return 'This market has reached its supply cap.'
  if (text.includes('borrowcapexceeded')) return 'This market has reached its borrow cap.'
  if (text.includes('insufficient funds') || text.includes('exceeds balance') || text.includes('transfer amount exceeds'))
    return 'Insufficient balance for this amount.'
  if (text.includes('enforcedpause')) return 'New borrowing is paused.'
  if (text.includes('reverted')) return 'The transaction was rejected onchain. Check the amount and try again.'
  if (text.includes('network') || text.includes('timeout')) return 'Network issue. Please try again.'
  return 'Something went wrong. Please try again.'
}
