import { useState } from 'react'
import { ConnectCta } from '@/auth/ConnectCta'
import { ExternalLink } from 'lucide-react'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, fmtApr, fmtHealth, fmtToken, fmtUsd8, healthTone, valueUsd8, type AssetSymbol } from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'
import { ActionSheet, type ActionKind } from '@/components/ActionSheet'
import { ActivityFeed } from '@/components/ActivityFeed'
import { Insights } from '@/components/Insights'
import { PageTitle, Stat, TokenBadge } from '@/components/ui'

const TONE = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const

export function PositionsPage({ pool, user }: { pool: PoolState; user: UserState }) {
  const [sheet, setSheet] = useState<{ action: ActionKind; symbol: AssetSymbol } | null>(null)

  if (!user.address) {
    return (
      <div>
        <PageTitle title="Your positions">Every deposit and loan you hold in the market, with live health.</PageTitle>
        <div className="card flex flex-col items-center gap-4 p-10 text-center">
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            Connect a wallet to see what you have supplied and borrowed.
          </p>
          <ConnectCta className="btn-primary" />
        </div>
      </div>
    )
  }

  const rows = ASSET_LIST.flatMap((a) => {
    const p = user.assets[a.symbol]
    const r = pool.reserves[a.symbol]
    const out: { kind: 'supply' | 'borrow'; symbol: AssetSymbol; amount: bigint; apr: bigint }[] = []
    if (p.supplied > 0n) out.push({ kind: 'supply', symbol: a.symbol, amount: p.supplied, apr: r.supplyRateApr })
    if (p.debt > 0n) out.push({ kind: 'borrow', symbol: a.symbol, amount: p.debt, apr: r.borrowRateApr })
    return out
  })

  const tone = healthTone(user.healthWad)
  const usedPct =
    user.borrowLimitUsd8 > 0n ? Math.min(100, Number((user.debtUsd8 * 10_000n) / user.borrowLimitUsd8) / 100) : 0

  return (
    <div>
      <PageTitle title="Your positions">Every deposit and loan you hold in the market, with live health.</PageTitle>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Supplied" value={fmtUsd8(user.collateralUsd8)} />
        <Stat label="Borrowed" value={fmtUsd8(user.debtUsd8)} />
        <Stat label="Borrow limit" value={fmtUsd8(user.borrowLimitUsd8)} />
        <div className="inner p-4">
          <div className="label">Health factor</div>
          <div className="display num mt-1.5 text-2xl font-semibold" style={{ color: TONE[tone] }}>
            {fmtHealth(user.healthWad)}
          </div>
          <div className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
            Liquidated below 1.00
          </div>
        </div>
      </div>

      {user.debtUsd8 > 0n && (
        <div className="card mb-6 p-5">
          <div className="flex items-center justify-between text-sm">
            <span style={{ color: 'var(--muted)' }}>Borrow limit used</span>
            <span className="num font-semibold">{usedPct.toFixed(1)}%</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full" style={{ width: `${usedPct}%`, background: TONE[tone === 'none' ? 'safe' : tone] }} />
          </div>
        </div>
      )}

      <h2 className="display mb-3 text-xl font-semibold">Open positions</h2>
      {rows.length === 0 ? (
        <div className="card p-8 text-center text-sm" style={{ color: 'var(--muted)' }}>
          {user.loaded ? 'No open positions yet. Deposit on the Earn page to start.' : 'Loading your positions...'}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <div key={`${row.kind}-${row.symbol}`} className="card flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-3">
                <TokenBadge symbol={row.symbol} size={36} />
                <div>
                  <div className="display font-semibold">
                    {row.kind === 'supply' ? 'Supplied' : 'Borrowed'} {row.symbol}
                  </div>
                  <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                    {fmtApr(row.apr)} APY · {fmtUsd8(valueUsd8(row.amount, row.symbol, pool.eurc8))}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="display num text-lg font-semibold">
                  {fmtToken(row.amount, 6)} {row.symbol}
                </div>
                <button
                  className="btn-ghost !min-h-11"
                  onClick={() => setSheet({ action: row.kind === 'supply' ? 'withdraw' : 'repay', symbol: row.symbol })}
                >
                  {row.kind === 'supply' ? 'Withdraw' : 'Repay'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Insights pool={pool} user={user} />

      {user.address && <ActivityFeed address={user.address} />}

      <a
        href={buildAddressExplorerUrl(ARC_ID, POOL_ADDRESS)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-flex items-center gap-1 text-xs font-semibold"
        style={{ color: 'var(--accent)' }}
      >
        View the market contract <ExternalLink className="size-3" />
      </a>

      {sheet && <ActionSheet action={sheet.action} symbol={sheet.symbol} pool={pool} user={user} onClose={() => setSheet(null)} />}
    </div>
  )
}
