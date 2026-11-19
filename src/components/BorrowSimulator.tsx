import { useMemo, useState } from 'react'
import { ArrowDownToLine, ArrowRight, ArrowUpFromLine, HandCoins, RotateCcw, TriangleAlert, Undo2 } from 'lucide-react'
import { formatUnits } from 'viem'
import { ASSETS, ASSET_LIST, MAX_UINT, fmtAsset, fmtUsd8, parseInput, valueUsd8, type AssetSymbol } from '@/lib/pool'
import { project } from '@/lib/risk'
import { maxFor, simulate, type SimAction, type SimInput, type SimResult } from '@/lib/simulate'
import type { PoolState, UserState } from '@/hooks/usePool'
import { Skeleton, TokenBadge } from '@/components/ui'
import { HealthGauge } from '@/components/simulator/HealthGauge'
import { StressTest } from '@/components/simulator/StressTest'

const ACTIONS: { id: SimAction; label: string; icon: typeof HandCoins; hint: string }[] = [
  { id: 'supply', label: 'Supply', icon: ArrowDownToLine, hint: 'Deposit more collateral' },
  { id: 'borrow', label: 'Borrow', icon: HandCoins, hint: 'Take a new loan' },
  { id: 'withdraw', label: 'Withdraw', icon: ArrowUpFromLine, hint: 'Take collateral out' },
  { id: 'repay', label: 'Repay', icon: Undo2, hint: 'Pay a loan down' },
]

const MAX_LABEL: Record<SimAction, string> = { supply: 'Wallet', borrow: 'Can borrow', withdraw: 'Can withdraw', repay: 'To repay' }

const pctText = (bps: number) => `${(bps / 100).toFixed(1)}%`

export function BorrowSimulator({ pool, user }: { pool: PoolState; user: UserState }) {
  const [action, setAction] = useState<SimAction>('borrow')
  const [symbol, setSymbol] = useState<AssetSymbol>('USDC')
  const [text, setText] = useState('')

  const asset = ASSETS[symbol]
  const max = maxFor(user, action, symbol)
  const parsed = parseInput(text, asset.decimals)
  const amount = parsed ?? 0n

  const base: SimInput = useMemo(() => ({ action, symbol, amount }), [action, symbol, amount])
  const before = useMemo(() => simulate(pool, user, { action, symbol, amount: 0n }), [pool, user, action, symbol])
  const after = useMemo(() => simulate(pool, user, base), [pool, user, base])

  const percent = max > 0n ? Math.min(100, Number((amount * 100n) / max)) : 0
  const setPercent = (p: number) => setText(p === 0 || max === 0n ? '' : trim(formatUnits((max * BigInt(p)) / 100n, asset.decimals)))
  const reset = () => setText('')

  const yearly = (r: SimResult) =>
    project(
      ASSET_LIST.map((a) => {
        const unit = 10 ** a.decimals
        const px = Number(r.prices[a.symbol]) / 1e8
        const reserve = pool.reserves[a.symbol]
        return {
          supplyUsd: (Number(r.supplied[a.symbol]) / unit) * px,
          debtUsd: (Number(r.debt[a.symbol]) / unit) * px,
          supplyApr: Number(reserve.supplyRateApr) / 1e18,
          borrowApr: Number(reserve.borrowRateApr) / 1e18,
        }
      }),
    ).net

  if (!user.address) return <Shell>{note('Connect your wallet to simulate changes to your own position. Nothing is sent onchain.')}</Shell>
  if (!pool.loaded || !user.loaded) {
    return (
      <Shell>
        <Skeleton className="mt-4 h-40 w-full" />
      </Shell>
    )
  }

  const empty = before.collateralUsd8 === 0n && before.debtUsd8 === 0n && user.assets.USDC.walletBalance === 0n && user.assets.EURC.walletBalance === 0n && user.assets.cirBTC.walletBalance === 0n
  if (empty) return <Shell>{note('Your wallet has no balance or position on this market yet. Get test tokens, then come back to try changes before you sign.')}</Shell>

  const over = amount > max
  const unsafe = amount > 0n && after.debtUsd8 > 0n && after.healthWad < 10n ** 18n
  const stale = !pool.priceFresh && (action === 'borrow' || action === 'withdraw')
  const warnings: string[] = []
  if (over) warnings.push(`That is more than you can ${action === 'repay' ? 'repay' : action}: the limit is ${fmtAsset(max, symbol)} ${symbol}.`)
  if (unsafe) warnings.push('After this, the position could be liquidated.')
  if (stale) warnings.push('The pool is waiting for a fresh Chainlink price, so this action is paused onchain right now.')
  if (pool.paused && action === 'borrow') warnings.push('New borrowing is paused.')

  const netNow = yearly(before)
  const netAfter = yearly(after)

  return (
    <Shell live={pool.loaded}>
      {/* Action */}
      <div className="mt-4 grid grid-cols-2 gap-1.5 rounded-2xl p-1.5 sm:grid-cols-4" style={{ background: 'rgba(255,255,255,0.04)' }} role="group" aria-label="What to simulate">
        {ACTIONS.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={action === a.id}
            title={a.hint}
            onClick={() => {
              setAction(a.id)
              reset()
            }}
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold transition-colors ${action === a.id ? 'bg-white/12 text-[var(--ink)] shadow-sm' : 'text-[var(--muted)] hover:bg-white/5'}`}
          >
            <a.icon className="size-4" aria-hidden="true" />
            {a.label}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div className="inner mt-4 p-4 sm:p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex gap-1.5" role="group" aria-label="Asset">
            {ASSET_LIST.map((a) => (
              <button
                key={a.symbol}
                type="button"
                aria-pressed={symbol === a.symbol}
                onClick={() => {
                  setSymbol(a.symbol)
                  reset()
                }}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors ${symbol === a.symbol ? 'border-[var(--border-strong)] bg-white/10' : 'border-[var(--border)] hover:bg-white/5'}`}
              >
                <TokenBadge symbol={a.symbol} size={18} />
                {a.symbol}
              </button>
            ))}
          </div>
          <button type="button" className="num min-h-11 text-right text-xs" style={{ color: 'var(--muted)' }} onClick={() => setPercent(100)} disabled={max === 0n}>
            {MAX_LABEL[action]}: <span style={{ color: 'var(--ink)' }}>{fmtAsset(max, symbol)}</span> <span style={{ color: 'var(--accent)' }}>Max</span>
          </button>
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <input
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-label={`${action} amount in ${symbol}`}
            value={text}
            onChange={(e) => {
              const v = e.target.value.replace(',', '.')
              if (!/^\d*\.?\d*$/.test(v)) return
              const dot = v.indexOf('.')
              if (dot !== -1 && v.length - dot - 1 > asset.decimals) return
              setText(v)
            }}
            className="display num min-w-0 flex-1 bg-transparent text-4xl font-semibold outline-none placeholder:text-white/20"
          />
          <span className="display text-lg font-semibold" style={{ color: 'var(--subtle)' }}>
            {symbol}
          </span>
        </div>
        <div className="num mt-1 min-h-5 text-xs" style={{ color: 'var(--subtle)' }}>
          {amount > 0n ? `≈ ${fmtUsd8(valueUsd8(amount, symbol, pool.prices))}` : '\u00a0'}
        </div>

        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={percent}
          disabled={max === 0n}
          onChange={(e) => setPercent(Number(e.target.value))}
          aria-label={`${action} amount as a share of the limit`}
          className="mt-2 h-11 w-full"
        />
        <div className="flex gap-1.5">
          {[25, 50, 75, 100].map((p) => (
            <button key={p} type="button" disabled={max === 0n} onClick={() => setPercent(p)} className="btn-ghost !min-h-11 flex-1 !px-0 text-xs">
              {p === 100 ? 'Max' : `${p}%`}
            </button>
          ))}
          <button type="button" onClick={reset} disabled={text === ''} aria-label="Clear amount" className="btn-ghost !min-h-11 !min-w-11 !px-0">
            <RotateCcw className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {warnings.length > 0 && (
        <div className="mt-3 space-y-2" role="status">
          {warnings.map((w) => (
            <div key={w} className="flex items-start gap-2 rounded-xl px-3 py-2.5 text-sm" style={{ background: 'rgba(245,197,107,0.1)', color: 'var(--warn)' }}>
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span className="text-pretty">{w}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-4">
        <HealthGauge before={before.healthWad} after={after.healthWad} />
      </div>

      {/* Before and after */}
      <div className="inner mt-4 divide-y divide-white/5 px-4 sm:px-5">
        <Row label="Collateral" a={fmtUsd8(before.collateralUsd8)} b={fmtUsd8(after.collateralUsd8)} same={before.collateralUsd8 === after.collateralUsd8} good={after.collateralUsd8 >= before.collateralUsd8} />
        <Row label="Debt" a={fmtUsd8(before.debtUsd8)} b={fmtUsd8(after.debtUsd8)} same={before.debtUsd8 === after.debtUsd8} good={after.debtUsd8 <= before.debtUsd8} />
        <Row label="Borrow limit used" a={pctText(before.limitUsedBps)} b={pctText(after.limitUsedBps)} same={before.limitUsedBps === after.limitUsedBps} good={after.limitUsedBps <= before.limitUsedBps} />
        <Row label="Loan to value" a={pctText(before.ltvBps)} b={pctText(after.ltvBps)} same={before.ltvBps === after.ltvBps} good={after.ltvBps <= before.ltvBps} />
        <Row label="Left to borrow" a={fmtUsd8(before.availableUsd8)} b={fmtUsd8(after.availableUsd8)} same={before.availableUsd8 === after.availableUsd8} good={after.availableUsd8 >= before.availableUsd8} />
        <Row label="Net interest per year" a={signedUsd(netNow)} b={signedUsd(netAfter)} same={Math.abs(netNow - netAfter) < 0.005} good={netAfter >= netNow} />
      </div>
      <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
        {after.healthWad >= MAX_UINT / 2n ? 'No debt, so there is nothing to liquidate.' : 'Health factor is your liquidation value divided by your debt. Below 1.00 the position can be liquidated.'} Interest uses today's rates.
      </p>

      <div className="mt-4">
        <StressTest pool={pool} user={user} base={base} />
      </div>
    </Shell>
  )
}

function note(text: string) {
  return (
    <p className="inner mt-4 p-4 text-sm" style={{ color: 'var(--muted)' }}>
      {text}
    </p>
  )
}

function Shell({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <section className="card mt-6 p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl font-semibold">Position simulator</h2>
          <p className="mt-1 max-w-md text-pretty text-sm" style={{ color: 'var(--muted)' }}>
            Try a supply, borrow, withdraw or repay and see your health factor before you sign. Nothing is sent onchain.
          </p>
        </div>
        {live && (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: 'rgba(94,224,138,0.12)', color: 'var(--success)' }}>
            <span className="size-1.5 animate-pulse rounded-full motion-reduce:animate-none" style={{ background: 'var(--success)' }} aria-hidden="true" />
            Pool prices
          </span>
        )}
      </div>
      {children}
    </section>
  )
}

function Row({ label, a, b, same, good }: { label: string; a: string; b: string; same: boolean; good: boolean }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 py-2.5 text-sm">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="num flex items-center gap-2">
        {!same && (
          <>
            <span style={{ color: 'var(--subtle)' }}>{a}</span>
            <ArrowRight className="size-3.5" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
          </>
        )}
        <span className="font-semibold" style={{ color: same ? 'var(--ink)' : good ? 'var(--success)' : 'var(--warn)' }}>
          {b}
        </span>
      </span>
    </div>
  )
}

function signedUsd(n: number): string {
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${n < 0 ? '-' : n > 0 ? '+' : ''}$${abs}`
}

/** Drops trailing zeros so a Max fill reads "12.5" and not "12.500000". */
function trim(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value
}
