import { ASSET_LIST, ASSETS, MAX_UINT, type AssetSymbol } from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'

export type SimAction = 'supply' | 'borrow' | 'withdraw' | 'repay'

export interface SimInput {
  action: SimAction
  symbol: AssetSymbol
  /** Token amount in base units. Zero means "no action", which gives the current position. */
  amount: bigint
  /** Price change applied to one asset, in basis points (-2000 = down 20%). Zero means no change. */
  shock?: { symbol: AssetSymbol; bps: number }
}

export interface SimResult {
  collateralUsd8: bigint
  debtUsd8: bigint
  /** What the wallet may borrow in total (collateral x LTV). */
  limitUsd8: bigint
  /** Collateral value counted for liquidation (collateral x liquidation threshold). */
  liquidationUsd8: bigint
  /** 1e18-scaled health factor; MAX_UINT when there is no debt. */
  healthWad: bigint
  /** Debt as a share of collateral, in basis points. */
  ltvBps: number
  /** Debt as a share of the borrow limit, in basis points. */
  limitUsedBps: number
  /** Unused borrowing power in USD (8 decimals). */
  availableUsd8: bigint
  /** Per-asset amounts after the action, in base units. */
  supplied: Record<AssetSymbol, bigint>
  debt: Record<AssetSymbol, bigint>
  /** Per-asset price used, 8 decimals. */
  prices: Record<AssetSymbol, bigint>
}

const WAD = 10n ** 18n

/**
 * Re-values a wallet's position from its balances, the pool's risk settings and the current prices,
 * after an optional action and an optional price move. Nothing is sent onchain.
 * With amount 0 and no shock this equals the position the app already shows.
 */
export function simulate(pool: PoolState, user: UserState, input: SimInput): SimResult {
  const supplied = {} as Record<AssetSymbol, bigint>
  const debt = {} as Record<AssetSymbol, bigint>
  const prices = {} as Record<AssetSymbol, bigint>

  for (const a of ASSET_LIST) {
    let price = pool.prices[a.symbol]
    if (input.shock && input.shock.symbol === a.symbol) price = (price * BigInt(10_000 + input.shock.bps)) / 10_000n
    prices[a.symbol] = price
    supplied[a.symbol] = user.assets[a.symbol].supplied
    debt[a.symbol] = user.assets[a.symbol].debt
  }

  const s = input.symbol
  if (input.amount > 0n) {
    if (input.action === 'supply') supplied[s] += input.amount
    if (input.action === 'withdraw') supplied[s] = supplied[s] > input.amount ? supplied[s] - input.amount : 0n
    if (input.action === 'borrow') debt[s] += input.amount
    if (input.action === 'repay') debt[s] = debt[s] > input.amount ? debt[s] - input.amount : 0n
  }

  let collateral = 0n
  let debtUsd = 0n
  let limit = 0n
  let liquidation = 0n
  for (const a of ASSET_LIST) {
    const unit = 10n ** BigInt(ASSETS[a.symbol].decimals)
    const r = pool.reserves[a.symbol]
    const value = (supplied[a.symbol] * prices[a.symbol]) / unit
    collateral += value
    limit += (value * r.ltv) / 10_000n
    liquidation += (value * r.liquidationThreshold) / 10_000n
    debtUsd += (debt[a.symbol] * prices[a.symbol] + unit - 1n) / unit
  }

  return {
    collateralUsd8: collateral,
    debtUsd8: debtUsd,
    limitUsd8: limit,
    liquidationUsd8: liquidation,
    healthWad: debtUsd === 0n ? MAX_UINT : (liquidation * WAD) / debtUsd,
    ltvBps: collateral === 0n ? 0 : Number((debtUsd * 10_000n) / collateral),
    limitUsedBps: limit === 0n ? (debtUsd > 0n ? 10_000 : 0) : Number((debtUsd * 10_000n) / limit),
    availableUsd8: limit > debtUsd ? limit - debtUsd : 0n,
    supplied,
    debt,
    prices,
  }
}

/** The largest amount the wallet can use for an action: its balance, its borrow room, or what it can withdraw or owes. */
export function maxFor(user: UserState, action: SimAction, symbol: AssetSymbol): bigint {
  const p = user.assets[symbol]
  if (action === 'supply') return p.walletBalance
  if (action === 'borrow') return p.maxBorrow
  if (action === 'withdraw') return p.maxWithdraw
  return p.debt < p.walletBalance ? p.debt : p.walletBalance
}

/** Health factor as a plain number, or Infinity when there is no debt. */
export function healthNumber(wad: bigint): number {
  if (wad >= MAX_UINT / 2n) return Infinity
  return Number(wad / 10n ** 12n) / 1_000_000
}
