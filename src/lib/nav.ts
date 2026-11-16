import { ArrowLeftRight, Landmark, Repeat, Sparkles, Wallet } from 'lucide-react'

export type MainTab = 'markets' | 'swap' | 'bridge' | 'assistant' | 'positions'
/** Pages opened from the account panel, not from the main navigation. */
export type ExtraTab = 'leaderboard' | 'analytics'
export type Tab = MainTab | ExtraTab

const EXTRA: ExtraTab[] = ['leaderboard', 'analytics']

export const TABS: { id: MainTab; label: string; hint: string; icon: typeof Landmark }[] = [
  { id: 'markets', label: 'Markets', hint: 'Supply, borrow and repay', icon: Landmark },
  { id: 'swap', label: 'Swap', hint: 'Trade USDC and EURC', icon: Repeat },
  { id: 'bridge', label: 'Bridge', hint: 'Move USDC between networks', icon: ArrowLeftRight },
  { id: 'assistant', label: 'Assistant', hint: 'Send, swap, bridge by chat', icon: Sparkles },
  { id: 'positions', label: 'Positions', hint: 'Balances and health', icon: Wallet },
]

/** Earn and Borrow used to be two pages. Their old links open Markets. */
const LEGACY: Record<string, Tab> = { earn: 'markets', borrow: 'markets' }

export function tabFromPath(path: string): Tab | undefined {
  const segment = path.split('/')[2]
  return TABS.find((t) => t.id === segment)?.id ?? EXTRA.find((t) => t === segment) ?? LEGACY[segment]
}

/** True when the path is an old Earn or Borrow link that should be rewritten to Markets. */
export function isLegacyPath(path: string): boolean {
  return path.split('/')[2] in LEGACY
}
