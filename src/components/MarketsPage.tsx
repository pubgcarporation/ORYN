import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { Info } from 'lucide-react'
import { ASSET_LIST, fmtApr, fmtAsset, fmtUsd8, valueUsd8, type AssetInfo } from '@/lib/pool'
import { Link, usePath } from '@/lib/router'
import { AssetDetail } from '@/components/AssetDetail'
import type { PoolState, UserState } from '@/hooks/usePool'
import { ActionSheet, type ActionKind } from '@/components/ActionSheet'
import { BorrowSimulator } from '@/components/BorrowSimulator'
import { OracleCard } from '@/components/OracleCard'
import { RateCurve } from '@/components/RateCurve'
import { FundWallet, PageTitle, Skeleton, Stat, TokenBadge } from '@/components/ui'

interface Props {
  pool: PoolState
  user: UserState
}

export function MarketsPage({ pool, user }: Props) {
  const [sheet, setSheet] = useState<{ action: ActionKind; symbol: AssetInfo['symbol'] } | null>(null)
  // /app/markets/usdc opens that asset's detail page.
  const slug = usePath().split('/')[3]?.toLowerCase()
  const detail = ASSET_LIST.find((a) => a.symbol.toLowerCase() === slug)
  if (detail) return <AssetDetail symbol={detail.symbol} pool={pool} user={user} />

  const sum = (pick: (symbol: AssetInfo['symbol']) => bigint) => ASSET_LIST.reduce((acc, a) => acc + valueUsd8(pick(a.symbol), a.symbol, pool.prices), 0n)
  const supplyUsd = sum((s) => pool.reserves[s].totalSupplied)
  const borrowUsd = sum((s) => pool.reserves[s].totalBorrowed)
  const liquidityUsd = sum((s) => pool.reserves[s].availableLiquidity)
  const wallet = user.assets

  return (
    <div>
      <PageTitle title="Markets" />

      {user.address && user.loaded && wallet.USDC.walletBalance === 0n && wallet.EURC.walletBalance === 0n && wallet.cirBTC.walletBalance === 0n && (
        <FundWallet address={user.address} />
      )}
      {user.address && user.loaded && wallet.cirBTC.walletBalance === 0n && (
        <p className="mb-4 flex items-start gap-2 text-xs" style={{ color: 'var(--subtle)' }}>
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>cirBTC has no public faucet yet, so you can only supply it with a balance sent from a wallet that already holds some.</span>
        </p>
      )}

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total supplied" value={pool.loaded ? fmtUsd8(supplyUsd) : '...'} />
        <Stat label="Total borrowed" value={pool.loaded ? fmtUsd8(borrowUsd) : '...'} />
        <Stat label="Available liquidity" value={pool.loaded ? fmtUsd8(liquidityUsd) : '...'} />
        <Stat
          label="Your supplied / owed"
          value={user.loaded ? `${fmtUsd8(user.collateralUsd8)} / ${fmtUsd8(user.debtUsd8)}` : user.address ? '...' : 'Not connected'}
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {ASSET_LIST.map((asset) => {
          const r = pool.reserves[asset.symbol]
          const mine = user.assets[asset.symbol]
          const util = Math.min(100, Number(r.utilization / 10n ** 14n) / 100)
          return (
            <section key={asset.symbol} className="card card-hover relative p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <TokenBadge symbol={asset.symbol} size={36} />
                  <div>
                    {/* The whole card is clickable through this link; the buttons below sit above it. */}
                    <Link
                      to={`/app/markets/${asset.symbol.toLowerCase()}`}
                      aria-label={`${asset.symbol} market details`}
                      className="display block rounded-lg text-lg font-semibold after:absolute after:inset-0 after:rounded-3xl after:content-['']"
                    >
                      {asset.symbol}
                    </Link>
                    <div className="text-xs" style={{ color: 'var(--subtle)' }}>
                      {asset.name}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="display num text-lg font-semibold">
                    {pool.loaded ? fmtUsd8(pool.prices[asset.symbol], asset.symbol === 'cirBTC' ? 0 : 4) : <Skeleton className="ml-auto h-6 w-16" />}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="inner p-3">
                  <div className="label">Supply APY</div>
                  <div className="display num mt-1 text-xl font-semibold" style={{ color: 'var(--success)' }}>
                    {pool.loaded ? fmtApr(r.supplyRateApr) : '...'}
                  </div>
                </div>
                <div className="inner p-3">
                  <div className="label">Borrow APY</div>
                  <div className="display num mt-1 text-xl font-semibold">{pool.loaded ? fmtApr(r.borrowRateApr) : '...'}</div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3 text-sm">
                <div>
                  <span className="label">Available </span>
                  <span className="num font-medium">{fmtAsset(r.availableLiquidity, asset.symbol)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="label">Util.</span>
                  <div className="h-1.5 w-16 overflow-hidden rounded-full bg-white/10">
                    <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${util}%`, background: 'var(--accent)' }} />
                  </div>
                  <span className="num text-xs font-medium">{util.toFixed(0)}%</span>
                </div>
              </div>

              {user.address && (mine.supplied > 0n || mine.debt > 0n) && (
                <div className="mt-3 flex justify-between text-xs" style={{ color: 'var(--muted)' }}>
                  <span>
                    Supplied <span className="num font-semibold" style={{ color: 'var(--ink)' }}>{fmtAsset(mine.supplied, asset.symbol)}</span>
                  </span>
                  <span>
                    Owed <span className="num font-semibold" style={{ color: 'var(--ink)' }}>{fmtAsset(mine.debt, asset.symbol)}</span>
                  </span>
                </div>
              )}

              <div className="relative z-10 mt-3 grid grid-cols-2 gap-2">
                <button className="btn-primary" onClick={() => setSheet({ action: 'deposit', symbol: asset.symbol })}>
                  Supply
                </button>
                <button className="btn-ghost !min-h-11" disabled={mine.supplied === 0n} onClick={() => setSheet({ action: 'withdraw', symbol: asset.symbol })}>
                  Withdraw
                </button>
                <button
                  className="btn-ghost !min-h-11"
                  disabled={!pool.priceFresh || pool.paused}
                  onClick={() => setSheet({ action: 'borrow', symbol: asset.symbol })}
                >
                  Borrow
                </button>
                <button className="btn-ghost !min-h-11" disabled={mine.debt === 0n} onClick={() => setSheet({ action: 'repay', symbol: asset.symbol })}>
                  Repay
                </button>
              </div>
            </section>
          )
        })}
      </div>

      <BorrowSimulator pool={pool} user={user} />

      <RateCurve pool={pool} />

      <OracleCard pool={pool} />

      <AnimatePresence>{sheet && <ActionSheet key={`${sheet.action}-${sheet.symbol}`} action={sheet.action} symbol={sheet.symbol} pool={pool} user={user} onClose={() => setSheet(null)} />}</AnimatePresence>
    </div>
  )
}
