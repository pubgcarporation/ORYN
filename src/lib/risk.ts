export interface LiquidationInputs {
  suppliedUsdc: number
  suppliedEurc: number
  debtUsdc: number
  debtEurc: number
  /** Liquidation thresholds as fractions, for example 0.85. */
  thresholdUsdc: number
  thresholdEurc: number
  /** Current EURC price in USD. */
  price: number
}

export interface LiquidationPrice {
  price: number
  /** Which way EURC has to move for the position to become liquidatable. */
  direction: 'below' | 'above'
  /** Signed distance from the current price, as a fraction. */
  distance: number
}

/**
 * The EURC/USD price at which this wallet's health factor reaches 1.
 * Health factor = (supplied USDC x threshold + supplied EURC x threshold x p) / (USDC debt + EURC debt x p),
 * so it reaches 1 where the two sides are equal. Returns null when no positive price does that,
 * meaning EURC price moves alone cannot liquidate the position (or it is already liquidatable).
 */
export function liquidationPrice(i: LiquidationInputs): LiquidationPrice | null {
  if (i.debtUsdc <= 0 && i.debtEurc <= 0) return null
  const a = i.suppliedUsdc * i.thresholdUsdc
  const b = i.suppliedEurc * i.thresholdEurc
  const slope = b - i.debtEurc
  if (Math.abs(slope) < 1e-9) return null
  const p = (i.debtUsdc - a) / slope
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
