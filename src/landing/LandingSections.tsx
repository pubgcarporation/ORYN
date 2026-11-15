import type { ReactNode } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeftRight, ArrowRight, ExternalLink, Landmark, LockKeyhole, PiggyBank, Repeat, Scale, UserRound, Wallet, Zap } from 'lucide-react'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, fmtApr, fmtBps, fmtUsd8, valueUsd8 } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'
import { Link } from '@/lib/router'
import { CountUp, Skeleton, TokenBadge } from '@/components/ui'
import { Logo } from '@/components/Logo'

const reveal = {
  initial: { opacity: 0, y: 18 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, margin: '-60px' },
  transition: { duration: 0.45 },
}

function Section({ id, eyebrow, title, children }: { id?: string; eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mx-auto max-w-6xl scroll-mt-20 px-4 py-12 sm:py-20">
      <motion.div {...reveal} className="mb-10 max-w-2xl">
        <div className="label" style={{ color: 'var(--accent)' }}>
          {eyebrow}
        </div>
        <h2 className="display mt-2 text-balance text-3xl font-semibold sm:text-4xl">{title}</h2>
      </motion.div>
      {children}
    </section>
  )
}

export function StatsStrip({ pool }: { pool: PoolState }) {
  const sum = (pick: 'totalSupplied' | 'totalBorrowed' | 'availableLiquidity') =>
    ASSET_LIST.reduce((acc, a) => acc + valueUsd8(pool.reserves[a.symbol][pick], a.symbol, pool.eurc8), 0n)
  const items = [
    { label: 'Total supplied', value: sum('totalSupplied') },
    { label: 'Total borrowed', value: sum('totalBorrowed') },
    { label: 'Available liquidity', value: sum('availableLiquidity') },
  ]
  return (
    <div className="mx-auto max-w-6xl px-4">
      <div className="card grid grid-cols-2 overflow-hidden sm:grid-cols-4">
        {items.map((s, i) => (
          <div key={s.label} className={`p-4 sm:p-5 ${i % 2 === 0 ? 'border-r' : ''} border-b sm:border-b-0 sm:border-r`} style={{ borderColor: 'var(--border)' }}>
            <div className="label">{s.label}</div>
            <div className="display mt-1.5 text-xl font-semibold sm:text-2xl">
              {pool.loaded ? <CountUp value={Number(s.value) / 1e8} format={(n) => `$${n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`} /> : <Skeleton className="h-8 w-28" />}
            </div>
          </div>
        ))}
        <div className="p-4 sm:p-5">
          <div className="label">Network fees</div>
          <div className="display mt-1.5 text-xl font-semibold sm:text-2xl">Paid in USDC</div>
        </div>
      </div>
    </div>
  )
}

export function Markets({ pool }: { pool: PoolState }) {
  return (
    <Section id="markets" eyebrow="Markets" title="Two stablecoin markets, one pool of collateral">
      <div className="grid gap-4 md:grid-cols-2">
        {ASSET_LIST.map((a, i) => {
          const r = pool.reserves[a.symbol]
          return (
            <motion.div key={a.symbol} {...reveal} transition={{ duration: 0.45, delay: i * 0.08 }}>
              <Link to="/app/earn" className="card card-hover group block p-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <TokenBadge symbol={a.symbol} size={40} />
                    <div>
                      <div className="display text-xl font-semibold">{a.symbol}</div>
                      <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                        {a.name}
                      </div>
                    </div>
                  </div>
                  <ArrowRight className="size-5 transition-transform group-hover:translate-x-1" style={{ color: 'var(--subtle)' }} />
                </div>
                <dl className="mt-6 grid grid-cols-3 gap-4">
                  <Cell label="Earn APY" value={pool.loaded ? fmtApr(r.supplyRateApr) : '...'} tone="var(--success)" />
                  <Cell label="Borrow APY" value={pool.loaded ? fmtApr(r.borrowRateApr) : '...'} />
                  <Cell label="Max LTV" value={pool.loaded ? fmtBps(r.ltv) : '...'} />
                </dl>
                <div className="mt-4 text-xs" style={{ color: 'var(--subtle)' }}>
                  {pool.loaded ? `${fmtUsd8(valueUsd8(r.totalSupplied, a.symbol, pool.eurc8))} supplied` : 'Loading market'}
                </div>
              </Link>
            </motion.div>
          )
        })}
      </div>
    </Section>
  )
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="display num mt-1 text-2xl font-semibold" style={{ color: tone ?? 'var(--ink)' }}>
        {value}
      </dd>
    </div>
  )
}

const FEATURES = [
  { icon: PiggyBank, title: 'Earn on idle stablecoins', text: 'Supply USDC or EURC and earn a variable rate that moves with demand.' },
  { icon: Landmark, title: 'Borrow against deposits', text: 'Every deposit is collateral. Preview your health factor before you sign.' },
  { icon: Repeat, title: 'Swap USDC and EURC', text: 'Trade between the two assets without leaving the app.' },
  { icon: ArrowLeftRight, title: 'Bridge USDC in', text: 'Move USDC from Ethereum, Base, Arbitrum or Polygon test networks with native burn and mint.' },
  { icon: UserRound, title: 'Sign in with Google', text: 'Start with an email login and a wallet created for you, or bring your own wallet.' },
  { icon: Zap, title: 'Fees in USDC', text: 'Arc uses USDC for network fees, so one asset covers everything you do here.' },
]

export function Features() {
  return (
    <Section eyebrow="Everything in one place" title="A complete stablecoin credit desk">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map(({ icon: Icon, title, text }, i) => (
          <motion.div key={title} {...reveal} transition={{ duration: 0.4, delay: (i % 3) * 0.07 }} className="card card-hover p-6">
            <div className="flex size-10 items-center justify-center rounded-xl" style={{ background: 'var(--surface-strong)' }}>
              <Icon className="size-5" style={{ color: 'var(--accent)' }} />
            </div>
            <h3 className="display mt-4 text-lg font-semibold">{title}</h3>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--muted)' }}>
              {text}
            </p>
          </motion.div>
        ))}
      </div>
    </Section>
  )
}

const STEPS = [
  { icon: Wallet, title: 'Sign in', text: 'Use Google or connect a wallet. Add test USDC from the faucet.' },
  { icon: PiggyBank, title: 'Supply', text: 'Deposit USDC or EURC. You start earning right away and unlock borrowing power.' },
  { icon: Landmark, title: 'Borrow or swap', text: 'Borrow up to your limit, swap, or bridge. Keep your health factor above 1.' },
]

export function HowItWorks() {
  return (
    <Section id="how" eyebrow="How it works" title="From sign-in to borrowing in three steps">
      <ol className="grid gap-4 md:grid-cols-3">
        {STEPS.map(({ icon: Icon, title, text }, i) => (
          <motion.li key={title} {...reveal} transition={{ duration: 0.45, delay: i * 0.1 }} className="card relative p-6">
            <span className="display absolute right-5 top-4 text-5xl font-semibold" style={{ color: 'rgba(255,255,255,0.06)' }}>
              {i + 1}
            </span>
            <Icon className="size-6" style={{ color: 'var(--accent)' }} />
            <h3 className="display mt-4 text-xl font-semibold">{title}</h3>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--muted)' }}>
              {text}
            </p>
          </motion.li>
        ))}
      </ol>
    </Section>
  )
}

export function Transparency() {
  const points = [
    { icon: Scale, title: 'Clear liquidation rules', text: 'If a position falls below a health factor of 1, a liquidator can repay up to half the debt and receive a 5% bonus.' },
    { icon: LockKeyhole, title: 'Caps and a pause switch', text: 'Markets support supply and borrow caps, and new borrowing can be paused while repayments and withdrawals stay open.' },
    { icon: Zap, title: 'Chainlink prices', text: 'EURC and USDC are priced from Chainlink feeds, and borrowing and liquidations pause if a price goes stale. On testnet the Arc mainnet Chainlink prices are relayed onto the testnet feeds.' },
  ]
  return (
    <Section id="security" eyebrow="Transparency" title="Know exactly what you are using">
      <div className="grid gap-4 md:grid-cols-3">
        {points.map(({ icon: Icon, title, text }, i) => (
          <motion.div key={title} {...reveal} transition={{ duration: 0.45, delay: i * 0.08 }} className="card p-6">
            <Icon className="size-5" style={{ color: 'var(--accent)' }} />
            <h3 className="display mt-3 text-lg font-semibold">{title}</h3>
            <p className="mt-1.5 text-sm" style={{ color: 'var(--muted)' }}>
              {text}
            </p>
          </motion.div>
        ))}
      </div>
      <a
        href={buildAddressExplorerUrl(ARC_ID, POOL_ADDRESS)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-flex items-center gap-1.5 text-sm font-semibold"
        style={{ color: 'var(--accent)' }}
      >
        Read the market contract on the explorer <ExternalLink className="size-3.5" />
      </a>
    </Section>
  )
}

export function FinalCta() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-20">
      <motion.div {...reveal} className="card relative overflow-hidden p-7 text-center sm:p-14">
        <div className="glow left-1/2 top-0 size-72 -translate-x-1/2 bg-[#acc6e9]/20" aria-hidden="true" />
        <h2 className="display text-gradient relative text-balance text-3xl font-semibold sm:text-5xl">Put your stablecoins to work.</h2>
        <p className="relative mx-auto mt-4 max-w-md text-pretty" style={{ color: 'var(--muted)' }}>
          Open the app, sign in, and make your first deposit on Arc Testnet.
        </p>
        <Link to="/app/earn" className="btn-primary relative mt-8 !min-h-12 !px-7 !text-base">
          Launch app <ArrowRight className="size-4" />
        </Link>
      </motion.div>
    </section>
  )
}

export function Footer() {
  return (
    <footer className="border-t" style={{ borderColor: 'var(--border)' }}>
      <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center" style={{ color: 'var(--subtle)' }}>
        <Logo size={22} />
        <p>ORYN is a testnet demo on Arc. Nothing here is financial advice.</p>
        <a href="https://docs.arc.io" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--ink-2)' }}>
          Arc docs <ExternalLink className="size-3.5" />
        </a>
      </div>
    </footer>
  )
}
