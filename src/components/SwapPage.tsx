import { useState } from 'react'
import { AppKit, type SwapEstimate, type SwapResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { EIP1193Provider } from 'viem'
import { ArrowDownUp, ExternalLink, Loader2, AlertCircle } from 'lucide-react'
import { erc20Abi } from 'viem'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { ARC_ID, ASSETS, fmtToken, parseInput, type AssetSymbol } from '@/lib/pool'
import { PageTitle, TokenBadge } from '@/components/ui'

const kit = new AppKit()
const SLIPPAGE_BPS = 100

interface Reviewed {
  estimate: SwapEstimate
  tokenIn: AssetSymbol
  tokenOut: AssetSymbol
  amount: string
  account: string | undefined
}

export function SwapPage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [tokenIn, setTokenIn] = useState<AssetSymbol>('USDC')
  const [amount, setAmount] = useState('')
  const [reviewed, setReviewed] = useState<Reviewed | null>(null)
  const [busy, setBusy] = useState<'quote' | 'swap' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SwapResult | null>(null)

  const tokenOut: AssetSymbol = tokenIn === 'USDC' ? 'EURC' : 'USDC'
  const inAsset = ASSETS[tokenIn]
  const raw = parseInput(amount, inAsset.decimals)

  const { data: balance } = useReadContract({
    address: inAsset.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: ARC_ID,
    query: { enabled: Boolean(address), refetchInterval: 8000 },
  })
  const bal = balance ?? 0n
  const insufficient = raw !== undefined && raw > bal

  const getAdapter = async () => {
    if (!connector) throw new Error('Wallet not connected')
    if (chainId !== ARC_ID) await switchChainAsync({ chainId: ARC_ID })
    const provider = (await connector.getProvider()) as EIP1193Provider
    return createViemAdapterFromProvider({ provider })
  }

  const flip = () => {
    setTokenIn(tokenOut)
    setAmount('')
    setReviewed(null)
    setResult(null)
    setError(null)
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
        config: { slippageBps: SLIPPAGE_BPS },
      })
      setReviewed({ estimate, tokenIn, tokenOut, amount, account: address })
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
        config: { slippageBps: SLIPPAGE_BPS },
      })
      setResult(res)
      setReviewed(null)
      setAmount('')
    } catch (e) {
      setError(swapError(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <PageTitle title="Swap">Trade between USDC and EURC on Arc Testnet.</PageTitle>

      <section className="card p-4">
        <div className="inner p-4">
          <div className="flex items-center justify-between">
            <span className="label">You pay</span>
            <button
              className="text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={bal === 0n}
              onClick={() => {
                setAmount(fmtToken(bal, inAsset.decimals, inAsset.decimals).replace(/,/g, ''))
                setReviewed(null)
              }}
            >
              Balance: {fmtToken(bal, inAsset.decimals)} · Max
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              inputMode="decimal"
              aria-label="Amount to swap"
              placeholder="0.00"
              value={amount}
              disabled={busy !== null}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d*$/.test(v)) {
                  setAmount(v)
                  setReviewed(null)
                  setResult(null)
                }
              }}
              className="field min-w-0 text-3xl font-semibold"
            />
            <TokenPill symbol={tokenIn} />
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button className="btn-ghost !min-h-11 !min-w-11 !px-0" style={{ background: 'var(--surface-muted)' }} onClick={flip} aria-label="Flip tokens" disabled={busy !== null}>
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4">
          <span className="label">You receive (estimated)</span>
          <div className="mt-2 flex items-center gap-3">
            <div className="display num flex-1 text-3xl font-semibold" style={{ color: reviewed ? 'var(--ink)' : 'var(--subtle)' }}>
              {reviewed ? reviewed.estimate.estimatedOutput.amount : '0.00'}
            </div>
            <TokenPill symbol={tokenOut} />
          </div>
        </div>

        {reviewed && (
          <div className="inner mt-3 space-y-2 p-4 text-sm">
            <Line label="Slippage tolerance" value={`${SLIPPAGE_BPS / 100}%`} />
            {reviewed.estimate.stopLimit && (
              <Line label="Minimum received" value={`${reviewed.estimate.stopLimit.amount} ${reviewed.estimate.stopLimit.token}`} />
            )}
            {(reviewed.estimate.fees ?? []).map((f, i) => (
              <Line key={i} label={`${f.type} fee`} value={f.amount ? `${f.amount} ${f.token}` : 'n/a'} />
            ))}
          </div>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(232,109,122,0.1)', color: 'var(--danger)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-3 rounded-xl p-3 text-sm" style={{ background: 'rgba(141,216,159,0.1)', color: 'var(--success)' }}>
            Swapped {result.amountIn} {result.tokenIn} for {result.amountOut ?? 'your tokens'} {result.tokenOut}.
            {result.explorerUrl && (
              <a href={result.explorerUrl} target="_blank" rel="noopener noreferrer" className="ml-2 inline-flex items-center gap-1 font-semibold">
                View <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        <div className="mt-4">
          {!isConnected ? (
            <ConnectCta className="btn-primary w-full" />
          ) : reviewed ? (
            <button className="btn-primary w-full" disabled={busy !== null} onClick={() => void execute()}>
              {busy === 'swap' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Swapping...
                </>
              ) : (
                `Swap ${reviewed.amount} ${reviewed.tokenIn} for ${reviewed.tokenOut}`
              )}
            </button>
          ) : (
            <button className="btn-primary w-full" disabled={raw === undefined || insufficient || busy !== null} onClick={() => void review()}>
              {busy === 'quote' ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Getting quote...
                </>
              ) : raw === undefined ? (
                'Enter an amount'
              ) : insufficient ? (
                'Insufficient balance'
              ) : (
                'Review quote'
              )}
            </button>
          )}
        </div>

        <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
          Swaps are routed through a swap provider that can change by route, and are subject to that provider's terms. Quotes are estimates and can move before you confirm.
        </p>
      </section>
    </div>
  )
}

function TokenPill({ symbol }: { symbol: AssetSymbol }) {
  return (
    <div className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5" style={{ background: 'var(--surface-strong)' }}>
      <TokenBadge symbol={symbol} size={22} />
      <span className="text-sm font-semibold">{symbol}</span>
    </div>
  )
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span style={{ color: 'var(--muted)' }}>{label}</span>
      <span className="num font-medium">{value}</span>
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
