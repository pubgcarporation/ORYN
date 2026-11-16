import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Check, Copy, Droplets, ExternalLink, LogOut, Trophy, X, type LucideIcon } from 'lucide-react'
import { toast } from 'sonner'
import { erc20Abi, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, fmtAsset } from '@/lib/pool'
import { TABS, tabFromPath } from '@/lib/nav'
import { Link, usePath } from '@/lib/router'
import { useAuth } from '@/auth/useAuth'
import { LogoMark } from '@/components/Logo'
import { TokenBadge } from '@/components/ui'

const FAUCET_URL = 'https://faucet.circle.com'

interface Props {
  address: Address
  open: boolean
  onClose: () => void
}

/** Full-height account drawer that slides in from the right, built from cards. */
export function ProfilePanel({ address, open, onClose }: Props) {
  const auth = useAuth()
  const path = usePath()
  const active = tabFromPath(path)
  const [copied, setCopied] = useState(false)
  const asideRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  const { data: balances } = useReadContracts({
    contracts: ASSET_LIST.map((a) => ({ address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: ARC_ID })),
    query: { enabled: open, refetchInterval: 10_000 },
  })

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return onClose()
      if (e.key !== 'Tab' || !asideRef.current) return
      const items = asideRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previousOverflow
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
          <motion.button
            className="absolute inset-0 cursor-default bg-black/60 backdrop-blur-[2px]"
            aria-label="Close account panel"
            tabIndex={-1}
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          />
          <motion.aside
            ref={asideRef}
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            className="absolute inset-y-0 right-0 flex w-[min(21rem,90vw)] flex-col rounded-l-3xl border-l"
            style={{ background: 'var(--panel-solid)', borderColor: 'var(--border)', boxShadow: '-24px 0 70px -24px rgba(0,0,0,0.85)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', ease: [0.22, 1, 0.36, 1], duration: 0.28 }}
          >
            <header className="flex shrink-0 items-center gap-3 px-4 pb-3 pt-[max(1rem,env(safe-area-inset-top))]">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border" style={{ borderColor: 'var(--border)', background: 'var(--surface-strong)' }}>
                <LogoMark size={22} />
              </span>
              <div className="min-w-0 flex-1 leading-tight">
                <div className="display text-lg font-semibold tracking-[0.04em]">ORYN</div>
                <div className="text-xs font-medium" style={{ color: 'var(--accent)' }}>
                  Arc Testnet
                </div>
              </div>
              <button ref={closeRef} className="flex size-10 shrink-0 items-center justify-center rounded-xl hover:bg-white/5" onClick={onClose} aria-label="Close">
                <X className="size-5" />
              </button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <Card>
                <div className="flex items-center gap-3 p-1">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-full text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                    {initials}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold">{auth.identity ?? 'Wallet'}</div>
                    <button onClick={() => void copy()} className="num inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--subtle)' }} aria-label="Copy address">
                      {short}
                      {copied ? <Check className="size-3" style={{ color: 'var(--success)' }} /> : <Copy className="size-3" />}
                    </button>
                  </div>
                  <a
                    href={buildAddressExplorerUrl(ARC_ID, address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex size-9 shrink-0 items-center justify-center rounded-xl hover:bg-white/5"
                    style={{ color: 'var(--muted)' }}
                    aria-label="View on explorer"
                  >
                    <ExternalLink className="size-4" />
                  </a>
                </div>
              </Card>

              <Card label="Balances">
                <ul>
                  {ASSET_LIST.map((a, i) => (
                    <li key={a.symbol} className="flex min-h-11 items-center justify-between gap-3 px-2 text-sm">
                      <span className="flex items-center gap-2.5">
                        <TokenBadge symbol={a.symbol} size={22} />
                        {a.symbol}
                      </span>
                      <span className="num font-semibold">{fmtAsset(balanceOf(i), a.symbol)}</span>
                    </li>
                  ))}
                </ul>
              </Card>

              <Card label="Menu">
                <nav aria-label="Pages" className="space-y-0.5">
                  {TABS.map(({ id, label, icon }) => (
                    <DrawerLink key={id} to={`/app/${id}`} icon={icon} active={active === id} onClick={onClose}>
                      {label}
                    </DrawerLink>
                  ))}
                </nav>
              </Card>

              <Card label="Explore">
                <div className="space-y-0.5">
                  <DrawerLink to="/app/leaderboard" icon={Trophy} active={active === 'leaderboard'} onClick={onClose}>
                    Leaderboard
                  </DrawerLink>
                  <DrawerLink to="/app/analytics" icon={BarChart3} active={active === 'analytics'} onClick={onClose}>
                    Analytics
                  </DrawerLink>
                  <DrawerAnchor href={FAUCET_URL} icon={Droplets}>
                    Get test USDC
                  </DrawerAnchor>
                </div>
              </Card>

              <button
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl border text-sm font-semibold transition-colors hover:bg-white/5"
                style={{ color: 'var(--danger)', borderColor: 'rgba(255,122,138,0.3)', background: 'rgba(255,122,138,0.06)' }}
                onClick={() => {
                  onClose()
                  auth.logout()
                }}
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Card({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border p-2" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
      {label && (
        <div className="label px-2 pb-1 pt-1.5" style={{ color: 'var(--subtle)' }}>
          {label}
        </div>
      )}
      {children}
    </section>
  )
}

function IconTile({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <span
      className="flex size-9 shrink-0 items-center justify-center rounded-xl"
      style={active ? { background: 'var(--accent)', color: 'var(--accent-ink)' } : { color: 'inherit' }}
    >
      {children}
    </span>
  )
}

const rowClass = 'flex min-h-12 items-center gap-3 rounded-xl px-2 text-sm font-semibold transition-colors'

function DrawerLink({ to, icon: Icon, active, onClick, children }: { to: string; icon: LucideIcon; active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={`${rowClass} ${active ? '' : 'hover:bg-white/5'}`}
      style={active ? { background: 'rgba(185,166,255,0.14)', color: 'var(--ink)' } : { color: 'var(--muted)' }}
    >
      <IconTile active={active}>
        <Icon className="size-[18px]" />
      </IconTile>
      {children}
    </Link>
  )
}

function DrawerAnchor({ href, icon: Icon, children }: { href: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`${rowClass} hover:bg-white/5`} style={{ color: 'var(--muted)' }}>
      <IconTile>
        <Icon className="size-[18px]" />
      </IconTile>
      {children}
    </a>
  )
}
