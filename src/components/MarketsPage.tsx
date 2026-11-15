import { useState } from 'react'
import { ASSET_LIST, fmtApr, fmtBps, fmtToken, fmtUsd8, valueUsd8, type AssetInfo } from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'
import { ActionSheet, type ActionKind } from '@/components/ActionSheet'
import { BorrowSimulator } from '@/components/BorrowSimulator'
import { OracleCard } from '@/components/OracleCard'
import { RateCurve } from '@/components/RateCurve'
import { FundWallet, PageTitle, Skeleton, Stat, TokenBadge } from '@/components/ui'

interface Props {
  mode: 'lend' | 'borrow'
  pool: PoolState
  user: UserState
}

export function MarketsPage({ mode, pool, user }: Props) {
  const [sheet, setSheet] = useState<{ action: ActionKind; symbol: AssetInfo['symbol'] } | null>(null)
  const lend = mode === 'lend'

  const totalUsd = ASSET_LIST.reduce((sum, a) => {
    const r = pool.reserves[a.symbol]
    return sum + valueUsd8(lend ? r.totalSupplied : r.totalBorrowed, a.symbol, pool.eurc8)
  }, 0n)
  const liquidityUsd = ASSET_LIST.reduce(
    (sum, a) => sum + valueUsd8(pool.reserves[a.symbol].availableLiquidity, a.symbol, pool.eurc8),
    0n,
  )

  return (
    <div>
      <PageTitle title={lend ? 'Earn on stablecoins' : 'Borrow against your deposits'}>
        {lend
          ? 'Supply USDC or EURC to earn interest from borrowers. Every deposit also counts as collateral.'
          : 'Borrow USDC or EURC against what you have supplied. Keep your health factor above 1 to avoid liquidation.'}
      </PageTitle>

      {lend && user.address && user.loaded && user.assets.USDC.walletBalance === 0n && user.assets.EURC.walletBalance === 0n && (
        <FundWallet address={user.address} />
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label={lend ? 'Total deposits' : 'Total borrowed'} value={pool.loaded ? fmtUsd8(totalUsd) : '...'} />
        <Stat label="Available liquidity" value={pool.loaded ? fmtUsd8(liquidityUsd) : '...'} />
        <div className="col-span-2 sm:col-span-1">
        <Stat
          label={lend ? 'Your deposits' : 'Your debt'}
          value={user.loaded ? fmtUsd8(lend ? user.collateralUsd8 : user.debtUsd8) : user.address ? '...' : 'Not connected'}
        />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {ASSET_LIST.map((asset) => {
          const r = pool.reserves[asset.symbol]
          const total = lend ? r.totalSupplied : r.totalBorrowed
          const cap = lend ? r.supplyCap : r.borrowCap
          const filled = cap > 0n ? Number((total * 10_000n) / cap) / 100 : 0
          const mine = lend ? user.assets[asset.symbol].supplied : user.assets[asset.symbol].debt
          return (
            <section key={asset.symbol} className="card card-hover p-5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <TokenBadge symbol={asset.symbol} size={36} />
                  <div>
                    <div className="display text-lg font-semibold">{asset.symbol}</div>
                    <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                      {asset.name}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="display num text-2xl font-semibold" style={{ color: 'var(--success)' }}>
                    {pool.loaded ? fmtApr(lend ? r.supplyRateApr : r.borrowRateApr) : <Skeleton className="h-7 w-16" />}
                  </div>
                  <div className="label">{lend ? 'Supply APY' : 'Borrow APY'}</div>
                </div>
              </div>

              <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <Item label={lend ? 'Total deposits' : 'Total borrowed'} value={`${fmtToken(total, asset.decimals)} ${asset.symbol}`} />
                <Item label="Available" value={`${fmtToken(r.availableLiquidity, asset.decimals)} ${asset.symbol}`} />
                <div className="col-span-2">
                  <div className="mb-1 flex justify-between">
                    <dt className="label">Utilization</dt>
                    <dd className="num text-xs font-medium">{(Number(r.utilization / 10n ** 14n) / 100).toFixed(1)}%</dd>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${Math.min(100, Number(r.utilization / 10n ** 14n) / 100)}%`, background: 'var(--accent)' }} />
                  </div>
                </div>
                <Item label={lend ? 'Collateral factor' : 'Max LTV'} value={fmtBps(r.ltv)} />
                <Item label="Liq. threshold" value={fmtBps(r.liquidationThreshold)} />
                <Item label="Cap filled" value={cap > 0n ? `${filled.toFixed(1)}%` : 'No cap'} />
              </dl>

              {user.address && (
                <div className="inner mt-4 flex items-center justify-between px-4 py-3 text-sm">
                  <span style={{ color: 'var(--muted)' }}>{lend ? 'You supplied' : 'You owe'}</span>
                  <span className="num font-semibold">
                    {fmtToken(mine, asset.decimals)} {asset.symbol}
                  </span>
                </div>
              )}

              <div className="mt-4 grid grid-cols-2 gap-2">
                {lend ? (
                  <>
                    <button className="btn-primary" onClick={() => setSheet({ action: 'deposit', symbol: asset.symbol })}>
                      Deposit
                    </button>
                    <button
                      className="btn-ghost !min-h-11"
                      disabled={mine === 0n}
                      onClick={() => setSheet({ action: 'withdraw', symbol: asset.symbol })}
                    >
                      Withdraw
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="btn-primary"
                      disabled={!pool.priceFresh || pool.paused}
                      onClick={() => setSheet({ action: 'borrow', symbol: asset.symbol })}
                    >
                      Borrow
                    </button>
                    <button
                      className="btn-ghost !min-h-11"
                      disabled={mine === 0n}
                      onClick={() => setSheet({ action: 'repay', symbol: asset.symbol })}
                    >
                      Repay
                    </button>
                  </>
                )}
              </div>
            </section>
          )
        })}
      </div>

      {!lend && <BorrowSimulator pool={pool} user={user} />}

      <RateCurve pool={pool} />

      <OracleCard pool={pool} />

      {sheet && <ActionSheet action={sheet.action} symbol={sheet.symbol} pool={pool} user={user} onClose={() => setSheet(null)} />}
    </div>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="num mt-0.5 font-medium">{value}</dd>
    </div>
  )
}
