import { ASSET_LIST, ASSETS, type AssetSymbol } from '@/lib/pool'
import { liquidationPrice, project } from '@/lib/risk'
import type { PoolState, UserState } from '@/hooks/usePool'

const usd = (n: number, digits = 2) => `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

/** Liquidation price and projected earnings for the connected wallet, from live balances and rates. */
export function Insights({ pool, user }: { pool: PoolState; user: UserState }) {
  const units = (raw: bigint, symbol: AssetSymbol) => Number(raw) / 10 ** ASSETS[symbol].decimals
  const price = (s: AssetSymbol) => Number(pool.prices[s]) / 1e8

  const rows = ASSET_LIST.map((a) => ({
    suppliedUsd: units(user.assets[a.symbol].supplied, a.symbol) * price(a.symbol),
    debtUsd: units(user.assets[a.symbol].debt, a.symbol) * price(a.symbol),
    threshold: Number(pool.reserves[a.symbol].liquidationThreshold) / 10_000,
  }))

  // Show the liquidation price of the volatile asset this wallet has the most exposure to.
  const volatile: AssetSymbol[] = ['cirBTC', 'EURC']
  const exposure = (s: AssetSymbol) => {
    const r = rows[ASSET_LIST.findIndex((a) => a.symbol === s)]
    return r.suppliedUsd + r.debtUsd
  }
  const focus = volatile.reduce((best, s) => (exposure(s) > exposure(best) ? s : best), 'EURC' as AssetSymbol)
  const focusPrice = price(focus)
  const focusDigits = focus === 'cirBTC' ? 0 : 4

  const liq = liquidationPrice({ rows, target: ASSET_LIST.findIndex((a) => a.symbol === focus), price: focusPrice })

  const projection = project(
    ASSET_LIST.map((a) => ({
      supplyUsd: units(user.assets[a.symbol].supplied, a.symbol) * price(a.symbol),
      debtUsd: units(user.assets[a.symbol].debt, a.symbol) * price(a.symbol),
      supplyApr: Number(pool.reserves[a.symbol].supplyRateApr) / 1e18,
      borrowApr: Number(pool.reserves[a.symbol].borrowRateApr) / 1e18,
    })),
  )

  const hasDebt = user.debtUsd8 > 0n
  const hasAny = hasDebt || user.collateralUsd8 > 0n
  if (!hasAny || focusPrice === 0) return null

  return (
    <div className="mb-6 grid gap-3 md:grid-cols-2">
      <section className="card p-5">
        <div className="label">{focus} liquidation price</div>
        {!hasDebt ? (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            You have no debt, so nothing can be liquidated.
          </p>
        ) : liq ? (
          <>
            <div className="display num mt-1.5 text-3xl font-semibold" style={{ color: Math.abs(liq.distance) < 0.1 ? 'var(--danger)' : 'var(--ink)' }}>
              {usd(liq.price, focusDigits)}
            </div>
            <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
              If {focus} goes {liq.direction} this price your health factor drops under 1. That is{' '}
              <span className="num font-semibold" style={{ color: 'var(--ink-2)' }}>
                {Math.abs(liq.distance * 100).toFixed(1)}%
              </span>{' '}
              {liq.distance < 0 ? 'below' : 'above'} today's {usd(focusPrice, focusDigits)}.
            </p>
          </>
        ) : (
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
            Moves in the {focus} price alone cannot push you under a health factor of 1 right now.
          </p>
        )}
      </section>

      <section className="card p-5">
        <div className="label">Projected for 1 year at today's rates</div>
        <div className="mt-2 grid grid-cols-3 gap-3">
          <Figure label="Earn" value={`+${usd(projection.earnedPerYear)}`} tone="var(--success)" />
          <Figure label="Interest" value={`-${usd(projection.interestPerYear)}`} tone="var(--warn)" />
          <Figure label="Net" value={`${projection.net < 0 ? '-' : '+'}${usd(Math.abs(projection.net))}`} tone={projection.net < 0 ? 'var(--danger)' : 'var(--ink)'} />
        </div>
        <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
          Rates change with utilization, so this is an estimate, not a promise.
        </p>
      </section>
    </div>
  )
}

function Figure({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div>
      <div className="display num text-lg font-semibold sm:text-xl" style={{ color: tone }}>
        {value}
      </div>
      <div className="text-xs" style={{ color: 'var(--subtle)' }}>
        {label}
      </div>
    </div>
  )
}
