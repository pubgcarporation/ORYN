import { useState } from 'react'
import { compact } from '@/lib/stats'

export interface BarSeries {
  key: string
  label: string
  color: string
}

export interface BarDatum {
  /** Short label under the bar. */
  label: string
  /** Full label for the tooltip line. */
  title: string
  values: Record<string, number>
}

const W = 560
const H = 200
const PAD = { l: 8, r: 8, t: 12, b: 24 }

/** Stacked daily bars with a hover/focus readout. No data library: plain SVG. */
export function StackedBars({ data, series, format = compact, ariaLabel }: { data: BarDatum[]; series: BarSeries[]; format?: (n: number) => string; ariaLabel: string }) {
  const [active, setActive] = useState<number | null>(null)
  const totals = data.map((d) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0))
  const max = Math.max(...totals, 0)
  const innerW = W - PAD.l - PAD.r
  const innerH = H - PAD.t - PAD.b
  const slot = innerW / Math.max(data.length, 1)
  const barW = Math.min(30, slot * 0.62)
  const everyN = data.length > 10 ? 2 : 1
  const shown = active ?? data.length - 1

  return (
    <div>
      <div className="mb-2 flex min-h-10 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div>
          <span className="display num text-xl font-semibold">{format(totals[shown] ?? 0)}</span>
          <span className="ml-2 text-xs" style={{ color: 'var(--subtle)' }}>
            {data[shown]?.title}
          </span>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label} <span className="num" style={{ color: 'var(--ink-2)' }}>{format(data[shown]?.values[s.key] ?? 0)}</span>
            </span>
          ))}
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={ariaLabel} onMouseLeave={() => setActive(null)}>
        {[0.25, 0.5, 0.75, 1].map((t) => (
          <line key={t} x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH * (1 - t)} y2={PAD.t + innerH * (1 - t)} stroke="rgba(255,255,255,0.06)" />
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={PAD.t + innerH} y2={PAD.t + innerH} stroke="rgba(255,255,255,0.16)" />
        {data.map((d, i) => {
          const x = PAD.l + slot * i + (slot - barW) / 2
          const heights = series.map((sr) => (max > 0 ? ((d.values[sr.key] ?? 0) / max) * innerH : 0))
          const tops = heights.map((_, k) => PAD.t + innerH - heights.slice(0, k + 1).reduce((acc, h) => acc + h, 0))
          return (
            <g key={d.title} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} tabIndex={0} aria-label={`${d.title}: ${format(totals[i])}`} style={{ outline: 'none' }}>
              <rect x={PAD.l + slot * i} y={PAD.t} width={slot} height={innerH} fill={active === i ? 'rgba(255,255,255,0.05)' : 'transparent'} />
              {series.map((sr, k) =>
                heights[k] > 0 ? <rect key={sr.key} x={x} y={tops[k]} width={barW} height={Math.max(heights[k], 1)} fill={sr.color} rx={2} opacity={active === null || active === i ? 1 : 0.55} /> : null,
              )}
              {i % everyN === 0 && (
                <text x={x + barW / 2} y={H - 7} fontSize="11" textAnchor="middle" fill="#94a3b8">
                  {d.label}
                </text>
              )}
            </g>
          )
        })}
        {max === 0 && (
          <text x={W / 2} y={H / 2} fontSize="13" textAnchor="middle" fill="#94a3b8">
            No activity in this period
          </text>
        )}
      </svg>
    </div>
  )
}

/** A single horizontal bar that fills to a share of its track. */
export function ShareBar({ value, color = 'var(--accent)', label }: { value: number; color?: string; label: string }) {
  const pct = Math.max(0, Math.min(100, value))
  return (
    <div className="h-2 overflow-hidden rounded-full bg-white/10" role="img" aria-label={`${label}: ${pct.toFixed(1)}%`}>
      <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  )
}
