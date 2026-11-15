import { ArrowDownToLine, ArrowUpFromLine, ExternalLink, HandCoins, ShieldAlert, Swords, Undo2, type LucideIcon } from 'lucide-react'
import type { Address } from 'viem'
import { buildTxExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSETS, fmtToken } from '@/lib/pool'
import { useActivity, type ActivityKind } from '@/hooks/useActivity'
import { Skeleton, TokenBadge } from '@/components/ui'

const META: Record<ActivityKind, { label: string; icon: LucideIcon; sign: '+' | '-' | ''; tone: string }> = {
  deposit: { label: 'Deposited', icon: ArrowDownToLine, sign: '+', tone: 'var(--success)' },
  withdraw: { label: 'Withdrew', icon: ArrowUpFromLine, sign: '-', tone: 'var(--ink)' },
  borrow: { label: 'Borrowed', icon: HandCoins, sign: '+', tone: 'var(--accent)' },
  repay: { label: 'Repaid', icon: Undo2, sign: '-', tone: 'var(--ink)' },
  liquidated: { label: 'Liquidated', icon: ShieldAlert, sign: '-', tone: 'var(--danger)' },
  liquidation: { label: 'Liquidated a loan', icon: Swords, sign: '', tone: 'var(--warn)' },
}

function ago(timestamp: number): string {
  if (!timestamp) return ''
  const s = Math.max(0, Math.floor(Date.now() / 1000) - timestamp)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function ActivityFeed({ address }: { address: Address }) {
  const { data, isLoading, isError, refetch } = useActivity(address)

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="display text-xl font-semibold">Activity</h2>
        <button className="btn-ghost !min-h-11" onClick={() => void refetch()}>
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      ) : isError ? (
        <div className="card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
          Could not load your activity from the explorer. Try again in a moment.
        </div>
      ) : !data || data.length === 0 ? (
        <div className="card p-6 text-center text-sm" style={{ color: 'var(--muted)' }}>
          No activity yet. Your deposits, loans and repayments will show up here.
        </div>
      ) : (
        <ul className="space-y-2">
          {data.map((item) => {
            const m = META[item.kind]
            const Icon = m.icon
            return (
              <li key={item.id}>
                <a
                  href={buildTxExplorerUrl(ARC_ID, item.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="card card-hover flex min-h-16 items-center justify-between gap-3 p-3.5"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="relative shrink-0">
                      <TokenBadge symbol={item.symbol} size={36} />
                      <span className="absolute -bottom-1 -right-1 flex size-5 items-center justify-center rounded-full" style={{ background: 'var(--surface-muted)', border: '1px solid var(--border)' }}>
                        <Icon className="size-3" style={{ color: m.tone }} />
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold">{m.label}</div>
                      <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                        {ago(item.timestamp) || 'Confirmed'}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-right">
                    <span className="display num text-base font-semibold" style={{ color: m.tone }}>
                      {m.sign}
                      {fmtToken(item.amount, ASSETS[item.symbol].decimals)} {item.symbol}
                    </span>
                    <ExternalLink className="size-3.5 shrink-0" style={{ color: 'var(--subtle)' }} />
                  </div>
                </a>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
