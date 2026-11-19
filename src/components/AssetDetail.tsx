import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { useReadContracts } from 'wagmi'
import { ARC_ID, ASSETS, POOL_ADDRESS, fmtApr, fmtAsset, fmtBps, fmtHealth, fmtUsd8, healthTone, poolAbi, valueUsd8, type AssetSymbol } from '@/lib/pool'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import type { PoolState, UserState } from '@/hooks/usePool'
import { ActionSheet, type ActionKind } from '@/components/ActionSheet'
import { Skeleton, Stat, TokenBadge } from '@/components/ui'
import { Link } from '@/lib/router'

const TONE = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const
/** The share of interest that goes to the protocol instead of suppliers. Fixed in the contract. */
const RESERVE_FACTOR_BPS = 1_000

interface Props {
  symbol: AssetSymbol
  pool: PoolState
  user: UserState
}

/** Everything about one market: its numbers, its risk settings, and where your own position sits. */
export function AssetDetail({ symbol, pool, user }: Props) {
  const [sheet, setSheet] = useState<ActionKind | null>(null)
  const asset = ASSETS[symbol]
  const r = pool.reserves[symbol]
  const mine = user.assets[symbol]
  const price = pool.prices[symbol]
  const loaded = pool.loaded

  const { data: tokens } = useReadContracts({
    contracts: [
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'aToken', args: [asset.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'debtToken', args: [asset.address], chainId: ARC_ID },
    ],
  })
  const aToken = tokens?.[0]?.result
  const debtToken = tokens?.[1]?.result

  const util = Math.min(100, Number(r.utilization / 10n ** 14n) / 100)
  const usd = (raw: bigint) => fmtUsd8(valueUsd8(raw, symbol, pool.prices))
  const cap = (raw: bigint) => (raw === 0n ? 'No cap' : `${fmtAsset(raw, symbol)} ${symbol}`)

  // Your account as a whole: LTV is measured across everything you supplied and borrowed.
  const hasPosition = user.collateralUsd8 > 0n
  const toPct = (num: bigint, den: bigint) => (den === 0n ? 0 : Number((num * 10_000n) / den) / 100)
  const accountLtv = toPct(user.debtUsd8, user.collateralUsd8)
  const accountMaxLtv = toPct(user.borrowLimitUsd8, user.collateralUsd8)
  const accountLiqLtv = toPct(user.liquidationUsd8, user.collateralUsd8)
  const tone = healthTone(user.healthWad)

  return (
    <div>
      <Link to="/app/markets" className="mb-4 inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold" style={{ color: 'var(--accent)' }}>
        <ArrowLeft className="size-4" aria-hidden="true" /> Markets
      </Link>

      <header className="card flex flex-wrap items-center justify-between gap-4 p-5">
        <div className="flex items-center gap-3">
          <TokenBadge symbol={symbol} size={48} />
          <div>
            <h1 className="display text-3xl font-semibold">{symbol}</h1>
            <p className="text-sm" style={{ color: 'var(--subtle)' }}>
              {asset.name}
            </p>
          </div>
        </div>
        <div className="text-right">
          <div className="label">Price</div>
          <div className="display num text-3xl font-semibold">{loaded ? fmtUsd8(price, symbol === 'cirBTC' ? 0 : 4) : <Skeleton className="ml-auto h-8 w-28" />}</div>
        </div>
      </header>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Total supplied" value={loaded ? `${fmtAsset(r.totalSupplied, symbol)}` : '...'} sub={loaded ? usd(r.totalSupplied) : undefined} />
        <Stat label="Total borrowed" value={loaded ? `${fmtAsset(r.totalBorrowed, symbol)}` : '...'} sub={loaded ? usd(r.totalBorrowed) : undefined} />
        <Stat label="Available liquidity" value={loaded ? `${fmtAsset(r.availableLiquidity, symbol)}` : '...'} sub={loaded ? usd(r.availableLiquidity) : undefined} />
        <Stat label="Utilization" value={loaded ? `${util.toFixed(1)}%` : '...'} sub="Borrowed share of supplied" />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <section className="card p-5">
          <h2 className="display text-xl font-semibold">Interest rates</h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="inner p-3">
              <div className="label">Supply APY</div>
              <div className="display num mt-1 text-2xl font-semibold" style={{ color: 'var(--success)' }}>
                {loaded ? fmtApr(r.supplyRateApr) : '...'}
              </div>
            </div>
            <div className="inner p-3">
              <div className="label">Borrow APY</div>
              <div className="display num mt-1 text-2xl font-semibold">{loaded ? fmtApr(r.borrowRateApr) : '...'}</div>
            </div>
          </div>
          <dl className="mt-4 space-y-2 text-sm">
            <Row label="Reserve factor" value={fmtBps(BigInt(RESERVE_FACTOR_BPS))} hint="Share of borrower interest kept by the protocol" />
            <Row label="Supply cap" value={loaded ? cap(r.supplyCap) : '...'} />
            <Row label="Borrow cap" value={loaded ? cap(r.borrowCap) : '...'} />
          </dl>
        </section>

        <section className="card p-5">
          <h2 className="display text-xl font-semibold">Risk parameters</h2>
          <div className="mt-4 grid grid-cols-3 gap-3">
            <div className="inner p-3">
              <div className="label">Max LTV</div>
              <div className="display num mt-1 text-xl font-semibold">{loaded ? fmtBps(r.ltv) : '...'}</div>
            </div>
            <div className="inner p-3">
              <div className="label">Liq. threshold</div>
              <div className="display num mt-1 text-xl font-semibold">{loaded ? fmtBps(r.liquidationThreshold) : '...'}</div>
            </div>
            <div className="inner p-3">
              <div className="label">Liq. bonus</div>
              <div className="display num mt-1 text-xl font-semibold">{loaded ? fmtBps(r.liquidationBonus) : '...'}</div>
            </div>
          </div>
          {loaded && <LtvBar max={Number(r.ltv) / 100} liq={Number(r.liquidationThreshold) / 100} />}
          <ul className="mt-4 space-y-1.5 text-xs" style={{ color: 'var(--muted)' }}>
            <li>
              <strong style={{ color: 'var(--ink)' }}>Max LTV</strong>: you can borrow up to this share of what you supply of {symbol}.
            </li>
            <li>
              <strong style={{ color: 'var(--ink)' }}>Liquidation threshold</strong>: if debt reaches this share of your collateral, your position can be liquidated.
            </li>
            <li>
              <strong style={{ color: 'var(--ink)' }}>Liquidation bonus</strong>: the extra collateral a liquidator earns for repaying a loan.
            </li>
          </ul>
        </section>
      </div>

      <section className="card mt-4 p-5">
        <h2 className="display text-xl font-semibold">Your position</h2>
        {!user.address ? (
          <p className="mt-3 text-sm" style={{ color: 'var(--muted)' }}>
            Connect your wallet to see your {symbol} position and where your loan-to-value sits.
          </p>
        ) : !user.loaded ? (
          <Skeleton className="mt-3 h-24 w-full" />
        ) : (
          <>
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Wallet balance" value={fmtAsset(mine.walletBalance, symbol)} sub={usd(mine.walletBalance)} />
              <Stat label="Supplied" value={fmtAsset(mine.supplied, symbol)} sub={usd(mine.supplied)} />
              <Stat label="Owed" value={fmtAsset(mine.debt, symbol)} sub={usd(mine.debt)} />
              <Stat label="You can borrow" value={fmtAsset(mine.maxBorrow, symbol)} sub={usd(mine.maxBorrow)} />
            </div>

            {hasPosition ? (
              <div className="inner mt-4 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className="label">Your account LTV</div>
                    <div className="display num text-3xl font-semibold" style={{ color: TONE[tone] }}>
                      {accountLtv.toFixed(1)}%
                    </div>
                  </div>
                  <div className="text-right text-xs" style={{ color: 'var(--muted)' }}>
                    <div>
                      Health factor <span className="num font-semibold" style={{ color: TONE[tone] }}>{fmtHealth(user.healthWad)}</span>
                    </div>
                    <div>Across everything you supplied and borrowed</div>
                  </div>
                </div>
                <LtvBar max={accountMaxLtv} liq={accountLiqLtv} current={accountLtv} />
                <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
                  Your account can borrow up to {accountMaxLtv.toFixed(1)}% of its collateral and is liquidated at {accountLiqLtv.toFixed(1)}%. These blend the settings of each asset you supplied.
                </p>
              </div>
            ) : (
              <p className="mt-4 text-sm" style={{ color: 'var(--muted)' }}>
                You have nothing supplied yet. Supply {symbol} to start earning and to borrow against it.
              </p>
            )}
          </>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <button className="btn-primary" onClick={() => setSheet('deposit')}>
            Supply
          </button>
          <button className="btn-ghost !min-h-11" disabled={mine.supplied === 0n} onClick={() => setSheet('withdraw')}>
            Withdraw
          </button>
          <button className="btn-ghost !min-h-11" disabled={!pool.priceFresh || pool.paused} onClick={() => setSheet('borrow')}>
            Borrow
          </button>
          <button className="btn-ghost !min-h-11" disabled={mine.debt === 0n} onClick={() => setSheet('repay')}>
            Repay
          </button>
        </div>
      </section>

      <section className="card mt-4 p-5">
        <h2 className="display text-xl font-semibold">Contracts</h2>
        <dl className="mt-3 space-y-2 text-sm">
          <AddressRow label={`${symbol} token`} address={asset.address} />
          <AddressRow label={`a${symbol} (supply receipt)`} address={aToken} />
          <AddressRow label={`d${symbol} (debt receipt)`} address={debtToken} />
          <AddressRow label="Market contract" address={POOL_ADDRESS} />
        </dl>
      </section>

      <AnimatePresence>{sheet && <ActionSheet key={sheet} action={sheet} symbol={symbol} pool={pool} user={user} onClose={() => setSheet(null)} />}</AnimatePresence>
    </div>
  )
}

function Row({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt style={{ color: 'var(--muted)' }}>
        {label}
        {hint && (
          <span className="block text-xs" style={{ color: 'var(--subtle)' }}>
            {hint}
          </span>
        )}
      </dt>
      <dd className="num text-right font-medium">{value}</dd>
    </div>
  )
}

function AddressRow({ label, address }: { label: string; address: string | undefined }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="min-w-0">
        {address ? (
          <a
            href={buildAddressExplorerUrl(ARC_ID, address)}
            target="_blank"
            rel="noopener noreferrer"
            className="mono inline-flex items-center gap-1 text-xs font-semibold"
            style={{ color: 'var(--accent)' }}
          >
            {address.slice(0, 6)}...{address.slice(-4)} <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : (
          <Skeleton className="h-4 w-24" />
        )}
      </dd>
    </div>
  )
}

/**
 * A 0 to 100% track: green up to the max LTV, amber up to the liquidation threshold, red beyond it.
 * A marker shows where an account currently sits.
 */
function LtvBar({ max, liq, current }: { max: number; liq: number; current?: number }) {
  const clamp = (n: number) => Math.max(0, Math.min(100, n))
  const m = clamp(max)
  const l = clamp(liq)
  return (
    <div className="mt-4" role="img" aria-label={`Max LTV ${m.toFixed(0)}%, liquidation threshold ${l.toFixed(0)}%${current !== undefined ? `, currently ${current.toFixed(1)}%` : ''}`}>
      <div className="relative h-3 overflow-hidden rounded-full">
        <div className="absolute inset-y-0 left-0" style={{ width: `${m}%`, background: 'rgba(94,224,138,0.55)' }} />
        <div className="absolute inset-y-0" style={{ left: `${m}%`, width: `${Math.max(0, l - m)}%`, background: 'rgba(245,197,107,0.6)' }} />
        <div className="absolute inset-y-0 right-0" style={{ left: `${l}%`, background: 'rgba(255,122,138,0.55)' }} />
        {current !== undefined && (
          <div className="absolute inset-y-0 w-0.5" style={{ left: `${clamp(current)}%`, background: 'var(--ink)', boxShadow: '0 0 0 2px rgba(0,0,0,0.5)' }} />
        )}
      </div>
      <div className="num mt-1.5 flex justify-between text-[11px]" style={{ color: 'var(--subtle)' }}>
        <span>0%</span>
        <span>Max LTV {m.toFixed(0)}%</span>
        <span>Liquidation {l.toFixed(0)}%</span>
        <span>100%</span>
      </div>
    </div>
  )
}
