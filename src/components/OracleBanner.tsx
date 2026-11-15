import { AlertCircle } from 'lucide-react'
import type { PoolState } from '@/hooks/usePool'

/** Surfaces the two pool states that change what users can do: paused borrowing and a stale EURC price. */
export function OracleBanner({ pool }: { pool: PoolState }) {
  if (!pool.loaded || (pool.priceFresh && !pool.paused)) return null
  return (
    <div
      className="mb-6 flex items-start gap-2 rounded-2xl p-4 text-sm"
      style={{ background: 'rgba(240,198,116,0.1)', border: '1px solid rgba(240,198,116,0.3)', color: 'var(--warn)' }}
      role="status"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" />
      <span>
        {pool.paused
          ? 'New borrowing is paused. You can still deposit, repay and withdraw.'
          : 'The Chainlink EURC price is out of date, so new borrowing and liquidations are paused. Deposits and repayments still work.'}
      </span>
    </div>
  )
}
