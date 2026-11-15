import { useState } from 'react'
import { AppKit, type SwapEstimate, type SwapResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type EIP1193Provider } from 'viem'
import { AlertCircle, ArrowDownUp, CheckCircle2, ExternalLink, Loader2, SlidersHorizontal } from 'lucide-react'
import { NetworkArc } from '@web3icons/react'
import { useAccount, useReadContracts, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { ARC_ID, ASSETS, fmtToken, parseInput, type AssetSymbol } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { Picker, type PickerOption } from '@/components/Picker'
import { TokenBadge } from '@/components/ui'

const kit = new AppKit()
const SLIPPAGE_OPTIONS = [50, 100, 200]
/** The tokens the swap route supports on Arc Testnet. */
const SWAP_TOKENS: AssetSymbol[] = ['USDC', 'EURC']

interface Reviewed {
  estimate: SwapEstimate
  tokenIn: AssetSymbol
  tokenOut: AssetSymbol
  amount: string
  slippageBps: number
  account: string | undefined
}

export function SwapPage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [tokenIn, setTokenIn] = useState<AssetSymbol>('USDC')
  const [tokenOut, setTokenOut] = useState<AssetSymbol>('EURC')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(100)
  const [showSettings, setShowSettings] = useState(false)
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [busy, setBusy] = useState<'quote' | 'swap' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SwapResult | null>(null)

  const inAsset = ASSETS[tokenIn]
  const raw = parseInput(amount, inAsset.decimals)

  const { data: balances, refetch } = useReadContracts({
    contracts: SWAP_TOKENS.map((s) => ({
      address: ASSETS[s].address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
      chainId: ARC_ID,
    })),
    query: { enabled: Boolean(address), refetchInterval: 8000 },
  })
  const balanceOf = (s: AssetSymbol): bigint => {
    const v = balances?.[SWAP_TOKENS.indexOf(s)]?.result
    return typeof v === 'bigint' ? v : 0n
  }
  const bal = balanceOf(tokenIn)
  const usable = spendable(bal, tokenIn === 'USDC')
  const insufficient = raw !== undefined && raw > bal
  const needsFees = raw !== undefined && !insufficient && raw > usable

  const resetQuote = () => {
    setReviewed(null)
    setResult(null)
    setError(null)
  }

  const options: PickerOption<AssetSymbol>[] = SWAP_TOKENS.map((s) => ({
    id: s,
    label: s,
    sub: ASSETS[s].name,
    right: address ? fmtToken(balanceOf(s), ASSETS[s].decimals) : undefined,
    icon: <TokenBadge symbol={s} size={28} />,
  }))

  const pickIn = (s: AssetSymbol) => {
    if (s === tokenOut) setTokenOut(tokenIn)
    setTokenIn(s)
    setAmount('')
    resetQuote()
  }
  const pickOut = (s: AssetSymbol) => {
    if (s === tokenIn) setTokenIn(tokenOut)
    setTokenOut(s)
    setAmount('')
    resetQuote()
  }
  const flip = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmount('')
    resetQuote()
  }

  const getAdapter = async () => {
    if (!connector) throw new Error('Wallet not connected')
    if (chainId !== ARC_ID) await switchChainAsync({ chainId: ARC_ID })
    const provider = (await connector.getProvider()) as EIP1193Provider
    return createViemAdapterFromProvider({ provider })
  }

  const review = async () => {
    setBusy('quote')
    setError(null)
    setResult(null)
    try {
      const adapter = await getAdapter()
      const estimate = await kit.estimateSwap({
        from: { adapter, chain: 'Arc_Testnet' },
        tokenIn,
        tokenOut,
        amountIn: amount,
        config: { slippageBps },
      })
      setReviewed({ estimate, tokenIn, tokenOut, amount, slippageBps, account: address })
    } catch (e) {
      setReviewed(null)
      setError(swapError(e))
    } finally {
      setBusy(null)
    }
  }

  const execute = async () => {
    if (!reviewed) return
    if (reviewed.account !== address) {
      setError('Your wallet account changed. Review the quote again.')
      setReviewed(null)
      return
    }
    setBusy('swap')
    setError(null)
    try {
      const adapter = await getAdapter()
      const res = await kit.swap({
        from: { adapter, chain: 'Arc_Testnet' },
        tokenIn: reviewed.tokenIn,
        tokenOut: reviewed.tokenOut,
        amountIn: reviewed.amount,
        config: { slippageBps: reviewed.slippageBps },
      })
      setResult(res)
      setReviewed(null)
      setAmount('')
      void refetch()
    } catch (e) {
      setError(swapError(e))
    } finally {
      setBusy(null)
    }
  }

  const output = reviewed ? Number(reviewed.estimate.estimatedOutput.amount) : undefined
  const rate = reviewed && output !== undefined && Number(reviewed.amount) > 0 ? output / Number(reviewed.amount) : undefined

  return (
    <div className="mx-auto max-w-md">
      <section className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="display text-2xl font-semibold">Swap</h1>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: 'var(--surface-strong)' }}>
              <NetworkArc variant="branded" size={16} /> Arc Testnet
            </span>
            <button
              className="btn-ghost !min-h-11 !min-w-11 !px-0"
              aria-label="Slippage settings"
              aria-expanded={showSettings}
              onClick={() => setShowSettings((v) => !v)}
            >
              <SlidersHorizontal className="size-4" />
            </button>
          </div>
        </div>

        {showSettings && (
          <div className="inner mb-3 flex items-center justify-between gap-3 p-3">
            <span className="text-sm" style={{ color: 'var(--muted)' }}>
              Slippage
            </span>
            <div className="flex gap-1.5" role="group" aria-label="Slippage tolerance">
              {SLIPPAGE_OPTIONS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  disabled={busy !== null}
                  aria-pressed={slippageBps === bps}
                  onClick={() => {
                    setSlippageBps(bps)
                    resetQuote()
                  }}
                  className="chip"
                  style={slippageBps === bps ? { borderColor: 'var(--accent)', background: 'var(--surface-strong)', color: 'var(--ink)' } : undefined}
                >
                  {bps / 100}%
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You pay</span>
            <button
              className="num min-h-8 text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={usable === 0n || busy !== null}
              onClick={() => {
                setAmount(fmtToken(usable, inAsset.decimals, inAsset.decimals).replace(/,/g, ''))
                resetQuote()
              }}
            >
              Max {fmtToken(bal, inAsset.decimals)}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              inputMode="decimal"
              aria-label="Amount to swap"
              placeholder="0"
              value={amount}
              disabled={busy !== null}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d*$/.test(v)) {
                  setAmount(v)
                  resetQuote()
                }
              }}
              className="field min-w-0 text-4xl font-semibold"
            />
            <Picker title="Select token to pay" label="Pay token" value={tokenIn} options={options} onChange={pickIn} disabled={busy !== null} />
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button className="btn-ghost !min-h-11 !min-w-11 !px-0" style={{ background: 'var(--surface-muted)' }} onClick={flip} aria-label="Flip tokens" disabled={busy !== null}>
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You receive</span>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              Balance {fmtToken(balanceOf(tokenOut), ASSETS[tokenOut].decimals)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="display num min-w-0 flex-1 truncate text-4xl font-semibold" style={{ color: reviewed ? 'var(--ink)' : 'var(--subtle)' }}>
              {busy === 'quote' ? <span className="inline-block h-9 w-28 animate-pulse rounded-lg bg-white/10 align-middle" /> : reviewed ? reviewed.estimate.estimatedOutput.amount : '0'}
            </div>
            <Picker title="Select token to receive" label="Receive token" value={tokenOut} options={options} onChange={pickOut} disabled={busy !== null} />
          </div>
        </div>

        {reviewed && (
          <dl className="mt-3 space-y-2 px-1 text-sm">
            {rate !== undefined && Number.isFinite(rate) && <Line label="Rate" value={`1 ${reviewed.tokenIn} ≈ ${rate.toFixed(4)} ${reviewed.tokenOut}`} />}
            {reviewed.estimate.stopLimit && <Line label="Minimum received" value={`${reviewed.estimate.stopLimit.amount} ${reviewed.estimate.stopLimit.token}`} />}
            {(reviewed.estimate.fees ?? []).map((f, i) => (
              <Line key={i} label={`${f.type} fee`} value={f.amount ? `${f.amount} ${f.token}` : 'n/a'} />
            ))}
          </dl>
        )}

        {error && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(232,109,122,0.1)', color: 'var(--danger)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div role="status" className="mt-3 flex items-start gap-2 rounded-xl p-3 text-sm" style={{ background: 'rgba(141,216,159,0.1)', color: 'var(--success)' }}>
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
            <span>
              Swapped {result.amountIn} {result.tokenIn} for {result.amountOut ?? 'your tokens'} {result.tokenOut}.
              {result.explorerUrl && (
                <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold">
                  View <ExternalLink className="size-3" />
                </a>
              )}
            </span>
          </div>
        )}

        <div className="mt-4">
          {!isConnected ? (
            <ConnectCta className="btn-primary w-full" />
          ) : reviewed ? (
            <div className="grid grid-cols-[auto_1fr] gap-2">
              <button className="btn-ghost !min-h-12" disabled={busy !== null} onClick={resetQuote}>
                Edit
              </button>
              <button className="btn-primary w-full" disabled={busy !== null} onClick={() => void execute()}>
                {busy === 'swap' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Confirm in wallet
                  </>
                ) : (
                  `Swap ${reviewed.amount} ${reviewed.tokenIn}`
                )}
              </button>
            </div>
          ) : (
            <button className="btn-primary w-full" disabled={raw === undefined || insufficient || needsFees || busy !== null} onClick={() => void review()}>
              {busy === 'quote' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Getting quote
                </>
              ) : raw === undefined ? (
                'Enter an amount'
              ) : insufficient ? (
                'Insufficient balance'
              ) : needsFees ? (
                'Keep some USDC for fees'
              ) : (
                'Get quote'
              )}
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="num text-right font-medium">{value}</dd>
    </div>
  )
}

function swapError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? '').toLowerCase()
  if (text.includes('user rejected') || text.includes('user denied')) return 'Request cancelled.'
  if (text.includes('route') || text.includes('liquidity')) return 'No swap route is available for this pair and amount right now.'
  if (text.includes('rate')) return 'Too many requests. Please wait a moment and try again.'
  return 'The swap could not be completed. Please try again.'
}
