import { ArrowLeftRight, Landmark, Repeat, Wallet } from 'lucide-react'

export type Tab = 'markets' | 'swap' | 'bridge' | 'positions'

export const TABS: { id: Tab; label: string; hint: string; icon: typeof Landmark }[] = [
  { id: 'markets', label: 'Markets', hint: 'Supply, borrow and repay', icon: Landmark },
  { id: 'swap', label: 'Swap', hint: 'Trade USDC and EURC', icon: Repeat },
  { id: 'bridge', label: 'Bridge', hint: 'Move USDC between networks', icon: ArrowLeftRight },
  { id: 'positions', label: 'Positions', hint: 'Balances and health', icon: Wallet },
]

/** Earn and Borrow used to be two pages. Their old links open Markets. */
const LEGACY: Record<string, Tab> = { earn: 'markets', borrow: 'markets' }

export function tabFromPath(path: string): Tab | undefined {
  const segment = path.split('/')[2]
  return TABS.find((t) => t.id === segment)?.id ?? LEGACY[segment]
}

/** True when the path is an old Earn or Borrow link that should be rewritten to Markets. */
export function isLegacyPath(path: string): boolean {
  return path.split('/')[2] in LEGACY
}
