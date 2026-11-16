import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ConnectCta } from '@/auth/ConnectCta'
import { ExternalLink, ShieldCheck } from 'lucide-react'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, MAX_UINT, POOL_ADDRESS, fmtApr, fmtAsset, fmtHealth, fmtUsd8, healthTone, valueUsd8, type AssetSymbol } from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'
import { Link } from '@/lib/router'
import { ActionSheet, type ActionKind } from '@/components/ActionSheet'
import { ActivityFeed } from '@/components/ActivityFeed'
import { Insights } from '@/components/Insights'
import { PageTitle, Skeleton, Stat, TokenBadge } from '@/components/ui'

const TONE = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const
const HEALTH_NOTE = {
  none: 'No debt, so nothing can be liquidated.',
  safe: 'Comfortably safe.',
  warn: 'Getting close. Repay or add collateral.',
  danger: 'At risk of liquidation. Repay or add collateral now.',
} as const

/** Health factor as a plain number, capped for the gauge. */
function healthNumber(wad: bigint): number {
  if (wad >= MAX_UINT / 2n) return Infinity
  return Number(wad / 10n ** 12n) / 1_000_000
}

export function PositionsPage({ pool, user }: { pool: PoolState; user: UserState }) {
  const [sheet, setSheet] = useState<{ action: ActionKind; symbol: AssetSymbol } | null>(null)

  if (!user.address) {
    return (
      <div>
        <PageTitle title="Your positions">Every deposit and loan you hold in the market, with live health.</PageTitle>
        <div className="card flex flex-col items-center gap-4 p-10 text-center">
          <ShieldCheck className="size-8" style={{ color: 'var(--accent)' }} aria-hidden="true" />
          <div>
            <p className="display text-lg font-semibold">Connect to see your positions</p>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              Your deposits, loans and health factor show up here as soon as you sign in.
            </p>
          </div>
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
  const hf = healthNumber(user.healthWad)
  const gaugePct = Number.isFinite(hf) ? Math.min(100, (hf / 3) * 100) : 100
  const usedPct = user.borrowLimitUsd8 > 0n ? Math.min(100, Number((user.debtUsd8 * 10_000n) / user.borrowLimitUsd8) / 100) : 0
  const net = user.collateralUsd8 - user.debtUsd8

  return (
    <div>
      <PageTitle title="Your positions">Every deposit and loan you hold in the market, with live health.</PageTitle>

      <section className="card mb-6 p-5 sm:p-6" aria-label="Account health">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">Health factor</div>
            <div className="display num mt-1.5 text-5xl font-semibold" style={{ color: TONE[tone] }}>
              {user.loaded ? fmtHealth(user.healthWad) : <Skeleton className="h-12 w-28" />}
            </div>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              {HEALTH_NOTE[tone]} Liquidated below 1.00.
            </p>
          </div>
          <div className="text-right">
            <div className="label">Net position</div>
            <div className="display num mt-1.5 text-2xl font-semibold">{user.loaded ? fmtUsd8(net) : '...'}</div>
            <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
              Supplied minus borrowed
            </p>
          </div>
        </div>

        <div className="mt-5" role="img" aria-label={`Health factor ${fmtHealth(user.healthWad)}`}>
          <div className="relative h-2.5 rounded-full" style={{ background: 'linear-gradient(90deg, var(--danger) 0%, var(--danger) 33%, var(--warn) 33%, var(--warn) 50%, var(--success) 50%, var(--success) 100%)', opacity: 0.35 }} />
          <div className="relative -mt-[18px] h-[26px]">
            <div
              className="absolute top-0 size-[26px] -translate-x-1/2 rounded-full border-2"
              style={{ left: `clamp(13px, ${gaugePct}%, calc(100% - 13px))`, background: TONE[tone], borderColor: 'var(--bg)', transition: 'left 0.6s ease' }}
            />
          </div>
          <div className="num relative mt-1 h-4 text-[11px]" style={{ color: 'var(--subtle)' }} aria-hidden="true">
            <span className="absolute left-0">0</span>
            <span className="absolute -translate-x-1/2" style={{ left: `${(1 / 3) * 100}%` }}>
              1.0
            </span>
            <span className="absolute -translate-x-1/2" style={{ left: '50%' }}>
              1.5
            </span>
            <span className="absolute right-0">3.0+</span>
          </div>
        </div>
      </section>

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Supplied" value={fmtUsd8(user.collateralUsd8)} />
        <Stat label="Borrowed" value={fmtUsd8(user.debtUsd8)} />
        <div className="col-span-2 sm:col-span-1">
          <Stat label="Borrow limit" value={fmtUsd8(user.borrowLimitUsd8)} sub={user.debtUsd8 > 0n ? `${usedPct.toFixed(1)}% used` : 'Nothing borrowed yet'} />
        </div>
      </div>

      <h2 className="display mb-3 text-xl font-semibold">Open positions</h2>
      {rows.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-8 text-center">
          <p className="text-sm" style={{ color: 'var(--muted)' }}>
            {user.loaded ? 'No open positions yet. Supply an asset in Markets to start earning and unlock borrowing.' : 'Loading your positions...'}
          </p>
          {user.loaded && (
            <Link to="/app/markets" className="btn-primary">
              Go to Markets
            </Link>
          )}
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
                    <span className="num">{fmtApr(row.apr)}</span> {row.kind === 'supply' ? 'earn' : 'borrow'} APY ·{' '}
                    <span className="num">{fmtUsd8(valueUsd8(row.amount, row.symbol, pool.prices))}</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="display num text-lg font-semibold">
                  {fmtAsset(row.amount, row.symbol)} {row.symbol}
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

      <div className="mt-6">
        <Insights pool={pool} user={user} />
      </div>

      <ActivityFeed address={user.address} />

      <a
        href={buildAddressExplorerUrl(ARC_ID, POOL_ADDRESS)}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-6 inline-flex min-h-11 items-center gap-1 text-xs font-semibold"
        style={{ color: 'var(--accent)' }}
      >
        View the market contract <ExternalLink className="size-3" />
      </a>

      <AnimatePresence>{sheet && <ActionSheet key={`${sheet.action}-${sheet.symbol}`} action={sheet.action} symbol={sheet.symbol} pool={pool} user={user} onClose={() => setSheet(null)} />}</AnimatePresence>
    </div>
  )
}
