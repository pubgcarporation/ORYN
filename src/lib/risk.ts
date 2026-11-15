export interface AssetRow {
  /** Supplied amount in USD at today's price. */
  suppliedUsd: number
  /** Borrowed amount in USD at today's price. */
  debtUsd: number
  /** Liquidation threshold as a fraction, for example 0.85. */
  threshold: number
}

export interface LiquidationInputs {
  rows: AssetRow[]
  /** Index in `rows` of the asset whose price moves. */
  target: number
  /** Current price of the target asset in USD. */
  price: number
}

export interface LiquidationPrice {
  price: number
  /** Which way the target asset has to move for the position to become liquidatable. */
  direction: 'below' | 'above'
  /** Signed distance from the current price, as a fraction. */
  distance: number
}

/**
 * The price of one asset at which this wallet's health factor reaches 1, holding the other prices fixed.
 * Health factor = sum(supplied x threshold) / sum(debt). Only the target asset's USD amounts scale with its
 * price p, so the two sides are equal at p = (other debt - other weighted supply) / (target weighted supply - target debt).
 * Returns null when no positive price does that, meaning this asset's price alone cannot liquidate
 * the position (or it is already liquidatable).
 */
export function liquidationPrice(i: LiquidationInputs): LiquidationPrice | null {
  if (i.price <= 0 || !i.rows.some((r) => r.debtUsd > 0)) return null
  let otherSupply = 0
  let otherDebt = 0
  i.rows.forEach((r, idx) => {
    if (idx === i.target) return
    otherSupply += r.suppliedUsd * r.threshold
    otherDebt += r.debtUsd
  })
  const t = i.rows[i.target]
  // Express the target's amounts in units of the asset, so they scale with the price p.
  const slope = (t.suppliedUsd * t.threshold - t.debtUsd) / i.price
  if (Math.abs(slope) < 1e-12) return null
  const p = (otherDebt - otherSupply) / slope
  if (!Number.isFinite(p) || p <= 0) return null
  return { price: p, direction: slope > 0 ? 'below' : 'above', distance: (p - i.price) / i.price }
}

export interface Projection {
  earnedPerYear: number
  interestPerYear: number
  net: number
}

/** Yearly earnings and interest in USD if today's rates and balances held for a year. */
export function project(rows: { supplyUsd: number; debtUsd: number; supplyApr: number; borrowApr: number }[]): Projection {
  const earnedPerYear = rows.reduce((s, r) => s + r.supplyUsd * r.supplyApr, 0)
  const interestPerYear = rows.reduce((s, r) => s + r.debtUsd * r.borrowApr, 0)
  return { earnedPerYear, interestPerYear, net: earnedPerYear - interestPerYear }
}
