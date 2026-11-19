import { useEffect, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { CircleCheck, TriangleAlert } from 'lucide-react'
import { ARC_ID, POOL_ADDRESS, poolAbi, type AssetSymbol } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'
import { TokenBadge } from '@/components/ui'

function span(seconds: number): string {
  if (seconds < 90) return 'moments'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3600)
  return h === 0 ? `${d} d` : `${d} d ${h} h`
}

const FEEDS: { symbol: AssetSymbol; pair: string; digits: number }[] = [
  { symbol: 'USDC', pair: 'USDC / USD', digits: 4 },
  { symbol: 'EURC', pair: 'EURC / USD', digits: 4 },
  { symbol: 'cirBTC', pair: 'BTC / USD', digits: 0 },
]

/** The Chainlink prices the pool uses, when each was published, and whether borrowing is open. */
export function OracleCard({ pool }: { pool: PoolState }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000)
    return () => clearInterval(id)
  }, [])
  const { data } = useReadContracts({
    contracts: [
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'priceUpdatedAt', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'maxPriceAge', chainId: ARC_ID },
    ],
    query: { refetchInterval: 30_000 },
  })
  const updatedAt = data?.[0]?.result
  const maxAge = data?.[1]?.result
  if (typeof updatedAt !== 'bigint' || typeof maxAge !== 'bigint' || pool.prices.EURC === 0n) return null

  // How far the pool's own copy is behind live Chainlink, per feed, in percent. Zero when they match.
  const behind = (symbol: AssetSymbol): number => {
    const c = pool.chainlink?.[symbol]
    const p = pool.prices[symbol]
    if (c === undefined || p === 0n) return 0
    return (Math.abs(Number(c - p)) / Number(p)) * 100
  }
  const drift = Math.max(...FEEDS.map(({ symbol }) => behind(symbol)))

  const poolAge = Math.max(0, now - Number(updatedAt))
  const fresh = Number(maxAge) - poolAge > 0 && pool.priceFresh
  const open = fresh && !pool.paused

  return (
    <section className="card mt-6 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl font-semibold">Chainlink prices</h2>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: open ? 'rgba(94,224,138,0.12)' : 'rgba(245,197,107,0.12)', color: open ? 'var(--success)' : 'var(--warn)' }}
        >
          {open ? <CircleCheck className="size-3.5" aria-hidden="true" /> : <TriangleAlert className="size-3.5" aria-hidden="true" />}
          {open ? 'Borrowing open' : 'Borrowing paused'}
        </span>
      </div>

      <ul className="mt-4 grid gap-3 sm:grid-cols-3">
        {FEEDS.map(({ symbol, pair, digits }) => {
          const lag = behind(symbol)
          const synced = lag < 0.0001
          const published = pool.liveUpdatedAt?.[symbol]
          // The copy carries Chainlink's own timestamp, so when the two prices match the time is the same.
          const age = synced && published ? Math.max(0, now - published) : undefined
          return (
            <li key={symbol} className="inner flex items-center gap-3 p-3.5">
              <TokenBadge symbol={symbol} size={32} />
              <div className="min-w-0">
                <div className="label">{pair}</div>
                <div className="display num text-lg font-semibold">${(Number(pool.prices[symbol]) / 1e8).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}</div>
                <div className="num text-[11px]" style={{ color: 'var(--subtle)' }}>
                  {age !== undefined ? `published ${age < 90 ? 'just now' : `${span(age)} ago`}` : synced ? 'pool feed' : `updating, Chainlink is ${lag.toFixed(2)}% away`}
                </div>
              </div>
            </li>
          )
        })}
      </ul>

      <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-pretty" style={{ color: 'var(--muted)' }}>
                <span>
          {open
            ? `Borrowing and liquidations stay open. They pause only if a price goes ${span(Number(maxAge))} without an update. Stablecoin feeds update about once a day, so an older time is normal.`
            : 'Borrowing and liquidations are paused until the pool has fresh prices.'}
        </span>
        {drift >= 0.1 && <span>The pool's copy is {drift.toFixed(2)}% behind live Chainlink until the relayer catches up.</span>}
      </p>
    </section>
  )
}
