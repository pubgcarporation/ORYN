import { useState } from 'react'
import { useReadContract } from 'wagmi'
import { ARC_ID, ASSETS, ASSET_LIST, POOL_ADDRESS, fmtAsset, fmtHealth, fmtUsd8, healthTone, poolAbi, valueUsd8, type AssetSymbol } from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'

const TONE_COLOR = { none: 'var(--ink)', safe: 'var(--success)', warn: 'var(--warn)', danger: 'var(--danger)' } as const

export function BorrowSimulator({ pool, user }: { pool: PoolState; user: UserState }) {
  const [symbol, setSymbol] = useState<AssetSymbol>('USDC')
  const [pct, setPct] = useState(0)
  const asset = ASSETS[symbol]
  const maxBorrow = user.assets[symbol].maxBorrow
  const amount = (maxBorrow * BigInt(pct)) / 100n

  const { data: preview } = useReadContract({
    address: POOL_ADDRESS,
    abi: poolAbi,
    functionName: 'previewBorrowLimit',
    args: user.address && amount > 0n ? [user.address, asset.address, amount] : undefined,
    chainId: ARC_ID,
    query: { enabled: Boolean(user.address) && amount > 0n },
  })

  const hasCollateral = user.collateralUsd8 > 0n
  const healthAfter = amount > 0n && preview ? preview[0] : user.healthWad
  const debtAfter = user.debtUsd8 + valueUsd8(amount, symbol, pool.prices)
  const ltvAfter = hasCollateral ? Number((debtAfter * 10_000n) / user.collateralUsd8) / 100 : 0
  const tone = healthTone(healthAfter)

  return (
    <section className="card mt-6 p-5">
      <h2 className="display text-xl font-semibold">Position simulator</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
        Drag to preview how a new borrow changes your health factor and loan-to-value before you sign anything.
      </p>

      {!user.address ? (
        <p className="inner mt-4 p-4 text-sm" style={{ color: 'var(--muted)' }}>
          Connect your wallet to simulate a borrow against your own collateral.
        </p>
      ) : !hasCollateral ? (
        <p className="inner mt-4 p-4 text-sm" style={{ color: 'var(--muted)' }}>
          Deposit USDC, EURC or cirBTC on the Earn page first. Your deposits are your borrowing power.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          <div className="flex gap-2">
            {ASSET_LIST.map((a) => (
              <button
                key={a.symbol}
                className={symbol === a.symbol ? 'btn-primary !min-h-11' : 'btn-ghost !min-h-11'}
                onClick={() => {
                  setSymbol(a.symbol)
                  setPct(0)
                }}
              >
                {a.symbol}
              </button>
            ))}
          </div>

          <div>
            <div className="flex items-baseline justify-between">
              <span className="display num text-3xl font-semibold">
                {fmtAsset(amount, symbol)} <span className="text-base" style={{ color: 'var(--subtle)' }}>{symbol}</span>
              </span>
              <span className="text-xs" style={{ color: 'var(--subtle)' }}>
                Limit {fmtAsset(maxBorrow, symbol)}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={pct}
              disabled={maxBorrow === 0n}
              onChange={(e) => setPct(Number(e.target.value))}
              aria-label="Borrow amount"
              className="mt-3 h-11 w-full"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Cell label="Health factor" value={fmtHealth(healthAfter)} color={TONE_COLOR[tone]} />
            <Cell label="Debt after" value={fmtUsd8(debtAfter)} />
            <Cell label="Loan to value" value={`${ltvAfter.toFixed(1)}%`} />
            <Cell
              label="Liquidation risk"
              value={tone === 'danger' ? 'High' : tone === 'warn' ? 'Medium' : 'Low'}
              color={TONE_COLOR[tone === 'none' ? 'safe' : tone]}
            />
          </div>
          {maxBorrow === 0n && (
            <p className="text-xs" style={{ color: 'var(--subtle)' }}>
              Nothing is borrowable right now. This happens when the market has no liquidity, or a Chainlink price needs a refresh.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function Cell({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="inner p-3">
      <div className="label">{label}</div>
      <div className="display num mt-1 text-lg font-semibold" style={{ color: color ?? 'var(--ink)' }}>
        {value}
      </div>
    </div>
  )
}
