import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, useDragControls } from 'framer-motion'
import { ExternalLink, Loader2, X, CheckCircle2, AlertCircle } from 'lucide-react'
import { useAccount, useReadContract, useWriteContract } from 'wagmi'
import { erc20Abi } from 'viem'
import { ConnectCta } from '@/auth/ConnectCta'
import { buildTxExplorerUrl } from '@/onchain-facts'
import {
  ARC_ID,
  ASSETS,
  MAX_UINT,
  POOL_ADDRESS,
  fmtApr,
  fmtAsset,
  fmtBps,
  fmtHealth,
  fmtToken,
  fmtUsd8,
  healthTone,
  parseInput,
  poolAbi,
  type AssetSymbol,
  valueUsd8,
} from '@/lib/pool'
import type { PoolState, UserState } from '@/hooks/usePool'
import { useTx, type TxStep } from '@/hooks/useTx'
import { ARC_GAS_BUFFER, spendable } from '@/lib/gas'
import { TokenBadge } from '@/components/ui'

export type ActionKind = 'deposit' | 'withdraw' | 'borrow' | 'repay'

interface Props {
  action: ActionKind
  symbol: AssetSymbol
  pool: PoolState
  user: UserState
  onClose: () => void
}

const TITLES: Record<ActionKind, string> = {
  deposit: 'Deposit',
  withdraw: 'Withdraw',
  borrow: 'Borrow',
  repay: 'Repay',
}

export function ActionSheet({ action, symbol, pool, user, onClose }: Props) {
  const asset = ASSETS[symbol]
  const reserve = pool.reserves[symbol]
  const position = user.assets[symbol]
  const { isConnected } = useAccount()
  const { writeContractAsync } = useWriteContract()
  const [amount, setAmount] = useState('')
  const tx = useTx(() => {
    user.refetch()
    pool.refetch()
  })

  const raw = parseInput(amount, asset.decimals)

  const max = useMemo(() => {
    switch (action) {
      case 'deposit':
        // Gas on Arc is paid in USDC, so keep a little back when depositing USDC.
        return spendable(position.walletBalance, symbol === 'USDC')
      case 'withdraw':
        return position.maxWithdraw
      case 'borrow':
        return position.maxBorrow
      case 'repay': {
        const wallet = spendable(position.walletBalance, symbol === 'USDC')
        return position.debt < wallet ? position.debt : wallet
      }
    }
  }, [action, symbol, position])

  const { data: preview, isLoading: previewLoading } = useReadContract({
    address: POOL_ADDRESS,
    abi: poolAbi,
    functionName: 'previewBorrowLimit',
    args: user.address && raw ? [user.address, asset.address, raw] : undefined,
    chainId: ARC_ID,
    query: { enabled: action === 'borrow' && Boolean(user.address && raw) },
  })

  const exceeds = raw !== undefined && raw > max
  const needsApproval =
    (action === 'deposit' || action === 'repay') && raw !== undefined && position.allowance < approvalAmount()

  function approvalAmount(): bigint {
    if (raw === undefined) return 0n
    // A full repay pulls the exact accrued debt, which can be a hair above what is shown.
    return action === 'repay' && raw >= position.debt ? raw + raw / 200n + 1n : raw
  }

  const submit = () => {
    if (raw === undefined || exceeds) return
    const steps: TxStep[] = []
    if (needsApproval) {
      steps.push({
        label: `Approve ${symbol}`,
        send: () =>
          writeContractAsync({
            address: asset.address,
            abi: erc20Abi,
            functionName: 'approve',
            args: [POOL_ADDRESS, approvalAmount()],
            chainId: ARC_ID,
          }),
      })
    }
    const full = (action === 'repay' && raw >= position.debt) || (action === 'withdraw' && raw >= position.supplied)
    const value = full ? MAX_UINT : raw
    steps.push({
      label: TITLES[action],
      send: () =>
        writeContractAsync({
          address: POOL_ADDRESS,
          abi: poolAbi,
          functionName: action,
          args: [asset.address, value],
          chainId: ARC_ID,
        }),
    })
    void tx.run(steps)
  }

  const dragControls = useDragControls()

  const dialogRef = useRef<HTMLElement>(null)
  // The button that opened the sheet, read before the amount field grabs focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null))

  // Lock the page behind the sheet, move focus into it, and give focus back to the opener when it closes.
  useEffect(() => {
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    document.body.dataset.sheet = 'open'
    if (!dialogRef.current?.contains(document.activeElement)) dialogRef.current?.focus({ preventScroll: true })
    return () => {
      document.body.style.overflow = previous
      delete document.body.dataset.sheet
      opener?.focus({ preventScroll: true })
    }
  }, [opener])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !tx.busy) return onClose()
      if (e.key !== 'Tab' || !dialogRef.current) return
      // Keep Tab inside the sheet so focus never lands on the page behind it.
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled)')].filter((el) => el.offsetParent !== null)
      if (items.length === 0) return
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, tx.busy])

  const hfAfter = preview?.[0]
  const withinLimit = preview?.[1]
  // The wallet is asked for its health factor after the borrow. Until that answers, the button stays off.
  const checkingLimit = action === 'borrow' && raw !== undefined && !exceeds && previewLoading
  const rate = action === 'borrow' || action === 'repay' ? reserve.borrowRateApr : reserve.supplyRateApr

  let cta = TITLES[action]
  if (raw === undefined) cta = 'Enter an amount'
  else if (exceeds) cta = action === 'deposit' || action === 'repay' ? 'Insufficient balance' : 'Amount too high'
  else if (needsApproval) cta = `Approve and ${TITLES[action].toLowerCase()}`
  else if (action === 'borrow' && withinLimit === false) cta = 'Exceeds borrow limit'
  else if (checkingLimit) cta = 'Checking your borrow limit'

  const blocked =
    raw === undefined || exceeds || checkingLimit || (action === 'borrow' && withinLimit === false) || (action === 'borrow' && pool.paused)

  return (
    <>
      <motion.div
        className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={() => !tx.busy && onClose()}
      >
        <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
        <motion.section
          role="dialog"
          aria-modal="true"
          aria-label={`${TITLES[action]} ${symbol}`}
          ref={dialogRef}
          tabIndex={-1}
          className="card safe-bottom relative max-h-[92dvh] outline-none w-full max-w-md overflow-y-auto overscroll-contain rounded-b-none p-5 pt-3 sm:rounded-3xl"
          style={{ background: 'var(--panel-solid)' }}
          initial={{ y: 60, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 60, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 380, damping: 34 }}
          drag="y"
          dragControls={dragControls}
          dragListener={false}
          dragConstraints={{ top: 0, bottom: 0 }}
          dragElastic={{ top: 0, bottom: 0.6 }}
          onDragEnd={(_, info) => {
            if (!tx.busy && (info.offset.y > 110 || info.velocity.y > 600)) onClose()
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="mx-auto mb-3 flex h-6 w-24 cursor-grab touch-none items-center justify-center sm:hidden"
            onPointerDown={(e) => dragControls.start(e)}
            aria-hidden="true"
          >
            <div className="h-1 w-10 rounded-full bg-white/20" />
          </div>
          <div className="mb-4 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <TokenBadge symbol={symbol} size={28} />
              <h2 className="display text-xl font-semibold">
                {TITLES[action]} {symbol}
              </h2>
            </div>
            <button className="btn-ghost !min-h-11 !min-w-11 !px-0" onClick={onClose} disabled={tx.busy} aria-label="Close">
              <X className="size-4" />
            </button>
          </div>

          {tx.phase === 'success' ? (
            <div className="space-y-4 py-2 text-center">
              <CheckCircle2 className="mx-auto size-10" style={{ color: 'var(--success)' }} />
              <div>
                <p className="display text-lg font-semibold">{TITLES[action]} confirmed</p>
                <p className="mt-1 text-sm" style={{ color: 'var(--muted)' }}>
                  Your positions are updated.
                </p>
              </div>
              {tx.hash && (
                <a
                  href={buildTxExplorerUrl(ARC_ID, tx.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-semibold"
                  style={{ color: 'var(--accent)' }}
                >
                  View on explorer <ExternalLink className="size-3" />
                </a>
              )}
              <button className="btn-primary w-full" onClick={onClose}>
                Done
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="inner p-4">
                <input
                  inputMode="decimal"
                  autoFocus={typeof window !== 'undefined' && !window.matchMedia('(pointer: coarse)').matches}
                  aria-label="Amount"
                  value={amount}
                  disabled={tx.busy}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9.]/g, '')
                    if (/^\d*\.?\d*$/.test(v)) {
                      setAmount(v)
                      if (tx.phase === 'error') tx.reset()
                    }
                  }}
                  placeholder="0.00"
                  className="field text-4xl font-semibold"
                />
                <div className="mt-2 flex items-center justify-between text-xs" style={{ color: 'var(--subtle)' }}>
                  <span>{symbol}</span>
                  <button
                    className="font-semibold disabled:opacity-40"
                    style={{ color: 'var(--accent)' }}
                    disabled={max === 0n || tx.busy}
                    onClick={() => setAmount(fmtToken(max, asset.decimals, asset.decimals).replace(/,/g, ''))}
                  >
                    {action === 'deposit' ? 'Wallet' : action === 'withdraw' ? 'Available' : action === 'borrow' ? 'Limit' : 'Owed'}:{' '}
                    {fmtAsset(max, symbol)} · Max
                  </button>
                </div>
                <div className="mt-3 flex items-center justify-between gap-2">
                  <div className="flex gap-1.5" role="group" aria-label="Quick amounts">
                    {[25, 50, 75].map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        className="chip"
                        disabled={max === 0n || tx.busy}
                        onClick={() => setAmount(fmtToken((max * BigInt(pct)) / 100n, asset.decimals, asset.decimals).replace(/,/g, ''))}
                      >
                        {pct}%
                      </button>
                    ))}
                  </div>
                  <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
                    {raw !== undefined && pool.loaded ? `≈ ${fmtUsd8(valueUsd8(raw, symbol, pool.prices))}` : '\u00a0'}
                  </span>
                </div>
              </div>

              <div className="inner divide-y divide-white/10 text-sm">
                <Row label={action === 'borrow' || action === 'repay' ? 'Borrow APY' : 'Supply APY'} value={fmtApr(rate)} />
                <Row label="Chainlink price" value={pool.loaded ? fmtUsd8(pool.prices[symbol], symbol === 'cirBTC' ? 0 : 4) : '...'} />
                {action === 'deposit' && <Row label="Collateral factor" value={fmtBps(reserve.ltv)} />}
                {action === 'borrow' && (
                  <Row
                    label="Health factor after"
                    value={hfAfter === undefined ? fmtHealth(user.healthWad) : fmtHealth(hfAfter)}
                    tone={healthTone(hfAfter ?? user.healthWad)}
                  />
                )}
                {(action === 'borrow' || action === 'withdraw') && (
                  <Row label="Market liquidity" value={`${fmtAsset(reserve.availableLiquidity, symbol)} ${symbol}`} />
                )}
                {(action === 'repay' || action === 'withdraw') && (
                  <Row
                    label={action === 'repay' ? 'Your debt' : 'Your supply'}
                    value={`${fmtAsset(action === 'repay' ? position.debt : position.supplied, symbol)} ${symbol}`}
                  />
                )}
              </div>

              {(action === 'deposit' || action === 'repay') && symbol === 'USDC' && (
                <p className="text-xs" style={{ color: 'var(--subtle)' }}>
                  Max keeps {fmtToken(ARC_GAS_BUFFER, 6)} USDC in your wallet to pay network fees, which are paid in USDC on Arc.
                </p>
              )}
              {action === 'borrow' && !pool.priceFresh && (
                <Notice>A Chainlink price is out of date, so borrowing is paused until it is refreshed.</Notice>
              )}
              {tx.phase === 'error' && <Notice>{tx.error}</Notice>}

              {!isConnected ? (
                <ConnectCta className="btn-primary w-full" />
              ) : (
                <button className="btn-primary w-full" disabled={blocked || tx.busy} onClick={submit}>
                  {tx.phase === 'wallet' ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Confirm {tx.stepLabel.toLowerCase()} in wallet
                    </>
                  ) : tx.phase === 'confirming' ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Confirming {tx.stepLabel.toLowerCase()}
                    </>
                  ) : (
                    cta
                  )}
                </button>
              )}
            </div>
          )}
        </motion.section>
      </motion.div>
    </>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'none' | 'safe' | 'warn' | 'danger' }) {
  const color =
    tone === 'safe' ? 'var(--success)' : tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : 'var(--ink)'
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="num font-semibold" style={{ color }}>
        {value}
      </span>
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(245,197,107,0.1)', color: 'var(--warn)' }}>
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  )
}
