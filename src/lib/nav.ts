import { ArrowLeftRight, Landmark, PiggyBank, Repeat, Wallet } from 'lucide-react'

export type Tab = 'earn' | 'borrow' | 'swap' | 'bridge' | 'positions'

export const TABS: { id: Tab; label: string; hint: string; icon: typeof Landmark }[] = [
  { id: 'earn', label: 'Earn', hint: 'Supply and earn yield', icon: PiggyBank },
  { id: 'borrow', label: 'Borrow', hint: 'Borrow against collateral', icon: Landmark },
  { id: 'swap', label: 'Swap', hint: 'Trade USDC and EURC', icon: Repeat },
  { id: 'bridge', label: 'Bridge', hint: 'Move funds onto Arc', icon: ArrowLeftRight },
  { id: 'positions', label: 'Positions', hint: 'Balances and health', icon: Wallet },
]

export function tabFromPath(path: string): Tab | undefined {
  const segment = path.split('/')[2]
  return TABS.find((t) => t.id === segment)?.id
}
