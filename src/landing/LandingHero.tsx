import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { ASSET_LIST, fmtApr, valueUsd8 } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'
import { Link } from '@/lib/router'
import { CountUp, Skeleton, TokenBadge } from '@/components/ui'

export function LandingHero({ pool }: { pool: PoolState }) {
  return (
    <section className="relative overflow-hidden">
      <div className="bg-grid absolute inset-0" aria-hidden="true" />
      <div className="glow -left-24 top-10 size-96 bg-[#3b6ea5]/30" aria-hidden="true" />
      <div className="glow -right-24 top-40 size-80 bg-[#acc6e9]/15" aria-hidden="true" />

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 pb-14 pt-10 sm:pb-20 sm:pt-16 lg:grid-cols-[1.1fr_0.9fr] lg:pt-24">
        <div>
          <motion.span
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--ink-2)' }}
          >
            <span className="size-1.5 rounded-full" style={{ background: 'var(--success)' }} />
            Live on Arc Testnet
          </motion.span>

          <motion.h1
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.05 }}
            className="display text-gradient mt-5 text-balance text-4xl font-semibold leading-[1.05] min-[400px]:text-5xl sm:text-6xl lg:text-7xl"
          >
            Stablecoin credit that settles in a blink.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="mt-5 max-w-xl text-pretty text-base sm:mt-6 sm:text-lg"
            style={{ color: 'var(--muted)' }}
          >
            Supply USDC and EURC to earn, borrow against your deposits, swap and bridge, all on Arc. Network fees are paid in USDC, so there is nothing else to hold.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mt-7 grid gap-3 sm:mt-8 sm:flex sm:flex-wrap sm:items-center"
          >
            <Link to="/app/earn" className="btn-primary !min-h-12 !px-6 !text-base">
              Launch app <ArrowRight className="size-4" />
            </Link>
            <button
              className="btn-ghost !min-h-12 !px-5 !text-sm"
              onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}
            >
              How it works
            </button>
          </motion.div>

          <p className="mt-5 text-xs" style={{ color: 'var(--subtle)' }}>
            Sign in with Google or connect a wallet. Testnet only.
          </p>
        </div>

        <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.5 }}>
          <LiveMarkets pool={pool} />
        </motion.div>
      </div>
    </section>
  )
}

function LiveMarkets({ pool }: { pool: PoolState }) {
  const tvl = ASSET_LIST.reduce((sum, a) => sum + valueUsd8(pool.reserves[a.symbol].totalSupplied, a.symbol, pool.eurc8), 0n)
  return (
    <div className="card p-5 shadow-2xl" style={{ boxShadow: '0 30px 80px -30px rgba(0,0,0,0.6)' }}>
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="label">Total supplied</div>
          <div className="display mt-1 text-3xl font-semibold sm:text-4xl">
            {pool.loaded ? <CountUp value={Number(tvl) / 1e8} format={(n) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} /> : <Skeleton className="h-10 w-40" />}
          </div>
        </div>
        <span className="rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: 'rgba(141,216,159,0.12)', color: 'var(--success)' }}>
          Live
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {ASSET_LIST.map((a) => {
          const r = pool.reserves[a.symbol]
          const util = Math.min(100, Number(r.utilization / 10n ** 14n) / 100)
          return (
            <div key={a.symbol} className="inner p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <TokenBadge symbol={a.symbol} size={30} />
                  <div>
                    <div className="display font-semibold">{a.symbol}</div>
                    <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                      {a.name}
                    </div>
                  </div>
                </div>
                <div className="flex gap-5 text-right">
                  <Rate label="Earn" value={pool.loaded ? fmtApr(r.supplyRateApr) : '...'} tone="var(--success)" />
                  <Rate label="Borrow" value={pool.loaded ? fmtApr(r.borrowRateApr) : '...'} tone="var(--ink)" />
                </div>
              </div>
              <div className="mt-3">
                <div className="mb-1 flex justify-between text-[11px]" style={{ color: 'var(--subtle)' }}>
                  <span>Utilization</span>
                  <span className="num">{util.toFixed(1)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                  <motion.div className="h-full rounded-full" style={{ background: 'var(--accent)' }} initial={{ width: 0 }} animate={{ width: `${util}%` }} transition={{ duration: 0.8 }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
      <p className="mt-4 text-center text-[11px]" style={{ color: 'var(--subtle)' }}>
        Read live from the market contract on Arc Testnet.
      </p>
    </div>
  )
}

function Rate({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="display num text-lg font-semibold" style={{ color: tone }}>
        {value}
      </div>
      <div className="label">{label}</div>
    </div>
  )
}
