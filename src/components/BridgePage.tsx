import { useState } from 'react'
import { AppKit, type BridgeResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type Chain, type EIP1193Provider } from 'viem'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import { AlertCircle, ArrowDownUp, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { useAccount, useReadContract, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { getUsdc } from '@/onchain-facts'
import { ASSETS, fmtToken, parseInput } from '@/lib/pool'
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

export function BridgePage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [routeId, setRouteId] = useState('eth')
  const [toArc, setToArc] = useState(true)
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BridgeResult | null>(null)

  const route = ROUTES.find((r) => r.id === routeId) ?? ROUTES[0]
  const sourceChain = toArc ? route.chain : arcTestnet
  const sourceUsdc = getUsdc(sourceChain.id)
  const raw = parseInput(amount, ASSETS.USDC.decimals)

  const { data: balance } = useReadContract({
    address: sourceUsdc?.address as `0x${string}` | undefined,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId: sourceChain.id,
    query: { enabled: Boolean(address && sourceUsdc), refetchInterval: 10_000 },
  })
  const bal = balance ?? 0n
  const insufficient = raw !== undefined && raw > bal

  const bridge = async () => {
    if (!connector || raw === undefined) return
    setBusy(true)
    setError(null)
    setResult(null)
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
    } catch (e) {
      setError(bridgeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto max-w-md">
      <PageTitle title="Bridge USDC">Move USDC between Arc Testnet and other test networks. Tokens are burned on one side and minted on the other, so there are no wrapped tokens.</PageTitle>

      <section className="card p-4">
        <div className="inner p-4">
          <div className="flex items-center justify-between">
            <span className="label">From</span>
            <button
              className="text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={bal === 0n}
              onClick={() => setAmount(fmtToken(bal, ASSETS.USDC.decimals, ASSETS.USDC.decimals).replace(/,/g, ''))}
            >
              Balance: {fmtToken(bal, ASSETS.USDC.decimals)} · Max
            </button>
          </div>
          <div className="mt-1 text-sm font-semibold">{toArc ? route.label : 'Arc Testnet'}</div>
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
                }
              }}
              className="field min-w-0 text-3xl font-semibold"
            />
            <div className="flex items-center gap-2 rounded-full px-3 py-1.5" style={{ background: 'var(--surface-strong)' }}>
              <TokenBadge symbol="USDC" size={22} />
              <span className="text-sm font-semibold">USDC</span>
            </div>
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button
            className="btn-ghost !min-h-11 !min-w-11 !px-0"
            style={{ background: 'var(--surface-muted)' }}
            onClick={() => setToArc((v) => !v)}
            aria-label="Reverse direction"
            disabled={busy}
          >
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4">
          <span className="label">To</span>
          <div className="mt-1 text-sm font-semibold">{toArc ? 'Arc Testnet' : route.label}</div>
          <div className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
            You receive the same amount of USDC at your own address. Fast transfers usually finish within a minute.
          </div>
        </div>

        <label className="mt-3 block text-xs" style={{ color: 'var(--muted)' }}>
          <span className="label mb-1 block">{toArc ? 'Source network' : 'Destination network'}</span>
          <select
            value={routeId}
            disabled={busy}
            onChange={(e) => setRouteId(e.target.value)}
            className="min-h-12 w-full rounded-xl border bg-transparent px-3"
            style={{ borderColor: 'var(--border)', color: 'var(--ink)' }}
          >
            {ROUTES.map((r) => (
              <option key={r.id} value={r.id} style={{ color: '#0d1b2f' }}>
                {r.label}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <div className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(232,109,122,0.1)', color: 'var(--danger)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && <BridgeReceipt result={result} />}

        <div className="mt-4">
          {!isConnected ? (
            <ConnectCta className="btn-primary w-full" />
          ) : (
            <button className="btn-primary w-full" disabled={raw === undefined || insufficient || busy} onClick={() => void bridge()}>
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Bridging, keep this tab open
                </>
              ) : raw === undefined ? (
                'Enter an amount'
              ) : insufficient ? (
                'Insufficient balance'
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

function BridgeReceipt({ result }: { result: BridgeResult }) {
  const ok = result.state === 'success'
  return (
    <div className="inner mt-3 space-y-2 p-4 text-sm">
      <div className="flex items-center gap-2 font-semibold" style={{ color: ok ? 'var(--success)' : 'var(--warn)' }}>
        {ok ? <CheckCircle2 className="size-4" /> : <AlertCircle className="size-4" />}
        {ok ? 'Bridge complete' : 'Bridge did not finish'}
      </div>
      {result.steps.map((step) => (
        <div key={step.name} className="flex items-center justify-between text-xs">
          <span style={{ color: 'var(--muted)' }}>{step.name}</span>
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
