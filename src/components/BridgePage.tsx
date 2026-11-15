import { useState } from 'react'
import { AppKit, type BridgeResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type Chain, type EIP1193Provider } from 'viem'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import { AlertCircle, ArrowDownUp, Check, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { NetworkArbitrumOne, NetworkArc, NetworkBase, NetworkEthereum, NetworkPolygon } from '@web3icons/react'
import { useAccount, useReadContracts, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { getUsdc } from '@/onchain-facts'
import { ASSETS, fmtToken, parseInput } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { withAddChainFallback } from '@/lib/wallet'
import { Picker, type PickerOption } from '@/components/Picker'
import { TokenBadge } from '@/components/ui'

const kit = new AppKit()

type KitChain = 'Arc_Testnet' | 'Ethereum_Sepolia' | 'Base_Sepolia' | 'Arbitrum_Sepolia' | 'Polygon_Amoy_Testnet'
type ChainId = 'arc' | 'eth' | 'base' | 'arb' | 'pol'

interface Network {
  id: ChainId
  label: string
  chain: Chain
  kitChain: KitChain
  Icon: typeof NetworkArc
}

const NETWORKS: Network[] = [
  { id: 'arc', label: 'Arc Testnet', chain: arcTestnet, kitChain: 'Arc_Testnet', Icon: NetworkArc },
  { id: 'eth', label: 'Ethereum Sepolia', chain: sepolia, kitChain: 'Ethereum_Sepolia', Icon: NetworkEthereum },
  { id: 'base', label: 'Base Sepolia', chain: baseSepolia, kitChain: 'Base_Sepolia', Icon: NetworkBase },
  { id: 'arb', label: 'Arbitrum Sepolia', chain: arbitrumSepolia, kitChain: 'Arbitrum_Sepolia', Icon: NetworkArbitrumOne },
  { id: 'pol', label: 'Polygon Amoy', chain: polygonAmoy, kitChain: 'Polygon_Amoy_Testnet', Icon: NetworkPolygon },
]

const KNOWN_CHAINS = NETWORKS.map((n) => n.chain) as unknown as readonly [Chain, ...Chain[]]

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
  const [fromId, setFromId] = useState<ChainId>('eth')
  const [toId, setToId] = useState<ChainId>('arc')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [reached, setReached] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BridgeResult | null>(null)

  const from = NETWORKS.find((n) => n.id === fromId) ?? NETWORKS[0]
  const to = NETWORKS.find((n) => n.id === toId) ?? NETWORKS[0]
  const raw = parseInput(amount, ASSETS.USDC.decimals)

  // USDC balance on every network, so the pickers can show where your money is.
  const { data: balances, refetch } = useReadContracts({
    contracts: NETWORKS.map((n) => ({
      address: getUsdc(n.chain.id)?.address as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
      chainId: n.chain.id,
    })),
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  })
  const balanceOn = (id: ChainId): bigint => {
    const v = balances?.[NETWORKS.findIndex((n) => n.id === id)]?.result
    return typeof v === 'bigint' ? v : 0n
  }

  const bal = balanceOn(fromId)
  // On Arc, USDC is also the gas token, so Max keeps a little back.
  const usable = spendable(bal, fromId === 'arc')
  const insufficient = raw !== undefined && raw > bal
  const needsFees = raw !== undefined && !insufficient && raw > usable

  const options: PickerOption<ChainId>[] = NETWORKS.map((n) => ({
    id: n.id,
    label: n.label,
    sub: n.id === 'arc' ? 'USDC is the gas token' : `Gas in ${n.chain.nativeCurrency.symbol}`,
    right: address ? `${fmtToken(balanceOn(n.id), ASSETS.USDC.decimals)} USDC` : undefined,
    icon: <n.Icon variant="branded" size={28} />,
  }))

  const clear = () => {
    setResult(null)
    setError(null)
  }
  const pickFrom = (id: ChainId) => {
    if (id === toId) setToId(fromId)
    setFromId(id)
    setAmount('')
    clear()
  }
  const pickTo = (id: ChainId) => {
    if (id === fromId) setFromId(toId)
    setToId(id)
    clear()
  }
  const reverse = () => {
    setFromId(toId)
    setToId(fromId)
    setAmount('')
    clear()
  }

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
      if (chainId !== from.chain.id) await switchChainAsync({ chainId: from.chain.id })
      const provider = (await connector.getProvider()) as EIP1193Provider
      const adapter = await createViemAdapterFromProvider({ provider: withAddChainFallback(provider, KNOWN_CHAINS) })
      const res = await kit.bridge({
        from: { adapter, chain: from.kitChain },
        to: { adapter, chain: to.kitChain },
        amount,
      })
      setResult(res)
      if (res.state === 'success') setAmount('')
      void refetch()
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

  return (
    <div className="mx-auto max-w-md">
      <section className="card p-4 sm:p-5">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="display text-2xl font-semibold">Bridge</h1>
          <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold" style={{ background: 'var(--surface-strong)' }}>
            <TokenBadge symbol="USDC" size={16} /> USDC
          </span>
        </div>

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">From</span>
            <button
              className="num min-h-8 text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={usable === 0n || busy}
              onClick={() => {
                setAmount(fmtToken(usable, ASSETS.USDC.decimals, ASSETS.USDC.decimals).replace(/,/g, ''))
                clear()
              }}
            >
              Max {fmtToken(bal, ASSETS.USDC.decimals)}
            </button>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <input
              inputMode="decimal"
              aria-label="Amount to bridge"
              placeholder="0"
              value={amount}
              disabled={busy}
              onChange={(e) => {
                const v = e.target.value.replace(/[^0-9.]/g, '')
                if (/^\d*\.?\d*$/.test(v)) {
                  setAmount(v)
                  clear()
                }
              }}
              className="field min-w-0 text-4xl font-semibold"
            />
            <Picker title="Bridge from" label="Source network" value={fromId} options={options} onChange={pickFrom} disabled={busy} />
          </div>
        </div>

        <div className="relative z-10 -my-3 flex justify-center">
          <button className="btn-ghost !min-h-11 !min-w-11 !px-0" style={{ background: 'var(--surface-muted)' }} onClick={reverse} aria-label="Reverse direction" disabled={busy}>
            <ArrowDownUp className="size-4" />
          </button>
        </div>

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">To</span>
            <span className="num text-xs" style={{ color: 'var(--subtle)' }}>
              Balance {fmtToken(balanceOn(toId), ASSETS.USDC.decimals)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="display num min-w-0 flex-1 truncate text-4xl font-semibold" style={{ color: raw ? 'var(--ink)' : 'var(--subtle)' }}>
              {raw ? fmtToken(raw, ASSETS.USDC.decimals, 2) : '0'}
            </div>
            <Picker title="Bridge to" label="Destination network" value={toId} options={options} onChange={pickTo} disabled={busy} />
          </div>
        </div>

        <dl className="mt-3 space-y-2 px-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>You receive</dt>
            <dd className="num font-medium">{raw ? `${fmtToken(raw, ASSETS.USDC.decimals, 2)} USDC` : 'Same amount'}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>Gas</dt>
            <dd className="text-right font-medium">
              {from.chain.nativeCurrency.symbol} on {from.label.split(' ')[0]} · {to.chain.nativeCurrency.symbol} on {to.label.split(' ')[0]}
            </dd>
          </div>
        </dl>

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
                'Keep some USDC for fees'
              ) : (
                `Bridge ${amount} USDC`
              )}
            </button>
          )}
        </div>
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
          Funds already burned are not lost. Check the steps and the destination network before trying again.
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
