/**
 * USDC is also the gas token on Arc, so spending a whole USDC balance leaves nothing to pay network fees.
 * Max keeps this much back on Arc. It is a deliberately conservative buffer, not a measured fee.
 */
export const ARC_GAS_BUFFER = 250_000n // 0.25 USDC (6 decimals)

/** The most a wallet can spend of a token without stranding itself without gas. */
export function spendable(balance: bigint, paysGas: boolean): bigint {
  if (!paysGas) return balance
  return balance > ARC_GAS_BUFFER ? balance - ARC_GAS_BUFFER : 0n
}
