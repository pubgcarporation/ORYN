import { useEffect, useState } from 'react'
import { useReadContracts } from 'wagmi'
import { Clock, ShieldCheck } from 'lucide-react'
import { ARC_ID, POOL_ADDRESS, poolAbi } from '@/lib/pool'
import type { PoolState } from '@/hooks/usePool'

function span(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))} min`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h`
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`
}

/** The EURC price the pool uses, how old it is, and when borrowing pauses if it is not refreshed. */
export function OracleCard({ pool }: { pool: PoolState }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000)
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
  if (typeof updatedAt !== 'bigint' || typeof maxAge !== 'bigint' || pool.eurc8 === 0n) return null

  const age = Math.max(0, now - Number(updatedAt))
  const remaining = Number(maxAge) - age
  const fresh = remaining > 0

  return (
    <section className="card mt-6 p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl font-semibold">Price oracle</h2>
          <p className="mt-1 max-w-md text-sm" style={{ color: 'var(--muted)' }}>
            The pool values EURC with a price set by the market owner. This is a testnet setup, not an independent feed.
          </p>
        </div>
        <span
          className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
          style={{ background: fresh ? 'rgba(141,216,159,0.12)' : 'rgba(240,198,116,0.12)', color: fresh ? 'var(--success)' : 'var(--warn)' }}
        >
          <ShieldCheck className="size-3.5" /> {fresh ? 'Fresh' : 'Stale'}
        </span>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-3">
        <div className="inner p-3">
          <dt className="label">EURC / USD</dt>
          <dd className="display num mt-1 text-lg font-semibold">${(Number(pool.eurc8) / 1e8).toFixed(4)}</dd>
        </div>
        <div className="inner p-3">
          <dt className="label">Last update</dt>
          <dd className="display num mt-1 text-lg font-semibold">{span(age)} ago</dd>
        </div>
        <div className="inner p-3">
          <dt className="label">{fresh ? 'Borrowing pauses in' : 'Borrowing paused'}</dt>
          <dd className="display num mt-1 flex items-center gap-1.5 text-lg font-semibold">
            <Clock className="size-4 shrink-0" style={{ color: 'var(--subtle)' }} />
            {fresh ? span(remaining) : 'Now'}
          </dd>
        </div>
      </dl>
    </section>
  )
}
