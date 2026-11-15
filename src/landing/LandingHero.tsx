import { motion } from 'framer-motion'
import { ArrowRight } from 'lucide-react'
import { ASSET_LIST, fmtApr, fmtBps, valueUsd8 } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'
import { Link } from '@/lib/router'
import { Skeleton, TokenBadge } from '@/components/ui'

export function LandingHero({ pool }: { pool: PoolState }) {
  return (
    <section className="relative overflow-hidden">
      <div className="bg-grid absolute inset-0" aria-hidden="true" />
      <div className="glow -left-24 top-10 size-96 bg-[#8f78ff]/25" aria-hidden="true" />
      <div className="glow -right-24 top-40 size-80 bg-[#b9a6ff]/15" aria-hidden="true" />

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
            Onchain credit that settles in a blink.
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.12 }}
            className="mt-5 max-w-xl text-pretty text-base sm:mt-6 sm:text-lg"
            style={{ color: 'var(--muted)' }}
          >
            Supply USDC, EURC and cirBTC to earn, borrow against your deposits, swap and bridge, all on Arc. Network fees are paid in USDC, so there is nothing else to hold.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="mt-7 grid gap-3 sm:mt-8 sm:flex sm:flex-wrap sm:items-center"
          >
            <Link to="/app/markets" className="btn-primary !min-h-12 !px-6 !text-base">
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
  const sum = (pick: 'totalSupplied' | 'totalBorrowed') =>
    ASSET_LIST.reduce((acc, a) => acc + valueUsd8(pool.reserves[a.symbol][pick], a.symbol, pool.prices), 0n)
  const supplied = sum('totalSupplied')
  const borrowed = sum('totalBorrowed')
  const util = supplied > 0n ? Number((borrowed * 10000n) / supplied) / 100 : null
  const usd = (v: bigint) => `$${(Number(v) / 1e8).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return (
    <div className="card p-4 sm:p-5" style={{ boxShadow: '0 30px 80px -30px rgba(80,50,200,0.45), inset 0 1px 0 rgba(255,255,255,0.06)' }}>
      <div className="inner p-4">
        <div className="flex items-center justify-between text-xs font-semibold" style={{ color: 'var(--ink-2)' }}>
          Protocol Overview
          <span className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]" style={{ background: 'rgba(94,224,138,0.12)', color: 'var(--success)' }}>
            <span className="size-1.5 rounded-full" style={{ background: 'var(--success)' }} />
            Live
          </span>
        </div>
        <dl className="mt-3 grid grid-cols-3 divide-x divide-white/10">
          <Overview label="Total Supplied" value={pool.loaded ? usd(supplied) : null} />
          <Overview label="Total Borrowed" value={pool.loaded ? usd(borrowed) : null} />
          <Overview label="Utilization" value={pool.loaded ? (util === null ? '\u2014' : `${util.toFixed(1)}%`) : null} />
        </dl>
      </div>

      <div className="mt-3 space-y-3">
        {ASSET_LIST.map((a) => {
          const r = pool.reserves[a.symbol]
          return (
            <div key={a.symbol} className="inner flex items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <TokenBadge symbol={a.symbol} size={38} />
                <div>
                  <div className="display font-semibold">{a.symbol}</div>
                  <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                    {a.name}
                  </div>
                </div>
              </div>
              <div className="flex items-baseline gap-5 text-right">
                <div className="num text-base font-semibold" style={{ color: 'var(--success)' }}>
                  {pool.loaded ? fmtApr(r.supplyRateApr) : '...'} <span className="text-xs font-medium" style={{ color: 'var(--ink-2)' }}>APY</span>
                </div>
                <div className="num min-w-16 text-base font-semibold">
                  {pool.loaded ? fmtBps(r.ltv) : '...'} <span className="text-xs font-medium" style={{ color: 'var(--ink-2)' }}>LTV</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Overview({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="px-3 first:pl-0 last:pr-0">
      <dd className="display num text-lg font-semibold sm:text-xl">{value ?? <Skeleton className="h-6 w-20" />}</dd>
      <dt className="mt-0.5 text-[11px]" style={{ color: 'var(--subtle)' }}>
        {label}
      </dt>
    </div>
  )
}
