import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { BarChart3, Check, ChevronRight, Copy, Droplets, ExternalLink, LogOut, Trophy, X } from 'lucide-react'
import { NetworkArc } from '@web3icons/react'
import { toast } from 'sonner'
import { erc20Abi, type Address } from 'viem'
import { useReadContracts } from 'wagmi'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, fmtAsset, fmtHealth, fmtUsd8, healthTone, valueUsd8 } from '@/lib/pool'
import { usePool, useUser } from '@/hooks/usePool'
import { Link } from '@/lib/router'
import { useAuth } from '@/auth/useAuth'
import { TokenBadge } from '@/components/ui'

const FAUCET_URL = 'https://faucet.circle.com'
const TONE = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const

interface Props {
  address: Address
  open: boolean
  onClose: () => void
}

/** Account side panel: who is signed in, wallet balances, position summary and account actions. */
export function ProfilePanel({ address, open, onClose }: Props) {
  const auth = useAuth()
  const pool = usePool()
  const user = useUser()
  const [copied, setCopied] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const { data: balances } = useReadContracts({
    contracts: ASSET_LIST.map((a) => ({ address: a.address, abi: erc20Abi, functionName: 'balanceOf', args: [address], chainId: ARC_ID })),
    query: { enabled: open, refetchInterval: 10_000 },
  })

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
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
  const walletUsd = ASSET_LIST.reduce((sum, a, i) => sum + valueUsd8(balanceOf(i), a.symbol, pool.prices), 0n)
  const tone = healthTone(user.healthWad)
  const hasPosition = user.collateralUsd8 > 0n || user.debtUsd8 > 0n

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[60]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <button className="absolute inset-0 bg-black/55 backdrop-blur-sm" aria-label="Close account panel" tabIndex={-1} onClick={onClose} />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label="Account"
            className="safe-top safe-bottom absolute inset-y-0 right-0 flex w-full max-w-sm flex-col overflow-y-auto border-l"
            style={{ background: 'var(--panel-solid)', borderColor: 'var(--border)' }}
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', stiffness: 380, damping: 40 }}
          >
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <h2 className="display text-lg font-semibold">Account</h2>
              <button ref={closeRef} className="btn-ghost !min-h-11 !min-w-11 !px-0" onClick={onClose} aria-label="Close">
                <X className="size-4" />
              </button>
            </div>

            <div className="px-5 pb-5">
              <div className="flex items-center gap-3">
                <span className="flex size-12 shrink-0 items-center justify-center rounded-full text-sm font-bold" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
                  {initials}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold">{auth.identity ?? 'Connected wallet'}</div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
                    {auth.viaGoogle && (
                      <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: 'var(--surface-strong)', color: 'var(--muted)' }}>
                        Google
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <NetworkArc variant="branded" size={12} /> Arc Testnet
                    </span>
                  </div>
                </div>
              </div>

              <button onClick={() => void copy()} className="inner mt-4 flex min-h-12 w-full items-center justify-between gap-2 px-3 text-left" aria-label="Copy address">
                <span>
                  <span className="label block">Wallet address</span>
                  <span className="num text-sm font-medium">{short}</span>
                </span>
                {copied ? <Check className="size-4 shrink-0" style={{ color: 'var(--success)' }} /> : <Copy className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />}
              </button>
            </div>

            <section className="border-t px-5 py-5" style={{ borderColor: 'var(--border)' }} aria-label="Wallet balances">
              <div className="flex items-baseline justify-between">
                <h3 className="label">Wallet balance</h3>
                <span className="display num text-lg font-semibold">{pool.loaded ? fmtUsd8(walletUsd) : '...'}</span>
              </div>
              <ul className="mt-3 space-y-2">
                {ASSET_LIST.map((a, i) => (
                  <li key={a.symbol} className="inner flex min-h-14 items-center justify-between gap-3 px-3">
                    <span className="flex items-center gap-2.5">
                      <TokenBadge symbol={a.symbol} size={28} />
                      <span>
                        <span className="block text-sm font-semibold">{a.symbol}</span>
                        <span className="block text-xs" style={{ color: 'var(--subtle)' }}>
                          {a.name}
                        </span>
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="num block text-sm font-semibold">{fmtAsset(balanceOf(i), a.symbol)}</span>
                      <span className="num block text-xs" style={{ color: 'var(--subtle)' }}>
                        {pool.loaded ? fmtUsd8(valueUsd8(balanceOf(i), a.symbol, pool.prices)) : ''}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section className="border-t px-5 py-5" style={{ borderColor: 'var(--border)' }} aria-label="Lending position">
              <h3 className="label">Lending position</h3>
              {hasPosition ? (
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Mini label="Supplied" value={fmtUsd8(user.collateralUsd8)} />
                  <Mini label="Borrowed" value={fmtUsd8(user.debtUsd8)} />
                  <Mini label="Health" value={fmtHealth(user.healthWad)} color={TONE[tone]} />
                </div>
              ) : (
                <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
                  Nothing supplied or borrowed yet.
                </p>
              )}
              <Link to={hasPosition ? '/app/positions' : '/app/markets'} onClick={onClose} className="btn-ghost mt-3 w-full !min-h-11">
                {hasPosition ? 'View positions' : 'Open markets'}
              </Link>
            </section>

            <section className="border-t px-5 py-5" style={{ borderColor: 'var(--border)' }} aria-label="Explore">
              <div className="label mb-3">Explore ORYN</div>
              <div className="space-y-2">
                <ExploreLink to="/app/leaderboard" icon={<Trophy className="size-4" />} title="Leaderboard" sub="Top suppliers, borrowers and liquidators" onClose={onClose} />
                <ExploreLink to="/app/analytics" icon={<BarChart3 className="size-4" />} title="Analytics" sub="Market totals, volume and loan risk" onClose={onClose} />
              </div>
            </section>

            <div className="mt-auto space-y-1 border-t px-3 py-3" style={{ borderColor: 'var(--border)' }}>
              <PanelLink href={FAUCET_URL} icon={<Droplets className="size-4" />}>
                Get test USDC
              </PanelLink>
              <PanelLink href={buildAddressExplorerUrl(ARC_ID, address)} icon={<ExternalLink className="size-4" />}>
                View on explorer
              </PanelLink>
              <button
                className="flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5"
                style={{ color: 'var(--danger)' }}
                onClick={() => {
                  onClose()
                  auth.logout()
                }}
              >
                <LogOut className="size-4" /> Sign out
              </button>
            </div>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  )
}

function Mini({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="inner p-2.5">
      <div className="label !text-[10px]">{label}</div>
      <div className="display num mt-1 truncate text-sm font-semibold" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  )
}

function PanelLink({ href, icon, children }: { href: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex min-h-11 items-center gap-2.5 rounded-xl px-3 text-sm font-semibold transition-colors hover:bg-white/5">
      {icon}
      {children}
    </a>
  )
}

function ExploreLink({ to, icon, title, sub, onClose }: { to: string; icon: React.ReactNode; title: string; sub: string; onClose: () => void }) {
  return (
    <Link to={to} onClick={onClose} className="inner flex min-h-14 items-center gap-3 px-3.5 py-2.5 transition-colors hover:bg-white/5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'var(--surface-strong)', color: 'var(--accent)' }}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        <span className="block truncate text-xs" style={{ color: 'var(--subtle)' }}>
          {sub}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
    </Link>
  )
}
