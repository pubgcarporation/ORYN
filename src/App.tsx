import { Suspense, lazy, useEffect } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'framer-motion'
import { usePool, useUser } from '@/hooks/usePool'
import { TABS, isLegacyPath, tabFromPath, type Tab } from '@/lib/nav'
import { Sidebar } from '@/components/Sidebar'
import { Link, navigate, usePath } from '@/lib/router'
import { Droplets } from 'lucide-react'
import { ConnectButton } from '@/auth/ConnectButton'
import { Logo } from '@/components/Logo'
import { MarketsPage } from '@/components/MarketsPage'
import { PositionsPage } from '@/components/PositionsPage'
import { LeaderboardPage } from '@/components/LeaderboardPage'
import { AnalyticsPage } from '@/components/AnalyticsPage'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { NotFound } from '@/components/NotFound'
import { OracleBanner } from '@/components/OracleBanner'
import { Landing } from '@/landing/Landing'

// Swap, Bridge and the Assistant pull in the Circle App Kit, so they are separate downloads.
// They start downloading as soon as the app opens, so no loading layer shows when you click them.
const loadSwap = () => import('@/components/SwapPage').then((m) => ({ default: m.SwapPage }))
const loadBridge = () => import('@/components/BridgePage').then((m) => ({ default: m.BridgePage }))
const loadAssistant = () => import('@/components/assistant/AssistantPage').then((m) => ({ default: m.AssistantPage }))
const SwapPage = lazy(loadSwap)
const BridgePage = lazy(loadBridge)
const AssistantPage = lazy(loadAssistant)

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
    if (!tab || isLegacyPath(path)) navigate('/app/markets', { replace: true })
  }, [tab, path])

  // Warm the heavy pages right away, so opening them shows the page itself and not a placeholder.
  useEffect(() => {
    void Promise.allSettled([loadSwap(), loadBridge(), loadAssistant()])
  }, [])

  const active: Tab = tab ?? 'markets'

  return (
    <MotionConfig reducedMotion="user">
      <div className="relative min-h-dvh pb-28 md:pb-10 md:pl-60">
        <Sidebar active={active} />
        <div className="bg-grid pointer-events-none absolute inset-x-0 top-0 h-[480px]" aria-hidden="true" />
        <header className="safe-top sticky top-0 z-30 border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel)', backdropFilter: 'blur(16px)' }}>
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-2.5 sm:py-3 md:max-w-[88rem] md:px-6">
            <div className="flex items-center gap-3">
              <Link to="/" aria-label="ORYN home" className="rounded-lg md:hidden">
                <Logo />
              </Link>
              <span className="label hidden rounded-full border px-2.5 py-1 sm:inline md:hidden" style={{ borderColor: 'var(--border)' }}>
                Arc Testnet
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a
                href="https://faucet.circle.com"
                target="_blank"
                rel="noopener noreferrer"
                className="btn-ghost !min-h-11 !min-w-11 !px-0"
                aria-label="Get test tokens from the Circle faucet"
                title="Circle faucet"
              >
                <Droplets className="size-5" aria-hidden="true" />
              </a>
              <ConnectButton />
            </div>
          </div>
        </header>

        <main className="relative mx-auto max-w-5xl px-4 pt-8 md:max-w-[88rem] md:px-6">
          <OracleBanner pool={pool} />
          <AnimatePresence mode="wait">
            <motion.div key={active} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.18 }}>
              <ErrorBoundary resetKey={active}>
                <Suspense fallback={null}>
                  {active === 'markets' && <MarketsPage pool={pool} user={user} />}
                  {active === 'swap' && <SwapPage />}
                  {active === 'bridge' && <BridgePage />}
                  {active === 'assistant' && <AssistantPage />}
                  {active === 'positions' && <PositionsPage pool={pool} user={user} />}
                  {active === 'leaderboard' && <LeaderboardPage pool={pool} />}
                  {active === 'analytics' && <AnalyticsPage pool={pool} />}
                </Suspense>
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </main>

        <nav
          className="safe-bottom fixed inset-x-0 bottom-0 z-40 border-t md:hidden"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)', backdropFilter: 'blur(16px)' }}
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
