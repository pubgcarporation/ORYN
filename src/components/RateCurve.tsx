import { useId, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, poolAbi, type AssetSymbol } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'

const W = 420
const H = 170
const PAD = { l: 36, r: 22, t: 10, b: 26 }
const WAD = 1e18

/** Interest rate model of the market: borrow and supply APY across utilization, with today's point marked. */
export function RateCurve({ pool }: { pool: PoolState }) {
  const [symbol, setSymbol] = useState<AssetSymbol>('USDC')
  const gradId = useId()
  const { data } = useReadContracts({
    contracts: [
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'OPTIMAL_UTILIZATION', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'SLOPE1', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'SLOPE2', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'RESERVE_FACTOR', chainId: ARC_ID },
    ],
  })
  const kink = data?.[0]?.result
  const s1 = data?.[1]?.result
  const s2 = data?.[2]?.result
  const rf = data?.[3]?.result
  if (typeof kink !== 'bigint' || typeof s1 !== 'bigint' || typeof s2 !== 'bigint' || typeof rf !== 'bigint') return null

  const optimal = Number(kink) / WAD
  const slope1 = Number(s1) / WAD
  const slope2 = Number(s2) / WAD
  const keep = 1 - Number(rf) / 10_000
  const borrowApr = (u: number) => (u <= optimal ? (slope1 * u) / optimal : slope1 + (slope2 * (u - optimal)) / (1 - optimal))
  const supplyApr = (u: number) => borrowApr(u) * u * keep
  const maxY = borrowApr(1)

  const x = (u: number) => PAD.l + u * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / maxY) * (H - PAD.t - PAD.b)
  const steps = Array.from({ length: 51 }, (_, i) => i / 50)
  const path = (fn: (u: number) => number) => steps.map((u, i) => `${i === 0 ? 'M' : 'L'}${x(u).toFixed(1)},${y(fn(u)).toFixed(1)}`).join(' ')

  const util = Math.min(1, Number(pool.reserves[symbol].utilization) / WAD)
  const ticks = [0, 0.25, 0.5, 0.75, 1]

  return (
    <section className="card mt-6 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl font-semibold">Rate model</h2>
          <p className="mt-1 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
            Rates rise with utilization. Past {(optimal * 100).toFixed(0)}% they climb steeply to keep liquidity available for withdrawals.
          </p>
        </div>
        <div className="flex gap-1.5" role="tablist" aria-label="Market">
          {ASSET_LIST.map((a) => (
            <button
              key={a.symbol}
              role="tab"
              aria-selected={symbol === a.symbol}
              className={symbol === a.symbol ? 'btn-primary !min-h-11 !px-4' : 'btn-ghost !min-h-11'}
              onClick={() => setSymbol(a.symbol)}
            >
              {a.symbol}
            </button>
          ))}
        </div>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-4 w-full" role="img" aria-label="Borrow and supply APY by utilization">
        <defs>
          <linearGradient id={gradId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#b9a6ff" stopOpacity="0.28" />
            <stop offset="100%" stopColor="#b9a6ff" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,0.06)" />
            <text x={x(t)} y={H - 8} fontSize="12" textAnchor="middle" fill="#94a3b8">
              {t * 100}%
            </text>
          </g>
        ))}
        {[0, 0.5, 1].map((t) => (
          <text key={t} x={PAD.l - 6} y={y(maxY * t) + 3} fontSize="12" textAnchor="end" fill="#94a3b8">
            {(maxY * t * 100).toFixed(0)}%
          </text>
        ))}
        <line x1={x(optimal)} x2={x(optimal)} y1={PAD.t} y2={H - PAD.b} stroke="rgba(255,255,255,0.2)" strokeDasharray="3 4" />
        <path d={`${path(borrowApr)} L${x(1)},${H - PAD.b} L${x(0)},${H - PAD.b} Z`} fill={`url(#${gradId})`} />
        <path d={path(borrowApr)} fill="none" stroke="#b9a6ff" strokeWidth="2" strokeLinejoin="round" />
        <path d={path(supplyApr)} fill="none" stroke="#5ee08a" strokeWidth="2" strokeLinejoin="round" />
        <line x1={x(util)} x2={x(util)} y1={PAD.t} y2={H - PAD.b} stroke="#f9faf3" strokeOpacity="0.5" />
        <circle cx={x(util)} cy={y(borrowApr(util))} r="4.5" fill="#b9a6ff" stroke="#0a0814" strokeWidth="2" />
        <circle cx={x(util)} cy={y(supplyApr(util))} r="4.5" fill="#5ee08a" stroke="#0a0814" strokeWidth="2" />
      </svg>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs" style={{ color: 'var(--muted)' }}>
        <Legend color="#b9a6ff" label={`Borrow ${(borrowApr(util) * 100).toFixed(2)}%`} />
        <Legend color="#5ee08a" label={`Supply ${(supplyApr(util) * 100).toFixed(2)}%`} />
        <span>Utilization now {(util * 100).toFixed(1)}%</span>
      </div>
    </section>
  )
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-full" style={{ background: color }} />
      {label}
    </span>
  )
}
