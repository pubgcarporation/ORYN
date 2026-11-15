import { useCallback, useEffect, useRef, useState } from 'react'
import { AppKit, type SwapEstimate, type SwapResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type EIP1193Provider } from 'viem'
import { AlertCircle, ArrowDownUp, CheckCircle2, ExternalLink, Loader2, SlidersHorizontal } from 'lucide-react'
import { NetworkArc } from '@web3icons/react'
import { useAccount, useReadContracts, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { ARC_ID, ASSETS, fmtAsset, parseInput, type AssetSymbol } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { usePool } from '@/hooks/usePool'
import { Picker, type PickerOption } from '@/components/Picker'
import { SwapSettings, loadSlippage, pct, slippageWarning } from '@/components/SwapSettings'
import { TokenBadge } from '@/components/ui'

const kit = new AppKit()
/** Arc Testnet swaps accept only these tokens. */
const SWAP_TOKENS: AssetSymbol[] = ['USDC', 'EURC', 'cirBTC']
const QUOTE_DEBOUNCE_MS = 600
const QUOTE_REFRESH_MS = 20_000
const sdkToken = (s: AssetSymbol) => (s === 'cirBTC' ? 'CIRBTC' : s) as SwapEstimate['tokenIn']

interface Quote {
  key: string
  estimate: SwapEstimate
  tokenIn: AssetSymbol
  tokenOut: AssetSymbol
  amount: string
  slippageBps: number
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtOut = (amount: string, s: AssetSymbol) => Number(amount).toLocaleString('en-US', { maximumFractionDigits: s === 'cirBTC' ? 8 : 4 })

export function SwapPage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const pool = usePool()
  const [tokenIn, setTokenIn] = useState<AssetSymbol>('USDC')
  const [tokenOut, setTokenOut] = useState<AssetSymbol>('EURC')
  const [amount, setAmount] = useState('')
  const [slippageBps, setSlippageBps] = useState(loadSlippage)
  const [showSettings, setShowSettings] = useState(false)
  const [quote, setQuote] = useState<Quote | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SwapResult | null>(null)
  const requestId = useRef(0)

  const inAsset = ASSETS[tokenIn]
  const raw = parseInput(amount, inAsset.decimals)
  const onArc = chainId === ARC_ID

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
  const canQuote = isConnected && onArc && raw !== undefined && !insufficient && !needsFees

  const key = `${tokenIn}|${tokenOut}|${amount}|${slippageBps}|${address ?? ''}`
  const live = quote && quote.key === key ? quote : null

  const priceUsd = (s: AssetSymbol) => (pool.loaded ? Number(pool.prices[s]) / 1e8 : 0)

  const getAdapter = useCallback(async () => {
    if (!connector) throw new Error('Wallet not connected')
    const provider = (await connector.getProvider()) as EIP1193Provider
    return createViemAdapterFromProvider({ provider })
  }, [connector])

  // Quote as you type, then keep it fresh. Quoting never signs or sends anything.
  useEffect(() => {
    if (!canQuote) return
    const guard = { cancelled: false }
    const run = async (silent: boolean) => {
      const id = ++requestId.current
      if (!silent) setQuoting(true)
      try {
        const adapter = await getAdapter()
        const estimate = await kit.estimateSwap({
          from: { adapter, chain: 'Arc_Testnet' },
          tokenIn: sdkToken(tokenIn),
          tokenOut: sdkToken(tokenOut),
          amountIn: amount,
          config: { slippageBps },
        })
        if (guard.cancelled || id !== requestId.current) return
        setQuote({ key, estimate, tokenIn, tokenOut, amount, slippageBps })
        setError(null)
      } catch (e) {
        if (guard.cancelled || id !== requestId.current) return
        if (!silent) {
          setQuote(null)
          setError(swapError(e))
        }
      } finally {
        if (!guard.cancelled && id === requestId.current) setQuoting(false)
      }
    }
    const first = setTimeout(() => void run(false), QUOTE_DEBOUNCE_MS)
    const refresh = setInterval(() => void run(true), QUOTE_REFRESH_MS)
    return () => {
      guard.cancelled = true
      clearTimeout(first)
      clearInterval(refresh)
    }
    // `key` already captures token, amount, slippage and account.
  }, [canQuote, key, getAdapter, tokenIn, tokenOut, amount, slippageBps])

  const edit = () => {
    setResult(null)
    setError(null)
  }
  const options: PickerOption<AssetSymbol>[] = SWAP_TOKENS.map((s) => ({
    id: s,
    label: s,
    sub: ASSETS[s].name,
    right: address ? fmtAsset(balanceOf(s), s) : undefined,
    icon: <TokenBadge symbol={s} size={28} />,
  }))
  const pickIn = (s: AssetSymbol) => {
    if (s === tokenOut) setTokenOut(tokenIn)
    setTokenIn(s)
    setAmount('')
    edit()
  }
  const pickOut = (s: AssetSymbol) => {
    if (s === tokenIn) setTokenIn(tokenOut)
    setTokenOut(s)
    edit()
  }
  const flip = () => {
    setTokenIn(tokenOut)
    setTokenOut(tokenIn)
    setAmount('')
    edit()
  }

  const execute = async () => {
    if (!live) return
    setSwapping(true)
    setError(null)
    try {
      const adapter = await getAdapter()
      const res = await kit.swap({
        from: { adapter, chain: 'Arc_Testnet' },
        tokenIn: sdkToken(live.tokenIn),
        tokenOut: sdkToken(live.tokenOut),
        amountIn: live.amount,
        config: { slippageBps: live.slippageBps },
      })
      setResult(res)
      setQuote(null)
      setAmount('')
      void refetch()
    } catch (e) {
      setError(swapError(e))
    } finally {
      setSwapping(false)
    }
  }

  // Quote details
  const outAmount = live ? Number(live.estimate.estimatedOutput.amount) : undefined
  const inAmount = Number(amount)
  const quotedRate = outAmount !== undefined && inAmount > 0 ? outAmount / inAmount : undefined
  const oracleRate = priceUsd(tokenIn) > 0 && priceUsd(tokenOut) > 0 ? priceUsd(tokenIn) / priceUsd(tokenOut) : undefined
  const impact = quotedRate !== undefined && oracleRate !== undefined ? (1 - quotedRate / oracleRate) * 100 : undefined
  const impactTone = impact === undefined ? 'var(--ink)' : impact > 2 ? 'var(--danger)' : impact > 0.5 ? 'var(--warn)' : 'var(--success)'
  const badPrice = impact !== undefined && impact > 5
  const provider = live?.estimate.route?.provider
  const warning = slippageWarning(slippageBps)

  const fees = (live?.estimate.fees ?? []).filter((f) => f.amount)
  const payUsd = raw !== undefined ? inAmount * priceUsd(tokenIn) : 0
  const outUsd = outAmount !== undefined ? outAmount * priceUsd(tokenOut) : 0

  let cta = 'Swap'
  if (!amount || raw === undefined) cta = 'Enter an amount'
  else if (insufficient) cta = `Insufficient ${tokenIn}`
  else if (needsFees) cta = 'Keep some USDC for fees'
  else if (!live) cta = quoting ? 'Getting best price' : 'Fetching quote'
  else cta = `${badPrice ? 'Swap anyway' : 'Swap'} ${fmtOut(live.amount, live.tokenIn)} ${live.tokenIn}`
  const ctaDisabled = raw === undefined || insufficient || needsFees || !live || swapping || quoting

  return (
    <div className="mx-auto max-w-md">
      <section className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="display text-2xl font-semibold">Swap</h1>
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold min-[380px]:inline-flex" style={{ background: 'var(--surface-strong)' }}>
              <NetworkArc variant="branded" size={16} /> Arc Testnet
            </span>
            <button
              className="btn-ghost !min-h-11 gap-1.5 !px-3"
              aria-label={`Slippage ${pct(slippageBps)}. Open settings`}
              aria-expanded={showSettings}
              onClick={() => setShowSettings((v) => !v)}
              style={warning ? { color: 'var(--warn)' } : undefined}
            >
              <SlidersHorizontal className="size-4" />
              <span className="num text-xs">{pct(slippageBps)}</span>
            </button>
          </div>
        </div>

        {showSettings && <SwapSettings bps={slippageBps} onChange={setSlippageBps} disabled={swapping} />}

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You pay</span>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              Balance {fmtAsset(bal, tokenIn)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              inputMode="decimal"
              aria-label="Amount to swap"
              placeholder="0"
              value={amount}
              disabled={swapping}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d*$/.test(v)) {
                  setAmount(v)
                  edit()
                }
              }}
              className="field min-w-0 text-4xl font-semibold"
            />
            <Picker title="Select token to pay" label="Pay token" value={tokenIn} options={options} onChange={pickIn} disabled={swapping} />
          </div>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="flex gap-1.5" role="group" aria-label="Quick amounts">
              {[25, 50, 75, 100].map((p) => (
                <button
                  key={p}
                  type="button"
                  className="chip"
                  disabled={usable === 0n || swapping}
                  onClick={() => {
                    const v = p === 100 ? usable : (usable * BigInt(p)) / 100n
                    setAmount(fmtAsset(v, tokenIn, inAsset.decimals).replace(/,/g, ''))
                    edit()
                  }}
                >
                  {p === 100 ? 'Max' : `${p}%`}
                </button>
              ))}
            </div>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              {payUsd > 0 ? `≈ ${usd(payUsd)}` : '\u00a0'}
            </span>
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button className="btn-ghost !min-h-11 !min-w-11 !px-0" style={{ background: 'var(--surface-muted)' }} onClick={flip} aria-label="Flip tokens" disabled={swapping}>
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4 pt-5">
          <div className="flex items-center justify-between gap-2">
            <span className="label">You receive</span>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              Balance {fmtAsset(balanceOf(tokenOut), tokenOut)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="display num min-w-0 flex-1 truncate text-4xl font-semibold" style={{ color: live ? 'var(--ink)' : 'var(--subtle)' }}>
              {quoting && !live ? <span className="inline-block h-9 w-32 animate-pulse rounded-lg bg-white/10 align-middle" /> : live ? fmtOut(live.estimate.estimatedOutput.amount, tokenOut) : '0'}
            </div>
            <Picker title="Select token to receive" label="Receive token" value={tokenOut} options={options} onChange={pickOut} disabled={swapping} />
          </div>
          <div className="num mt-3 text-right text-xs" style={{ color: 'var(--subtle)' }}>
            {outUsd > 0 ? `≈ ${usd(outUsd)}` : '\u00a0'}
          </div>
        </div>

        {live && (
          <dl className="mt-3 space-y-2 px-1 text-sm" aria-live="polite">
            {quotedRate !== undefined && <Line label="Rate" value={`1 ${tokenIn} = ${fmtOut(String(quotedRate), tokenOut)} ${tokenOut}`} />}
            {impact !== undefined && <Line label="Price vs Chainlink" value={impact <= 0 ? 'Better than market' : `${impact.toFixed(2)}% worse`} color={impactTone} />}
            <Line label={`Minimum received (${pct(live.slippageBps)})`} value={`${fmtOut(live.estimate.stopLimit.amount, tokenOut)} ${tokenOut}`} />
            {fees.map((f, i) => (
              <Line key={i} label={`${f.type[0].toUpperCase()}${f.type.slice(1)} fee`} value={`${fmtOut(f.amount ?? '0', f.token === 'CIRBTC' ? 'cirBTC' : (f.token as AssetSymbol))} ${f.token === 'CIRBTC' ? 'cirBTC' : f.token}`} />
            ))}
            {provider && <Line label="Route" value={provider === 'lifi' ? 'LiFi' : provider[0].toUpperCase() + provider.slice(1)} />}
          </dl>
        )}

        {badPrice && (
          <p className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(240,198,116,0.1)', color: 'var(--warn)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            This quote is {impact?.toFixed(1)}% below the Chainlink price. Liquidity on testnet can be thin, so try a smaller amount.
          </p>
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
          ) : !onArc ? (
            <button className="btn-primary w-full" disabled={switching} onClick={() => void switchChainAsync({ chainId: ARC_ID })}>
              {switching ? <Loader2 className="size-4 animate-spin" /> : null} Switch to Arc Testnet
            </button>
          ) : (
            <button className="btn-primary w-full" disabled={ctaDisabled} onClick={() => void execute()}>
              {swapping ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Confirm in wallet
                </>
              ) : quoting && !live && canQuote ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> {cta}
                </>
              ) : (
                cta
              )}
            </button>
          )}
        </div>

        <p className="mt-3 text-center text-[11px]" style={{ color: 'var(--subtle)' }}>
          Routed through a third-party swap provider and subject to its terms. Quotes are estimates and refresh every 20 seconds.
        </p>
      </section>
    </div>
  )
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt style={{ color: 'var(--muted)' }}>{label}</dt>
      <dd className="num text-right font-medium" style={color ? { color } : undefined}>
        {value}
      </dd>
    </div>
  )
}

function swapError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? '').toLowerCase()
  if (text.includes('user rejected') || text.includes('user denied')) return 'Request cancelled.'
  if (text.includes('slippage')) return 'The price moved more than your slippage tolerance. Try again or raise it.'
  if (text.includes('route') || text.includes('liquidity')) return 'No swap route is available for this pair and amount right now. Try a smaller amount.'
  if (text.includes('rate')) return 'Too many requests. Please wait a moment and try again.'
  if (text.includes('insufficient')) return 'Insufficient balance or gas for this swap.'
  return 'The swap could not be completed. Please try again.'
}
