import { motion } from 'framer-motion'
import { ExternalLink } from 'lucide-react'
import { Link } from '@/lib/router'
import { TABS, type Tab } from '@/lib/nav'
import { POOL_ADDRESS } from '@/lib/pool'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { Logo } from '@/components/Logo'

const ARC_TESTNET_ID = 5042002

/** Desktop side panel. Phones keep the bottom tab bar. */
export function Sidebar({ active }: { active: Tab }) {
  return (
    <aside
      className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r px-3 pb-4 pt-5 md:flex"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)', backdropFilter: 'blur(16px)' }}
      aria-label="Sidebar"
    >
      <Link to="/" aria-label="ORYN home" className="mb-8 rounded-lg px-3">
        <Logo />
      </Link>

      <p className="label mb-2 px-3">Menu</p>
      <nav className="flex flex-col gap-1" aria-label="Primary">
        {TABS.map(({ id, label, hint, icon: Icon }) => {
          const isActive = active === id
          return (
            <Link
              key={id}
              to={`/app/${id}`}
              aria-current={isActive ? 'page' : undefined}
              className="relative flex min-h-12 items-center gap-3 rounded-xl px-3 transition-colors hover:bg-white/5"
              style={{ color: isActive ? 'var(--ink)' : 'var(--muted)' }}
            >
              {isActive && (
                <motion.span
                  layoutId="sidebar-pill"
                  className="absolute inset-0 rounded-xl"
                  style={{ background: 'var(--surface-strong)', border: '1px solid var(--border)' }}
                  transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              <Icon className="relative size-5 shrink-0" style={{ color: isActive ? 'var(--accent)' : 'var(--subtle)' }} />
              <span className="relative min-w-0">
                <span className="block text-sm font-semibold leading-tight">{label}</span>
                <span className="block truncate text-[11px] leading-tight" style={{ color: 'var(--subtle)' }}>
                  {hint}
                </span>
              </span>
            </Link>
          )
        })}
      </nav>

      <div className="mt-auto space-y-2 px-1">
        <div className="inner flex items-center gap-2 px-3 py-2.5">
          <span className="size-2 rounded-full" style={{ background: 'var(--success)' }} aria-hidden="true" />
          <span className="text-xs font-semibold">Arc Testnet</span>
        </div>
        <a
          href={buildAddressExplorerUrl(ARC_TESTNET_ID, POOL_ADDRESS)}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-h-10 items-center justify-between rounded-xl px-3 text-xs font-semibold transition-colors hover:bg-white/5"
          style={{ color: 'var(--muted)' }}
        >
          View market contract
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      </div>
    </aside>
  )
}
