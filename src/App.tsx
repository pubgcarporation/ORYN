import { Suspense, lazy, useEffect } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { usePool, useUser } from '@/hooks/usePool'
import { TABS, tabFromPath, type Tab } from '@/lib/nav'
import { Sidebar } from '@/components/Sidebar'
import { Link, navigate, usePath } from '@/lib/router'
import { ConnectButton } from '@/auth/ConnectButton'
import { Logo } from '@/components/Logo'
import { MarketsPage } from '@/components/MarketsPage'
import { PositionsPage } from '@/components/PositionsPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { NotFound } from '@/components/NotFound'
import { Skeleton } from '@/components/ui'
import { OracleBanner } from '@/components/OracleBanner'
import { Landing } from '@/landing/Landing'

// Swap and Bridge pull in the Circle App Kit, so they load only when someone opens them.
const SwapPage = lazy(() => import('@/components/SwapPage').then((m) => ({ default: m.SwapPage })))
const BridgePage = lazy(() => import('@/components/BridgePage').then((m) => ({ default: m.BridgePage })))

export default function App() {
  const path = usePath()
  if (path === '/') return <Landing />
  if (path === '/app' || path === '/app/' || tabFromPath(path)) return <AppShell path={path} />
  return <NotFound />
}

function AppShell({ path }: { path: string }) {
  const tab = tabFromPath(path)
  const pool = usePool()
  const user = useUser()

  useEffect(() => {
    if (!tab) navigate('/app/earn', { replace: true })
  }, [tab])

  const active: Tab = tab ?? 'earn'

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-dvh pb-28 md:pb-10 md:pl-60">
        <Sidebar active={active} />
        <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-[480px]" aria-hidden="true" />
        <header className="safe-top sticky top-0 z-30 border-b" style={{ borderColor: 'var(--border)', background: 'rgba(13,27,47,0.8)', backdropFilter: 'blur(16px)' }}>
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:py-3">
            <div className="flex items-center gap-3">
              <Link to="/" aria-label="ORYN home" className="rounded-lg md:hidden">
                <Logo />
              </Link>
              <span className="label hidden rounded-full border px-2.5 py-1 sm:inline md:hidden" style={{ borderColor: 'var(--border)' }}>
                Arc Testnet
              </span>
            </div>
            <ConnectButton />
          </div>
        </header>

        <main className="relative mx-auto max-w-5xl px-4 pt-8">
          <OracleBanner pool={pool} />
          <AnimatePresence mode="wait">
            <motion.div key={active} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <ErrorBoundary resetKey={active}>
                <Suspense fallback={<Skeleton className="mx-auto h-96 w-full max-w-md" />}>
                  {active === 'earn' && <MarketsPage mode="lend" pool={pool} user={user} />}
                  {active === 'borrow' && <MarketsPage mode="borrow" pool={pool} user={user} />}
                  {active === 'swap' && <SwapPage />}
                  {active === 'bridge' && <BridgePage />}
                  {active === 'positions' && <PositionsPage pool={pool} user={user} />}
                </Suspense>
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </main>

        <nav
          className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t md:hidden"
          style={{ borderColor: 'var(--border)', background: 'rgba(13,27,47,0.94)', backdropFilter: 'blur(16px)' }}
          aria-label="Primary mobile"
        >
          <div className="mx-auto grid max-w-md grid-cols-5">
            {TABS.map(({ id, label, icon: Icon }) => (
              <Link
                key={id}
                to={`/app/${id}`}
                aria-current={active === id ? 'page' : undefined}
                className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold"
                style={{ color: active === id ? 'var(--accent)' : 'var(--subtle)' }}
              >
                <Icon className="size-5" />
                {label}
              </Link>
            ))}
          </div>
        </nav>
      </div>
    </MotionConfig>
  )
}
