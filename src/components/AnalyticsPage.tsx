import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useReadContracts } from 'wagmi'
import type { Address } from 'viem'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, fmtApr, fmtHealth, poolAbi, valueUsd8 } from '@/lib/pool'
import { compact, dailySeries, money, short, totals } from '@/lib/stats'
import { usePoolEvents } from '@/hooks/usePoolEvents'
import type { PoolState } from '@/hooks/usePool'
import { ShareBar, StackedBars, type BarDatum } from '@/components/Charts'
import { PageTitle, Skeleton, TokenBadge } from '@/components/ui'

const DAYS = 14
const MAX_WATCHED = 80
const WAD = 1e18

const dayLabel = (ts: number) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

export function AnalyticsPage({ pool }: { pool: PoolState }) {
  const { data, isLoading, isError, refetch, isFetching } = usePoolEvents()
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])

  const supplied = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].totalSupplied, a.symbol, pool.prices)) / 1e8, 0)
  const borrowed = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].totalBorrowed, a.symbol, pool.prices)) / 1e8, 0)
  const liquidity = ASSET_LIST.reduce((s, a) => s + Number(valueUsd8(pool.reserves[a.symbol].availableLiquidity, a.symbol, pool.prices)) / 1e8, 0)
  const utilization = supplied > 0 ? (borrowed / supplied) * 100 : 0

  const stats = useMemo(() => (data && pool.loaded ? totals(data, pool.prices, now) : undefined), [data, pool.loaded, pool.prices, now])
  const days = useMemo(() => (data && pool.loaded ? dailySeries(data, pool.prices, DAYS, now) : []), [data, pool.loaded, pool.prices, now])

  const volumeData: BarDatum[] = days.map((d) => ({ label: dayLabel(d.ts), title: dayLabel(d.ts), values: { deposit: d.deposit, borrow: d.borrow, repay: d.repay, withdraw: d.withdraw } }))
  const activeData: BarDatum[] = days.map((d) => ({ label: dayLabel(d.ts), title: dayLabel(d.ts), values: { users: d.users } }))

  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <PageTitle title="Analytics">How the ORYN market is doing right now, from live pool data and its onchain history.</PageTitle>
        <button className="chip mt-1 !min-w-0 !px-2.5" onClick={() => void refetch()} aria-label="Refresh analytics" disabled={isFetching}>
          <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <section aria-label="Market totals" className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total supplied" value={pool.loaded ? compact(supplied) : undefined} />
        <Kpi label="Total borrowed" value={pool.loaded ? compact(borrowed) : undefined} />
        <Kpi label="Utilization" value={pool.loaded ? `${utilization.toFixed(1)}%` : undefined} />
        <Kpi label="Available liquidity" value={pool.loaded ? compact(liquidity) : undefined} />
        <Kpi label="Wallets" value={stats ? String(stats.users) : undefined} sub="ever used the pool" />
        <Kpi label="Actions" value={stats ? String(stats.actions) : undefined} sub="deposits, loans, repayments" />
        <Kpi label="Volume, 24h" value={stats ? compact(stats.volume24h) : undefined} />
        <Kpi label="Liquidations" value={stats ? String(stats.liquidations) : undefined} sub={stats ? `${compact(stats.liquidated)} repaid` : undefined} />
      </section>

      {isError ? (
        <div className="card mb-6 p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Could not load the pool's history from the explorer. Live totals above are still current.
        </div>
      ) : (
        <div className="mb-6 grid gap-4 lg:grid-cols-2">
          <section className="card p-5">
            <h2 className="display text-lg font-semibold">Daily volume</h2>
            <p className="mb-3 mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
              Last {DAYS} days (UTC), valued at today's prices.
            </p>
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
            <h2 className="display text-lg font-semibold">Active wallets</h2>
            <p className="mb-3 mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
              Different wallets that used the pool each day.
            </p>
            {isLoading || !pool.loaded ? <Skeleton className="h-52 w-full" /> : <StackedBars data={activeData} series={[{ key: 'users', label: 'Wallets', color: '#b9a6ff' }]} format={(n) => String(Math.round(n))} ariaLabel="Active wallets per day" />}
          </section>
        </div>
      )}

      <section className="card mb-6 p-5">
        <h2 className="display text-lg font-semibold">Markets</h2>
        <div className="mt-4 space-y-3">
          {ASSET_LIST.map((a) => {
            const r = pool.reserves[a.symbol]
            const sup = Number(valueUsd8(r.totalSupplied, a.symbol, pool.prices)) / 1e8
            const bor = Number(valueUsd8(r.totalBorrowed, a.symbol, pool.prices)) / 1e8
            const share = supplied > 0 ? (sup / supplied) * 100 : 0
            return (
              <div key={a.symbol} className="inner p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <TokenBadge symbol={a.symbol} size={30} />
                    <div>
                      <div className="display font-semibold">{a.symbol}</div>
                      <div className="num text-xs" style={{ color: 'var(--subtle)' }}>
                        {pool.loaded ? money(Number(pool.prices[a.symbol]) / 1e8, a.symbol === 'cirBTC' ? 0 : 4) : '...'} Chainlink
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-6 text-right">
                    <Fig label="Supplied" value={pool.loaded ? compact(sup) : '...'} />
                    <Fig label="Borrowed" value={pool.loaded ? compact(bor) : '...'} />
                    <Fig label="Earn" value={pool.loaded ? fmtApr(r.supplyRateApr) : '...'} tone="var(--success)" />
                    <Fig label="Borrow" value={pool.loaded ? fmtApr(r.borrowRateApr) : '...'} />
                  </div>
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <Meter label="Share of deposits" value={share} />
                  <Meter label="Utilization" value={Number(r.utilization) / WAD * 100} />
                </div>
              </div>
            )
          })}
        </div>
      </section>

      <RiskMonitor events={data} loaded={pool.loaded} />

      <p className="mt-6 text-xs" style={{ color: 'var(--subtle)' }}>
        Totals and rates are read live from the pool contract. History comes from its onchain events and refreshes every 30 seconds.
      </p>
    </div>
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
            Open loans, closest to liquidation first. Health below 1.00 can be liquidated.
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
      <div className="label">{label}</div>
    </div>
  )
}

function Meter({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px]" style={{ color: 'var(--subtle)' }}>
        <span>{label}</span>
        <span className="num">{value.toFixed(1)}%</span>
      </div>
      <ShareBar value={value} label={label} />
    </div>
  )
}
