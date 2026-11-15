import { useEffect, useMemo, useState } from 'react'
import { Crown, ExternalLink, Medal, RefreshCw, Trophy } from 'lucide-react'
import { useAccount } from 'wagmi'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID } from '@/lib/pool'
import { BOARDS, PERIODS, buildBoard, compact, inPeriod, short, type Board, type Period, type Row } from '@/lib/stats'
import { usePoolEvents } from '@/hooks/usePoolEvents'
import type { PoolState } from '@/hooks/usePool'
import { PageTitle, Skeleton } from '@/components/ui'

const SHOWN = 25

const hue = (address: string) => parseInt(address.slice(2, 8), 16) % 360

function Avatar({ address, size = 36 }: { address: string; size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
      style={{ width: size, height: size, background: `hsl(${hue(address)} 42% 62%)`, color: '#0a0814' }}
      aria-hidden="true"
    >
      {address.slice(2, 4).toUpperCase()}
    </span>
  )
}

export function LeaderboardPage({ pool }: { pool: PoolState }) {
  const { address } = useAccount()
  const { data, isLoading, isError, refetch, isFetching } = usePoolEvents()
  const [board, setBoard] = useState<Board>('suppliers')
  const [period, setPeriod] = useState<Period>('all')
  const meta = BOARDS.find((b) => b.id === board) ?? BOARDS[0]
  const me = address?.toLowerCase()
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(id)
  }, [])

  const rows = useMemo(() => {
    if (!data || !pool.loaded) return []
    return buildBoard(inPeriod(data, period, now), board, pool.prices)
  }, [data, pool.loaded, pool.prices, board, period, now])

  const top = rows[0]?.value ?? 0
  const myIndex = me ? rows.findIndex((r) => r.address === me) : -1
  const podium = rows.slice(0, 3)
  const rest = rows.slice(3, SHOWN)
  const extraLabel = board === 'active' ? (r: Row) => `${r.extra} action${r.extra === 1 ? '' : 's'}` : (r: Row) => `${meta.extra} ${compact(r.extra)}`

  return (
    <div>
      <PageTitle title="Leaderboard">Top wallets in the ORYN market, ranked from what the pool has recorded onchain.</PageTitle>

      <div className="mb-4 flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Leaderboard">
        {BOARDS.map((b) => (
          <button
            key={b.id}
            role="tab"
            aria-selected={board === b.id}
            className={board === b.id ? 'btn-primary !min-h-11 shrink-0 !px-4' : 'btn-ghost !min-h-11 shrink-0'}
            onClick={() => setBoard(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm" style={{ color: 'var(--muted)' }}>
          {meta.metric}: {meta.blurb}
        </p>
        <div className="flex items-center gap-1.5" role="group" aria-label="Time range">
          {PERIODS.map((p) => (
            <button key={p.id} className="chip" aria-pressed={period === p.id} style={period === p.id ? { background: 'var(--surface-strong)', borderColor: 'var(--accent)' } : undefined} onClick={() => setPeriod(p.id)}>
              {p.label}
            </button>
          ))}
          <button className="chip !min-w-0 !px-2.5" onClick={() => void refetch()} aria-label="Refresh leaderboard" disabled={isFetching}>
            <RefreshCw className={`size-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {me && myIndex >= 0 && (
        <div className="card mb-5 flex items-center justify-between gap-3 p-4" style={{ borderColor: 'rgba(185,166,255,0.4)' }}>
          <div className="flex items-center gap-3">
            <Avatar address={rows[myIndex].address} />
            <div>
              <div className="label">Your rank</div>
              <div className="display text-2xl font-semibold">#{myIndex + 1}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="display num text-xl font-semibold">{compact(rows[myIndex].value)}</div>
            <div className="text-xs" style={{ color: 'var(--subtle)' }}>
              {meta.metric}
            </div>
          </div>
        </div>
      )}

      {isLoading || !pool.loaded ? (
        <div className="space-y-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="card p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Could not load the pool's history from the explorer.
          <div className="mt-3">
            <button className="btn-ghost" onClick={() => void refetch()}>
              Try again
            </button>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <Trophy className="size-8" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
          <div className="display text-lg font-semibold">No one on this board yet</div>
          <p className="max-w-sm text-sm" style={{ color: 'var(--muted)' }}>
            {period === 'all' ? 'The first wallet to use the market takes the top spot.' : 'Nothing in this time range. Try a longer one.'}
          </p>
        </div>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-3">
            {podium.map((r, i) => (
              <PodiumCard key={r.address} rank={i + 1} row={r} you={r.address === me} metric={meta.metric} extra={extraLabel(r)} />
            ))}
          </div>

          {rest.length > 0 && (
            <ol className="space-y-2" start={4}>
              {rest.map((r, i) => (
                <li key={r.address} className="card flex items-center gap-3 p-3.5" style={r.address === me ? { borderColor: 'rgba(185,166,255,0.4)' } : undefined}>
                  <span className="display num w-7 shrink-0 text-center text-sm font-semibold" style={{ color: 'var(--subtle)' }}>
                    {i + 4}
                  </span>
                  <Avatar address={r.address} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <AddressLink address={r.address} />
                      {r.address === me && <YouTag />}
                    </div>
                    <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full rounded-full" style={{ width: `${Math.max(3, (r.value / top) * 100)}%`, background: 'var(--accent)' }} />
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="display num font-semibold">{compact(r.value)}</div>
                    <div className="text-[11px]" style={{ color: 'var(--subtle)' }}>
                      {extraLabel(r)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      <p className="mt-6 text-xs" style={{ color: 'var(--subtle)' }}>
        Built from the pool's onchain events and valued at today's Chainlink prices. Updates every 30 seconds.
      </p>
    </div>
  )
}

function PodiumCard({ rank, row, you, metric, extra }: { rank: number; row: Row; you: boolean; metric: string; extra: string }) {
  const tone = rank === 1 ? '#f5c56b' : rank === 2 ? '#cbd5e1' : '#d9a066'
  const Icon = rank === 1 ? Crown : Medal
  return (
    <div className="card p-4" style={you ? { borderColor: 'rgba(185,166,255,0.4)' } : rank === 1 ? { borderColor: 'rgba(245,197,107,0.35)' } : undefined}>
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: tone }}>
          <Icon className="size-4" aria-hidden="true" /> #{rank}
        </span>
        {you && <YouTag />}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <Avatar address={row.address} size={40} />
        <AddressLink address={row.address} />
      </div>
      <div className="mt-4">
        <div className="display num text-2xl font-semibold">{compact(row.value)}</div>
        <div className="text-xs" style={{ color: 'var(--subtle)' }}>
          {metric} · {extra}
        </div>
      </div>
    </div>
  )
}

function AddressLink({ address }: { address: string }) {
  return (
    <a
      href={buildAddressExplorerUrl(ARC_ID, address)}
      target="_blank"
      rel="noopener noreferrer"
      className="num inline-flex items-center gap-1 truncate text-sm font-semibold hover:underline"
    >
      {short(address)}
      <ExternalLink className="size-3 shrink-0" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
    </a>
  )
}

function YouTag() {
  return (
    <span className="rounded-md px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider" style={{ background: 'var(--accent)', color: 'var(--accent-ink)' }}>
      You
    </span>
  )
}
