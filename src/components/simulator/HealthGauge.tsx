import { healthNumber } from '@/lib/simulate'
import { fmtHealth, healthTone } from '@/lib/pool'

const TONE_COLOR = { none: 'var(--success)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const
const TONE_LABEL = { none: 'No debt', safe: 'Safe', warn: 'Watch closely', danger: 'Liquidation risk' } as const

/** The gauge runs from 0 to 3. A health factor under 1 is liquidatable. */
const SCALE = 3
const pct = (hf: number) => (Number.isFinite(hf) ? Math.min(Math.max(hf, 0), SCALE) / SCALE : 1) * 100

/** Health factor before and after, on a bar with the liquidation line and the safe zone marked. */
export function HealthGauge({ before, after }: { before: bigint; after: bigint }) {
  const tone = healthTone(after)
  const color = TONE_COLOR[tone]
  const changed = before !== after
  const b = healthNumber(before)
  const a = healthNumber(after)

  return (
    <div className="inner p-4 sm:p-5">
      <div className="flex items-end justify-between gap-3">
        <div>
          <div className="label">Health factor</div>
          <div className="display num mt-1 text-4xl font-semibold sm:text-5xl" style={{ color }} aria-live="polite">
            {fmtHealth(after)}
          </div>
        </div>
        <div className="text-right">
          <span
            className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-semibold"
            style={{ background: 'rgba(255,255,255,0.06)', color }}
          >
            {TONE_LABEL[tone]}
          </span>
          {changed && (
            <div className="num mt-1.5 text-xs" style={{ color: 'var(--subtle)' }}>
              from {fmtHealth(before)}
            </div>
          )}
        </div>
      </div>

      <div className="relative mt-5 h-3 rounded-full" role="img" aria-label={`Health factor ${fmtHealth(after)}. Below 1.00 the position can be liquidated.`}>
        <div className="absolute inset-0 flex overflow-hidden rounded-full">
          <div style={{ width: `${pct(1)}%`, background: 'var(--danger)', opacity: 0.55 }} />
          <div style={{ width: `${pct(1.5) - pct(1)}%`, background: 'var(--warn)', opacity: 0.55 }} />
          <div style={{ width: `${100 - pct(1.5)}%`, background: 'var(--success)', opacity: 0.5 }} />
        </div>
        {/* Before marker */}
        {changed && Number.isFinite(b) && (
          <div className="pointer-events-none absolute inset-0 transition-transform duration-300 ease-out motion-reduce:transition-none" style={{ transform: `translateX(${pct(b)}%)` }}>
            <div className="absolute -top-1 h-5 w-0.5 -translate-x-1/2 rounded-full" style={{ background: 'var(--ink)', opacity: 0.45 }} />
          </div>
        )}
        {/* After marker */}
        <div className="pointer-events-none absolute inset-0 transition-transform duration-300 ease-out motion-reduce:transition-none" style={{ transform: `translateX(${pct(a)}%)` }}>
          <div className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2" style={{ background: 'var(--bg)', borderColor: color, boxShadow: `0 0 0 4px ${color}22` }} />
        </div>
      </div>

      <div className="num relative mt-2 h-4 text-[11px]" style={{ color: 'var(--subtle)' }}>
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${pct(1)}%`, color: 'var(--danger)' }}>
          1.0 liquidation
        </span>
        <span className="absolute -translate-x-1/2" style={{ left: `${pct(1.5)}%` }}>
          1.5
        </span>
        <span className="absolute right-0">3+</span>
      </div>
    </div>
  )
}
