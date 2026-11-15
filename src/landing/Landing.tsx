import { MotionConfig } from 'framer-motion'
import { usePool } from '@/hooks/usePool'
import { ConnectButton } from '@/auth/ConnectButton'
import { Link } from '@/lib/router'
import { Logo } from '@/components/Logo'
import { LandingHero } from '@/landing/LandingHero'
import { Features, FinalCta, Footer, HowItWorks, Markets, StatsStrip, Transparency } from '@/landing/LandingSections'

const NAV = [
  { id: 'markets', label: 'Markets' },
  { id: 'how', label: 'How it works' },
  { id: 'security', label: 'Transparency' },
]

export function Landing() {
  const pool = usePool()
  return (
    <MotionConfig reducedMotion="user">
      <div className="min-h-dvh">
        <header className="safe-top sticky top-0 z-40 border-b" style={{ borderColor: 'var(--border)', background: 'var(--panel)', backdropFilter: 'blur(16px)' }}>
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-2.5 sm:py-3">
            <Link to="/" aria-label="ORYN home" className="rounded-lg">
              <Logo />
            </Link>
            <nav className="hidden items-center gap-1 md:flex" aria-label="Sections">
              {NAV.map((n) => (
                <button
                  key={n.id}
                  className="min-h-11 rounded-xl px-4 text-sm font-semibold transition-colors hover:bg-white/5"
                  style={{ color: 'var(--muted)' }}
                  onClick={() => document.getElementById(n.id)?.scrollIntoView({ behavior: 'smooth' })}
                >
                  {n.label}
                </button>
              ))}
            </nav>
            <div className="flex items-center gap-2">
              <Link to="/app/markets" className="btn-ghost !min-h-11 hidden sm:inline-flex">
                Launch app
              </Link>
              <ConnectButton />
            </div>
          </div>
        </header>

        <main>
          <LandingHero pool={pool} />
          <StatsStrip pool={pool} />
          <Markets pool={pool} />
          <Features />
          <HowItWorks />
          <Transparency />
          <FinalCta />
        </main>
        <Footer />
      </div>
    </MotionConfig>
  )
}
