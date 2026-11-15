import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Check, Copy, Droplets, ExternalLink, LogOut, Trophy, Wallet, X } from 'lucide-react'
import { toast } from 'sonner'
import { erc20Abi, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, fmtAsset } from '@/lib/pool'
import { Link } from '@/lib/router'
import { useAuth } from '@/auth/useAuth'
import { TokenBadge } from '@/components/ui'

const FAUCET_URL = 'https://faucet.circle.com'

interface Props {
  address: Address
  open: boolean
  onClose: () => void
}

/** Compact account panel docked under the header, top right. */
export function ProfilePanel({ address, open, onClose }: Props) {
  const auth = useAuth()
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const { data: balances } = useReadContracts({
    contracts: ASSET_LIST.map((a) => ({ address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: ARC_ID })),
    query: { enabled: open, refetchInterval: 10_000 },
  })

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      toast.success('Address copied')
      setTimeout(() => setCopied(false), 1600)
    } catch {
      toast.error('Could not copy. Select the address and copy it manually.')
    }
  }

  const short = `${address.slice(0, 6)}...${address.slice(-4)}`
  const initials = (auth.identity ?? address.slice(2)).slice(0, 2).toUpperCase()
  const balanceOf = (i: number): bigint => {
    const v = balances?.[i]?.result
    return typeof v === 'bigint' ? v : 0n
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]">
          <button className="absolute inset-0 cursor-default" aria-label="Close" tabIndex={-1} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-label="Account"
            className="absolute right-3 top-[4.25rem] flex max-h-[calc(100dvh-5.5rem)] w-72 max-w-[calc(100vw-1.5rem)] origin-top-right flex-col overflow-y-auto rounded-2xl border p-2 shadow-2xl"
            style={{ background: 'var(--panel-solid)', borderColor: 'var(--border)', boxShadow: '0 24px 70px -20px rgba(0,0,0,0.8)' }}
            initial={{ opacity: 0, scale: 0.96, y: -6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -6 }}
            transition={{ duration: 0.14 }}
          >
            <div className="flex items-center gap-2.5 p-2">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                {initials}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{auth.identity ?? 'Wallet'}</div>
                <button onClick={() => void copy()} className="num inline-flex items-center gap-1 text-xs" style={{ color: 'var(--subtle)' }} aria-label="Copy address">
                  {short}
                  {copied ? <Check className="size-3" style={{ color: 'var(--success)' }} /> : <Copy className="size-3" />}
                </button>
              </div>
              <button ref={closeRef} className="flex size-8 shrink-0 items-center justify-center rounded-lg hover:bg-white/5" onClick={onClose} aria-label="Close">
                <X className="size-4" />
              </button>
            </div>

            <ul className="mx-1 my-1 space-y-0.5 border-y py-1.5" style={{ borderColor: 'var(--border)' }}>
              {ASSET_LIST.map((a, i) => (
                <li key={a.symbol} className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm">
                  <span className="flex items-center gap-2">
                    <TokenBadge symbol={a.symbol} size={20} />
                    {a.symbol}
                  </span>
                  <span className="num font-semibold">{fmtAsset(balanceOf(i), a.symbol)}</span>
                </li>
              ))}
            </ul>

            <nav className="space-y-0.5" aria-label="Account menu">
              <MenuLink to="/app/positions" icon={<Wallet className="size-4" />} onClose={onClose}>
                Positions
              </MenuLink>
              <MenuLink to="/app/leaderboard" icon={<Trophy className="size-4" />} onClose={onClose}>
                Leaderboard
              </MenuLink>
              <MenuLink to="/app/analytics" icon={<BarChart3 className="size-4" />} onClose={onClose}>
                Analytics
              </MenuLink>
              <PanelLink href={FAUCET_URL} icon={<Droplets className="size-4" />}>
                Get test USDC
              </PanelLink>
              <PanelLink href={buildAddressExplorerUrl(ARC_ID, address)} icon={<ExternalLink className="size-4" />}>
                Explorer
              </PanelLink>
              <button
                className="flex min-h-10 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  onClose()
                  auth.logout()
                }}
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </nav>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function PanelLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5">
      {icon}
      {children}
    </a>
  )
}

function MenuLink({ to, icon, onClose, children }: { to: string; icon: React.ReactNode; onClose: () => void; children: React.ReactNode }) {
  return (
    <Link to={to} onClick={onClose} className="flex min-h-10 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5">
      {icon}
      {children}
    </Link>
  )
}
