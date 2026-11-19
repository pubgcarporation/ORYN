import { useMemo, useState } from 'react'
import { ASSET_LIST, fmtHealth, fmtUsd8, healthTone, type AssetSymbol } from '@/lib/pool'
import { liquidationPrice } from '@/lib/risk'
import { simulate, type SimInput } from '@/lib/simulate'
import type { PoolState, UserState } from '@/hooks/usePool'
import { TokenBadge } from '@/components/ui'

const TONE_COLOR = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const

const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : 4 })}`

/** What happens to the position if one asset's price moves, on top of the action being simulated. */
export function StressTest({ pool, user, base }: { pool: PoolState; user: UserState; base: SimInput }) {
  const [symbol, setSymbol] = useState<AssetSymbol>('cirBTC')
  const [move, setMove] = useState(0)

  const after = useMemo(() => simulate(pool, user, base), [pool, user, base])
  const stressed = useMemo(() => simulate(pool, user, { ...base, shock: { symbol, bps: move * 100 } }), [pool, user, base, symbol, move])

  const price = Number(pool.prices[symbol]) / 1e8
  const shocked = price * (1 + move / 100)
  const tone = healthTone(stressed.healthWad)

  const liq = useMemo(() => {
    const rows = ASSET_LIST.map((a) => {
      const unit = 10 ** a.decimals
      const p = Number(after.prices[a.symbol]) / 1e8
      return {
        suppliedUsd: (Number(after.supplied[a.symbol]) / unit) * p,
        debtUsd: (Number(after.debt[a.symbol]) / unit) * p,
        threshold: Number(pool.reserves[a.symbol].liquidationThreshold) / 10_000,
      }
    })
    return liquidationPrice({ rows, target: ASSET_LIST.findIndex((a) => a.symbol === symbol), price })
  }, [after, pool.reserves, symbol, price])

  const hasExposure = after.collateralUsd8 > 0n || after.debtUsd8 > 0n

  return (
    <div className="inner p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="label">Price stress test</div>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
            Move one price and see your health factor.
          </p>
        </div>
        <div className="flex gap-1.5" role="group" aria-label="Asset to stress">
          {ASSET_LIST.map((a) => (
            <button
              key={a.symbol}
              type="button"
              aria-pressed={symbol === a.symbol}
              onClick={() => setSymbol(a.symbol)}
              className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${symbol === a.symbol ? 'border-[var(--border-strong)] bg-white/10' : 'border-[var(--border)] hover:bg-white/5'}`}
            >
              <TokenBadge symbol={a.symbol} size={16} />
              {a.symbol}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 flex items-baseline justify-between gap-3">
        <div className="display num text-2xl font-semibold">{money(shocked)}</div>
        <div className="num text-sm font-semibold" style={{ color: move === 0 ? 'var(--subtle)' : move < 0 ? 'var(--danger)' : 'var(--success)' }}>
          {move > 0 ? '+' : ''}
          {move}%
        </div>
      </div>
      <input
        type="range"
        min={-60}
        max={60}
        step={1}
        value={move}
        onChange={(e) => setMove(Number(e.target.value))}
        aria-label={`${symbol} price change in percent`}
        className="mt-2 h-11 w-full"
      />
      <div className="num -mt-1 flex justify-between text-[11px]" style={{ color: 'var(--subtle)' }}>
        <span>-60%</span>
        <button type="button" className="min-h-6 underline-offset-2 hover:underline" onClick={() => setMove(0)} disabled={move === 0}>
          now {money(price)}
        </button>
        <span>+60%</span>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="label">Health at this price</div>
          <div className="display num mt-1 text-xl font-semibold" style={{ color: TONE_COLOR[tone] }}>
            {fmtHealth(stressed.healthWad)}
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: 'rgba(255,255,255,0.04)' }}>
          <div className="label">Liquidated at</div>
          <div className="display num mt-1 text-xl font-semibold">{liq ? money(liq.price) : 'Not at risk'}</div>
          <div className="num mt-0.5 text-[11px]" style={{ color: 'var(--subtle)' }}>
            {liq ? `${liq.direction === 'below' ? 'falls' : 'rises'} ${Math.abs(liq.distance * 100).toFixed(1)}% from now` : 'this price alone cannot do it'}
          </div>
        </div>
      </div>

      {!hasExposure && (
        <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
          You have no deposits or loans yet, so price moves change nothing.
        </p>
      )}
      {hasExposure && stressed.debtUsd8 > 0n && (
        <p className="num mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
          Collateral {fmtUsd8(stressed.collateralUsd8)} · Debt {fmtUsd8(stressed.debtUsd8)} at this price.
        </p>
      )}
    </div>
  )
}
