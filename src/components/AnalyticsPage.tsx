import { useEffect, useId, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, fmtApr, fmtHealth, poolAbi, valueUsd8 } from '@/lib/pool'
import { compact, dailySeries, money, short, totals } from '@/lib/stats'
import { usePoolEvents } from '@/hooks/usePoolEvents'
import type { PoolState } from '@/hooks/usePool'
import { BotStatus } from '@/components/BotStatus'
import { ShareBar, StackedBars, type BarDatum } from '@/components/Charts'
import { Skeleton, TokenBadge } from '@/components/ui'

const DAYS = 14
const MAX_WATCHED = 80
const WAD = 1e18

const dayLabel = (ts: number) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

type View = 'markets' | 'activity' | 'risk'
const VIEWS: { id: View; label: string }[] = [
  { id: 'markets', label: 'Markets' },
  { id: 'activity', label: 'Activity' },
  { id: 'risk', label: 'Risk' },
]

export function AnalyticsPage({ pool }: { pool: PoolState }) {
  const { data, isLoading, isError, refetch, isFetching } = usePoolEvents()
  const [view, setView] = useState<View>('markets')
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])

  const supplied = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].totalSupplied, a.symbol, pool.prices)) / 1e8, 0)
  const borrowed = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].totalBorrowed, a.symbol, pool.prices)) / 1e8, 0)
  const liquidity = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].availableLiquidity, a.symbol, pool.prices)) / 1e8, 0)
  const utilization = supplied > 0 ? (borrowed / supplied) * 100 : 0
  const freeShare = supplied > 0 ? (liquidity / supplied) * 100 : 0

  const stats = useMemo(() => (data && pool.loaded ? totals(data, pool.prices, now) : undefined), [data, pool.loaded, pool.prices, now])
  const days = useMemo(() => (data && pool.loaded ? dailySeries(data, pool.prices, DAYS, now) : []), [data, pool.loaded, pool.prices, now])
  const trend = days.map((d) => d.deposit + d.borrow + d.repay + d.withdraw)

  const volumeData: BarDatum[] = days.map((d) => ({ label: dayLabel(d.ts), title: dayLabel(d.ts), values: { deposit: d.deposit, borrow: d.borrow, repay: d.repay, withdraw: d.withdraw } }))
  const activeData: BarDatum[] = days.map((d) => ({ label: dayLabel(d.ts), title: dayLabel(d.ts), values: { users: d.users } }))

  return (
    <div>
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className="display text-3xl font-semibold sm:text-4xl">Analytics</h1>
        <button className="chip !min-w-0 !px-2.5" onClick={() => void refetch()} aria-label="Refresh analytics" disabled={isFetching}>
          <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <section aria-label="Market totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="TVL" value={pool.loaded ? compact(supplied) : undefined} foot={<span>{ASSET_LIST.length} markets</span>} />
        <StatCard label="Liquidity" value={pool.loaded ? compact(liquidity) : undefined} foot={<span>{pool.loaded ? `${freeShare.toFixed(0)}% free to borrow` : '...'}</span>} />
        <StatCard
          label="Borrowed"
          value={pool.loaded ? compact(borrowed) : undefined}
          foot={
            <span className="flex w-full items-center gap-2">
              <span className="num shrink-0">{pool.loaded ? `${utilization.toFixed(1)}%` : '...'}</span>
              <span className="min-w-0 flex-1">
                <ShareBar value={utilization} label="Utilization" />
              </span>
            </span>
          }
        />
        <StatCard
          label="Volume, 24h"
          value={stats ? compact(stats.volume24h) : undefined}
          foot={trend.length > 1 ? <Spark values={trend} label={`Daily volume, last ${DAYS} days`} /> : <span>{isError ? 'History unavailable' : '...'}</span>}
        />
      </section>

      <div className="mt-3 flex flex-wrap gap-2" aria-label="Pool activity">
        <Pill label="Wallets" value={stats ? String(stats.users) : undefined} />
        <Pill label="Actions" value={stats ? String(stats.actions) : undefined} />
        <Pill label="All-time volume" value={stats ? compact(stats.volumeAll) : undefined} />
        <Pill label="Liquidations" value={stats ? String(stats.liquidations) : undefined} />
      </div>

      <div role="tablist" aria-label="Analytics view" className="mt-6 inline-flex gap-1 rounded-2xl border p-1" style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}>
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            id={`analytics-tab-${v.id}`}
            aria-selected={view === v.id}
            aria-controls={`analytics-panel-${v.id}`}
            onClick={() => setView(v.id)}
            className="min-h-10 rounded-xl px-4 text-sm font-semibold transition-colors"
            style={view === v.id ? { background: 'var(--surface-strong)', color: 'var(--ink)' } : { color: 'var(--muted)' }}
          >
            {v.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`analytics-panel-${view}`} aria-labelledby={`analytics-tab-${view}`} className="mt-4">
        {view === 'markets' && (
          <section className="card p-3 sm:p-4" aria-label="Markets">
            <div className="label hidden grid-cols-[1.5fr_1fr_1fr_1fr_1fr_1.3fr] gap-3 px-4 pb-2 md:grid">
              <span>Asset</span>
              <span>Supplied</span>
              <span>Borrowed</span>
              <span>Earn</span>
              <span>Borrow</span>
              <span>Utilization</span>
            </div>
            <ul className="space-y-2">
              {ASSET_LIST.map((a) => {
                const r = pool.reserves[a.symbol]
                const sup = Number(valueUsd8(r.totalSupplied, a.symbol, pool.prices)) / 1e8
                const bor = Number(valueUsd8(r.totalBorrowed, a.symbol, pool.prices)) / 1e8
                return (
                  <li key={a.symbol} className="inner flex flex-col gap-3 p-4 md:grid md:grid-cols-[1.5fr_1fr_1fr_1fr_1fr_1.3fr] md:items-center">
                    <div className="flex items-center gap-2.5">
                      <TokenBadge symbol={a.symbol} size={32} />
                      <div>
                        <div className="display font-semibold">{a.symbol}</div>
                        <div className="num text-xs" style={{ color: 'var(--subtle)' }}>
                          {pool.loaded ? money(Number(pool.prices[a.symbol]) / 1e8, a.symbol === 'cirBTC' ? 0 : 4) : '...'}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3 md:contents">
                      <Fig label="Supplied" value={pool.loaded ? compact(sup) : '...'} />
                      <Fig label="Borrowed" value={pool.loaded ? compact(bor) : '...'} />
                      <Fig label="Earn" value={pool.loaded ? fmtApr(r.supplyRateApr) : '...'} tone="var(--success)" />
                      <Fig label="Borrow" value={pool.loaded ? fmtApr(r.borrowRateApr) : '...'} />
                    </div>
                    <Meter label="Utilization" value={pool.loaded ? (Number(r.utilization) / WAD) * 100 : 0} />
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {view === 'activity' &&
          (isError ? (
            <div className="card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
              Could not load the pool's history from the explorer.
            </div>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="card p-5">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 className="display text-lg font-semibold">Daily volume</h2>
                  <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                    {DAYS} days, UTC
                  </span>
                </div>
                {isLoading || !pool.loaded ? (
                  <Skeleton className="h-52 w-full" />
                ) : (
                  <StackedBars
                    data={volumeData}
                    ariaLabel="Daily volume by action"
                    series={[
                      { key: 'deposit', label: 'Deposits', color: '#5ee08a' },
                      { key: 'borrow', label: 'Borrows', color: '#b9a6ff' },
                      { key: 'repay', label: 'Repaid', color: '#5f87b8' },
                      { key: 'withdraw', label: 'Withdrawn', color: '#f5c56b' },
                    ]}
                  />
                )}
              </section>
              <section className="card p-5">
                <div className="mb-3 flex items-baseline justify-between gap-2">
                  <h2 className="display text-lg font-semibold">Active wallets</h2>
                  <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                    per day
                  </span>
                </div>
                {isLoading || !pool.loaded ? <Skeleton className="h-52 w-full" /> : <StackedBars data={activeData} series={[{ key: 'users', label: 'Wallets', color: '#b9a6ff' }]} format={(n) => String(Math.round(n))} ariaLabel="Active wallets per day" />}
              </section>
            </div>
          ))}

        {view === 'risk' && (
          <>
            <BotStatus />
            <RiskMonitor events={data} loaded={pool.loaded} />
          </>
        )}
      </div>

      <p className="mt-6 text-xs" style={{ color: 'var(--subtle)' }}>
        Live from the pool contract. History refreshes every 30 seconds.
      </p>
    </div>
  )
}

/** One big headline number with a small footer, in the style of a dashboard stat card. */
function StatCard({ label, value, foot }: { label: string; value: string | undefined; foot: React.ReactNode }) {
  return (
    <div className="card flex min-h-[8.5rem] flex-col justify-between p-4 sm:p-5">
      <div>
        <div className="label">{label}</div>
        <div className="display num mt-1.5 text-2xl font-semibold sm:text-3xl">{value ?? <Skeleton className="h-8 w-24" />}</div>
      </div>
      <div className="mt-3 flex min-h-8 items-end text-xs" style={{ color: 'var(--subtle)' }}>
        {foot}
      </div>
    </div>
  )
}

function Pill({ label, value }: { label: string; value: string | undefined }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs" style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--muted)' }}>
      {label}
      <span className="num font-semibold" style={{ color: 'var(--ink)' }}>
        {value ?? '...'}
      </span>
    </span>
  )
}

/** Tiny area chart of a daily series. Plain SVG, no data library. */
function Spark({ values, label }: { values: number[]; label: string }) {
  const id = useId()
  const max = Math.max(...values, 1)
  const W = 120
  const H = 32
  const step = W / Math.max(values.length - 1, 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (v / max) * (H - 6)).toFixed(1)}`)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-8 w-full" preserveAspectRatio="none" role="img" aria-label={label}>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#b9a6ff" stopOpacity="0.35" />
          <stop offset="1" stopColor="#b9a6ff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${H} ${pts.join(' ')} ${W},${H}`} fill={`url(#${id})`} />
      <polyline points={pts.join(' ')} fill="none" stroke="#b9a6ff" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Looks up the health of every wallet that has borrowed, so the riskiest loans are visible. */
function RiskMonitor({ events, loaded }: { events: ReturnType<typeof usePoolEvents>['data']; loaded: boolean }) {
  const watched = useMemo(() => {
    const set = new Set<string>()
    for (const e of events ?? []) if (e.kind === 'borrow') set.add(e.user)
    return [...set].slice(0, MAX_WATCHED) as Address[]
  }, [events])

  const { data, isLoading } = useReadContracts({
    contracts: watched.map((user) => ({ address: POOL_ADDRESS, abi: poolAbi, functionName: 'getUserAccount', args: [user], chainId: ARC_ID }) as const),
    query: { enabled: watched.length > 0 && loaded, refetchInterval: 20_000 },
  })

  const positions = watched
    .map((address, i) => {
      const r = data?.[i]?.result
      if (!r || !Array.isArray(r) || r.length !== 5) return undefined
      const [collateral, debt, , , health] = r as readonly bigint[]
      return { address, collateral, debt, health }
    })
    .filter((p): p is NonNullable<typeof p> => p !== undefined && p.debt > 0n)
    .sort((a, b) => (a.health < b.health ? -1 : a.health > b.health ? 1 : 0))

  const hf = (p: { health: bigint }) => Number(p.health / 10n ** 12n) / 1e6
  const liquidatable = positions.filter((p) => hf(p) < 1)
  const atRisk = positions.filter((p) => hf(p) >= 1 && hf(p) < 1.2)
  const debtAtRisk = [...liquidatable, ...atRisk].reduce((s, p) => s + Number(p.debt) / 1e8, 0)

  return (
    <section className="card p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-semibold">Risk monitor</h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
            Closest to liquidation first.
          </p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={liquidatable.length > 0 ? { background: 'rgba(255,122,138,0.12)', color: 'var(--danger)' } : atRisk.length > 0 ? { background: 'rgba(245,197,107,0.12)', color: 'var(--warn)' } : { background: 'rgba(94,224,138,0.12)', color: 'var(--success)' }}>
          {liquidatable.length > 0 || atRisk.length > 0 ? <AlertTriangle className="size-3.5" /> : <ShieldCheck className="size-3.5" />}
          {liquidatable.length > 0 ? `${liquidatable.length} liquidatable` : atRisk.length > 0 ? `${atRisk.length} at risk` : 'All healthy'}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3">
        <Kpi label="Open loans" value={isLoading ? undefined : String(positions.length)} />
        <Kpi label="Health under 1.2" value={isLoading ? undefined : String(liquidatable.length + atRisk.length)} />
        <Kpi label="Debt at risk" value={isLoading ? undefined : money(debtAtRisk, 2)} />
      </div>

      {positions.length === 0 ? (
        <p className="inner mt-4 p-4 text-sm" style={{ color: 'var(--muted)' }}>
          {isLoading ? 'Checking loans...' : 'No open loans right now.'}
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {positions.slice(0, 8).map((p) => {
            const v = hf(p)
            const color = v < 1 ? 'var(--danger)' : v < 1.2 ? 'var(--warn)' : 'var(--success)'
            return (
              <li key={p.address} className="inner flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <a href={buildAddressExplorerUrl(ARC_ID, p.address)} target="_blank" rel="noopener noreferrer" className="num inline-flex items-center gap-1 font-semibold hover:underline">
                  {short(p.address)} <ExternalLink className="size-3" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
                </a>
                <div className="flex items-center gap-5 text-right">
                  <span className="num hidden text-xs sm:inline" style={{ color: 'var(--subtle)' }}>
                    {money(Number(p.debt) / 1e8)} debt · {money(Number(p.collateral) / 1e8)} collateral
                  </span>
                  <span className="display num w-14 font-semibold" style={{ color }}>
                    {fmtHealth(p.health)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string | undefined; sub?: string }) {
  return (
    <div className="inner p-4">
      <div className="label">{label}</div>
      <div className="display num mt-1.5 text-xl font-semibold sm:text-2xl">{value ?? <Skeleton className="h-7 w-20" />}</div>
      {sub && (
        <div className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

function Fig({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="display num text-base font-semibold" style={{ color: tone ?? 'var(--ink)' }}>
        {value}
      </div>
      <div className="label md:sr-only">{label}</div>
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]" style={{ color: 'var(--subtle)' }}>
        <span className="md:sr-only">{label}</span>
        <span className="num">{value.toFixed(1)}%</span>
      </div>
      <ShareBar value={value} label={label} />
    </div>
  )
}
