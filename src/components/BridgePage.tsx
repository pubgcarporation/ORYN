import { useState } from 'react'
import { AppKit, type BridgeResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type Chain, type EIP1193Provider } from 'viem'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import { AlertCircle, ArrowDownUp, Check, CheckCircle2, ChevronDown, ExternalLink, Loader2 } from 'lucide-react'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { getUsdc } from '@/onchain-facts'
import { ASSETS, fmtToken, parseInput } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { withAddChainFallback } from '@/lib/wallet'
import { PageTitle, TokenBadge } from '@/components/ui'

const kit = new AppKit()

interface Route {
  id: string
  label: string
  chain: Chain
  kitChain: 'Ethereum_Sepolia' | 'Base_Sepolia' | 'Arbitrum_Sepolia' | 'Polygon_Amoy_Testnet'
}

const ROUTES: Route[] = [
  { id: 'eth', label: 'Ethereum Sepolia', chain: sepolia, kitChain: 'Ethereum_Sepolia' },
  { id: 'base', label: 'Base Sepolia', chain: baseSepolia, kitChain: 'Base_Sepolia' },
  { id: 'arb', label: 'Arbitrum Sepolia', chain: arbitrumSepolia, kitChain: 'Arbitrum_Sepolia' },
  { id: 'pol', label: 'Polygon Amoy', chain: polygonAmoy, kitChain: 'Polygon_Amoy_Testnet' },
]

const KNOWN_CHAINS = [arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy] as const

/** Steps in the order the bridge runs them. Progress comes from the kit's own events. */
const STEPS = [
  { key: 'approve', label: 'Approve USDC' },
  { key: 'burn', label: 'Burn on the source network' },
  { key: 'fetchAttestation', label: 'Wait for Circle to confirm' },
  { key: 'mint', label: 'Mint on the destination network' },
] as const

export function BridgePage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [routeId, setRouteId] = useState('eth')
  const [toArc, setToArc] = useState(true)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [reached, setReached] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BridgeResult | null>(null)

  const route = ROUTES.find((r) => r.id === routeId) ?? ROUTES[0]
  const sourceChain = toArc ? route.chain : arcTestnet
  const destChain = toArc ? arcTestnet : route.chain
  const sourceUsdc = getUsdc(sourceChain.id)
  const destUsdc = getUsdc(destChain.id)
  const raw = parseInput(amount, ASSETS.USDC.decimals)

  const { data: balance, refetch: refetchSource } = useReadContract({
    address: sourceUsdc?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: sourceChain.id,
    query: { enabled: Boolean(address && sourceUsdc), refetchInterval: 10_000 },
  })
  const { data: destBalance, refetch: refetchDest } = useReadContract({
    address: destUsdc?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: destChain.id,
    query: { enabled: Boolean(address && destUsdc), refetchInterval: 10_000 },
  })
  const bal = balance ?? 0n
  // On Arc, USDC is also the gas token, so Max keeps a little back.
  const usable = spendable(bal, !toArc)
  const insufficient = raw !== undefined && raw > bal
  const needsFees = raw !== undefined && !insufficient && raw > usable

  const bridge = async () => {
    if (!connector || raw === undefined) return
    setBusy(true)
    setReached(-1)
    setError(null)
    setResult(null)
    const mark = (index: number) => () => setReached((prev) => Math.max(prev, index))
    const onApprove = mark(0)
    const onBurn = mark(1)
    const onAttest = mark(2)
    const onMint = mark(3)
    kit.on('bridge.approve', onApprove)
    kit.on('bridge.burn', onBurn)
    kit.on('bridge.fetchAttestation', onAttest)
    kit.on('bridge.mint', onMint)
    try {
      if (chainId !== sourceChain.id) await switchChainAsync({ chainId: sourceChain.id })
      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await createViemAdapterFromProvider({ provider: withAddChainFallback(provider, KNOWN_CHAINS) })
      const res = await kit.bridge({
        from: { adapter, chain: toArc ? route.kitChain : 'Arc_Testnet' },
        to: { adapter, chain: toArc ? 'Arc_Testnet' : route.kitChain },
        amount,
      })
      setResult(res)
      if (res.state === 'success') setAmount('')
      void refetchSource()
      void refetchDest()
    } catch (e) {
      setError(bridgeError(e))
    } finally {
      kit.off('bridge.approve', onApprove)
      kit.off('bridge.burn', onBurn)
      kit.off('bridge.fetchAttestation', onAttest)
      kit.off('bridge.mint', onMint)
      setBusy(false)
    }
  }

  const networkPicker = (
    <label className="relative mt-1 block">
      <span className="sr-only">{toArc ? 'Source network' : 'Destination network'}</span>
      <select
        value={routeId}
        disabled={busy}
        onChange={(e) => {
          setRouteId(e.target.value)
          setResult(null)
          setError(null)
        }}
        className="min-h-11 w-full appearance-none rounded-xl border bg-transparent py-2 pl-3 pr-9 text-sm font-semibold"
        style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
      >
        {ROUTES.map((r) => (
          <option key={r.id} value={r.id} style={{ color: '#0d1b2f' }}>
            {r.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
    </label>
  )

  const fixedChain = (
    <div className="mt-1 flex min-h-11 items-center rounded-xl border px-3 text-sm font-semibold" style={{ borderColor: 'var(--border)' }}>
      Arc Testnet
    </div>
  )

  return (
    <div className="mx-auto max-w-md">
      <PageTitle title="Bridge USDC">Move USDC between Arc Testnet and other test networks. Tokens are burned on one side and minted on the other, so there are no wrapped tokens.</PageTitle>

      <section className="card p-4">
        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">From</span>
            <button
              className="num text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={usable === 0n || busy}
              onClick={() => {
                setAmount(fmtToken(usable, ASSETS.USDC.decimals, ASSETS.USDC.decimals).replace(/,/g, ''))
                setResult(null)
              }}
            >
              Balance: {fmtToken(bal, ASSETS.USDC.decimals)} · Max
            </button>
          </div>
          {toArc ? networkPicker : fixedChain}
          <div className="mt-3 flex items-center gap-3">
            <input
              inputMode="decimal"
              aria-label="Amount to bridge"
              placeholder="0.00"
              value={amount}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d*$/.test(v)) {
                  setAmount(v)
                  setResult(null)
                  setError(null)
                }
              }}
              className="field min-w-0 text-3xl font-semibold"
            />
            <div className="flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5" style={{ background: 'var(--surface-strong)' }}>
              <TokenBadge symbol="USDC" size={22} />
              <span className="text-sm font-semibold">USDC</span>
            </div>
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button
            className="btn-ghost !min-h-11 !min-w-11 !px-0"
            style={{ background: 'var(--surface-muted)' }}
            onClick={() => {
              setToArc((v) => !v)
              setAmount('')
              setResult(null)
              setError(null)
            }}
            aria-label="Reverse direction"
            disabled={busy}
          >
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">To</span>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              Balance: {fmtToken(destBalance ?? 0n, ASSETS.USDC.decimals)}
            </span>
          </div>
          {toArc ? fixedChain : networkPicker}
          <div className="num mt-3 flex items-baseline justify-between gap-2">
            <span className="display text-3xl font-semibold" style={{ color: raw ? 'var(--ink)' : 'var(--subtle)' }}>
              {raw ? fmtToken(raw, ASSETS.USDC.decimals, 2) : '0.00'}
            </span>
            <span className="text-sm font-semibold" style={{ color: 'var(--muted)' }}>
              USDC
            </span>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
            The same amount of USDC arrives at your own address. Network fees are paid separately: {sourceChain.nativeCurrency.symbol} on {sourceChain.name}
            {' '}and {destChain.nativeCurrency.symbol} on {destChain.name}.
          </p>
        </div>

        {busy && <StepProgress reached={reached} />}

        {error && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(232,109,122,0.1)', color: 'var(--danger)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && <BridgeReceipt result={result} />}

        <div className="mt-4">
          {!isConnected ? (
            <ConnectCta className="btn-primary w-full" />
          ) : (
            <button className="btn-primary w-full" disabled={raw === undefined || insufficient || needsFees || busy} onClick={() => void bridge()}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Bridging, keep this tab open
                </>
              ) : raw === undefined ? (
                'Enter an amount'
              ) : insufficient ? (
                'Insufficient balance'
              ) : needsFees ? (
                'Leave some USDC for network fees'
              ) : (
                `Bridge ${amount} USDC`
              )}
            </button>
          )}
        </div>
        <p className="mt-3 text-xs" style={{ color: 'var(--subtle)' }}>
          You will be asked to approve, burn on the source network, and mint on the destination network. Your wallet switches networks for you.
        </p>
      </section>
    </div>
  )
}

function StepProgress({ reached }: { reached: number }) {
  const active = reached + 1
  return (
    <ol className="inner mt-3 space-y-2.5 p-4 text-sm" aria-label="Bridge progress">
      {STEPS.map((step, index) => {
        const done = index <= reached
        const current = index === active
        return (
          <li key={step.key} className="flex items-center gap-2.5" style={{ color: done ? 'var(--ink)' : current ? 'var(--ink-2)' : 'var(--subtle)' }}>
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full" style={{ background: done ? 'var(--success)' : 'var(--surface-strong)' }}>
              {done ? <Check className="size-3" style={{ color: 'var(--accent-ink)' }} /> : current ? <Loader2 className="size-3 animate-spin" /> : null}
            </span>
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}

function stepLabel(name: string): string {
  const n = name.toLowerCase()
  if (n.includes('approve')) return 'Approve USDC'
  if (n.includes('burn')) return 'Burn on the source network'
  if (n.includes('attest')) return 'Circle confirmation'
  if (n.includes('mint')) return 'Mint on the destination network'
  return name
}

function BridgeReceipt({ result }: { result: BridgeResult }) {
  const ok = result.state === 'success'
  return (
    <div role="status" className="inner mt-3 space-y-2 p-4 text-sm">
      <div className="flex items-center gap-2 font-semibold" style={{ color: ok ? 'var(--success)' : 'var(--warn)' }}>
        {ok ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
        {ok ? 'Bridge complete' : 'Bridge did not finish'}
      </div>
      {result.steps.map((step) => (
        <div key={step.name} className="flex items-center justify-between gap-3 text-xs">
          <span style={{ color: 'var(--muted)' }}>{stepLabel(step.name)}</span>
          {step.explorerUrl ? (
            <a href={step.explorerUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-semibold" style={{ color: 'var(--accent)' }}>
              {step.state} <ExternalLink className="size-3" />
            </a>
          ) : (
            <span>{step.state}</span>
          )}
        </div>
      ))}
      {!ok && (
        <p className="text-xs" style={{ color: 'var(--subtle)' }}>
          Funds that were already burned are not lost. Check the steps above and the destination network before trying again.
        </p>
      )}
    </div>
  )
}

function bridgeError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? '').toLowerCase()
  if (text.includes('user rejected') || text.includes('user denied')) return 'Request cancelled.'
  if (text.includes('insufficient')) return 'Insufficient balance or gas for this transfer.'
  if (text.includes('unsupported')) return 'This route is not supported right now.'
  return 'The bridge could not be started. Please try again.'
}
