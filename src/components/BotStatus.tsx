import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ExternalLink } from 'lucide-react'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { ARC_ID } from '@/lib/pool'
import { Skeleton } from '@/components/ui'

/** Where the Cloudflare liquidation bot answers. Optional: the card is hidden when it is not set. */
const RAW_BOT_URL = ((import.meta.env.VITE_BOT_URL as string | undefined) ?? '').trim().replace(/\/$/, '')
// Accept a bare host such as "name.workers.dev" and treat it as https.
const BOT_URL = RAW_BOT_URL === '' || /^https?:\/\//i.test(RAW_BOT_URL) ? RAW_BOT_URL : `https://${RAW_BOT_URL}`

interface BotAction {
  t: number
  kind: 'relay' | 'liquidate' | 'skip' | 'error'
  text: string
  hash?: string
}

interface BotResponse {
  status: {
    lastRun: number
    pricesFresh: boolean | null
    priceAgeSec: Record<string, number>
    borrowersWatched: number
    atRisk: number
    liquidatable: number
    liquidationsTotal: number
    dryRun: boolean
    lastError: string | null
  } | null
  actions: BotAction[]
}

async function loadBot(): Promise<BotResponse> {
  const res = await fetch(`${BOT_URL}/status`)
  if (!res.ok) throw new Error(`Bot answered ${res.status}`)
  return (await res.json()) as BotResponse
}

const ago = (ms: number, now: number) => {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

export function BotStatus() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['bot-status'], queryFn: loadBot, refetchInterval: 15_000, enabled: BOT_URL !== '', retry: 1 })
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000)
    return () => clearInterval(id)
  }, [])
  if (BOT_URL === '') return null

  const s = data?.status
  const online = s !== undefined && s !== null && now - s.lastRun < 150_000
  const pill = isError ? { text: 'Unreachable', color: 'var(--danger)', bg: 'rgba(255,122,138,0.12)' } : online ? { text: 'Online', color: 'var(--success)', bg: 'rgba(94,224,138,0.12)' } : { text: 'Idle', color: 'var(--warn)', bg: 'rgba(245,197,107,0.12)' }
  const oldest = s ? Math.max(...Object.values(s.priceAgeSec), 0) : 0

  return (
    <section className="card mb-4 p-5" aria-label="Liquidation bot">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="display text-lg font-semibold">Liquidation bot</h2>
          {s?.dryRun && (
            <span className="rounded-full border px-2 py-0.5 text-[11px] font-semibold" style={{ borderColor: 'var(--border)', color: 'var(--muted)' }}>
              Dry run
            </span>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: pill.bg, color: pill.color }}>
          <span className="size-1.5 rounded-full" style={{ background: pill.color }} />
          {pill.text}
          {s && !isError ? ` · ${ago(s.lastRun, now)}` : ''}
        </span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini label="Loans watched" value={isLoading ? undefined : String(s?.borrowersWatched ?? 0)} />
        <Mini label="Near the line" value={isLoading ? undefined : String(s?.atRisk ?? 0)} />
        <Mini label="Liquidated" value={isLoading ? undefined : String(s?.liquidationsTotal ?? 0)} />
        <Mini label="Prices" value={isLoading ? undefined : s?.pricesFresh === null || s === null || s === undefined ? '...' : s.pricesFresh ? 'Fresh' : `Stale ${Math.round(oldest / 3600)}h`} tone={s?.pricesFresh === false ? 'var(--warn)' : undefined} />
      </div>

      {data && data.actions.length > 0 && (
        <ul className="mt-4 space-y-1.5">
          {data.actions.slice(0, 5).map((a, i) => (
            <li key={`${a.t}-${i}`} className="inner flex items-center justify-between gap-3 px-3 py-2 text-xs">
              <span className="min-w-0 truncate" style={{ color: a.kind === 'error' ? 'var(--danger)' : a.kind === 'liquidate' ? 'var(--success)' : 'var(--muted)' }}>
                {a.text}
              </span>
              <span className="flex shrink-0 items-center gap-2" style={{ color: 'var(--subtle)' }}>
                {ago(a.t, now)}
                {a.hash && (
                  <a href={buildTxExplorerUrl(ARC_ID, a.hash)} target="_blank" rel="noopener noreferrer" aria-label="View transaction">
                    <ExternalLink className="size-3" />
                  </a>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Mini({ label, value, tone }: { label: string; value: string | undefined; tone?: string }) {
  return (
    <div className="inner p-3">
      <div className="label">{label}</div>
      <div className="display num mt-1 text-lg font-semibold" style={{ color: tone ?? 'var(--ink)' }}>
        {value ?? <Skeleton className="h-6 w-12" />}
      </div>
    </div>
  )
}
