import { useDeferredValue, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AppKit, type BridgeResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import { erc20Abi, type Chain, type EIP1193Provider, type Hex } from 'viem'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import { AlertCircle, ArrowDownUp, Check, CheckCircle2, ExternalLink, Loader2 } from 'lucide-react'
import { NetworkArbitrumOne, NetworkArc, NetworkBase, NetworkEthereum, NetworkPolygon } from '@web3icons/react'
import { useAccount, useReadContracts, useSwitchChain } from 'wagmi'
import { ConnectCta } from '@/auth/ConnectCta'
import { getUsdc } from '@/onchain-facts'
import { ASSETS, fmtAsset, fmtToken, parseInput, type AssetSymbol } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { withAddChainFallback } from '@/lib/wallet'
import { useGaslessSigner } from '@/hooks/useGaslessSigner'
import { GASLESS_DOMAINS, gaslessBridge, quoteGaslessBridge, type GaslessStage, type Quote } from '@/lib/gaslessBridge'
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

const BRIDGE_TOKENS: AssetSymbol[] = ['USDC', 'EURC', 'cirBTC']

/**
 * Token contract on each network, from Circle's CCTP registry. A token that is missing from a network
 * cannot be bridged there: EURC lives on Ethereum Sepolia, Base Sepolia and Arc, cirBTC on Ethereum Sepolia and Arc.
 */
const TOKEN_ADDRESS: Record<Exclude<AssetSymbol, 'USDC'>, Partial<Record<ChainId, `0x${string}`>>> = {
  EURC: {
    arc: ASSETS.EURC.address,
    eth: '0x08210f9170f89ab7658f0b5e3ff39b0e03c594d4',
    base: '0x808456652fdb597867f38412077a9182bf77359f',
  },
  cirBTC: {
    arc: ASSETS.cirBTC.address,
    eth: '0x3a3fe695f684bf9b9e43cf43c2b895ea5e392bb3',
  },
}

function tokenAddress(token: AssetSymbol, n: Network): `0x${string}` | undefined {
  return token === 'USDC' ? (getUsdc(n.chain.id)?.address as `0x${string}` | undefined) : TOKEN_ADDRESS[token][n.id]
}

const KNOWN_CHAINS = NETWORKS.map((n) => n.chain) as unknown as readonly [Chain, ...Chain[]]

/** Steps in the order the bridge runs them. Progress comes from the kit's own events. */
const STEPS = [
  { key: 'approve', label: 'Approve token' },
  { key: 'burn', label: 'Burn on the source network' },
  { key: 'fetchAttestation', label: 'Wait for Circle to confirm' },
  { key: 'mint', label: 'Mint on the destination network' },
] as const

/** Kept back on the source network so the paymaster can take its gas fee in USDC. */
const GAS_RESERVE = 1_000_000n

const GASLESS_STEPS: Record<GaslessStage, string> = {
  permit: 'Allow gas to be paid in USDC',
  upgrade: 'Upgrade your wallet (one time per network)',
  send: 'Approve and burn on the source network',
  confirm: 'Waiting for the network to confirm',
}

export function BridgePage() {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const [token, setToken] = useState<AssetSymbol>('USDC')
  const [fromId, setFromId] = useState<ChainId>('eth')
  const [toId, setToId] = useState<ChainId>('arc')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [reached, setReached] = useState(-1)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BridgeResult<string> | null>(null)
  const signer = useGaslessSigner()
  const [useUsdcGas, setUseUsdcGas] = useState(true)
  const [gStage, setGStage] = useState<GaslessStage | null>(null)
  const [sent, setSent] = useState<Hex | null>(null)

  const from = NETWORKS.find((n) => n.id === fromId) ?? NETWORKS[0]
  const to = NETWORKS.find((n) => n.id === toId) ?? NETWORKS[0]
  const asset = ASSETS[token]
  const raw = parseInput(amount, asset.decimals)
  // Only the networks that have this token can be picked.
  const networks = NETWORKS.filter((n) => tokenAddress(token, n) !== undefined)

  // The token's balance on every network that has it, so the pickers can show where your money is.
  const { data: balances, refetch } = useReadContracts({
    contracts: networks.map((n) => ({
      address: tokenAddress(token, n) as `0x${string}`,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address as `0x${string}`],
      chainId: n.chain.id,
    })),
    query: { enabled: Boolean(address), refetchInterval: 10_000 },
  })
  const balanceOn = (id: ChainId): bigint => {
    const v = balances?.[networks.findIndex((n) => n.id === id)]?.result
    return typeof v === 'bigint' ? v : 0n
  }

  const bal = balanceOn(fromId)
  // On Arc, USDC is also the gas token, so Max keeps a little back.
  const usable = spendable(bal, fromId === 'arc' && token === 'USDC')
  const insufficient = raw !== undefined && raw > bal
  const needsFees = raw !== undefined && !insufficient && raw > usable

  // Gas in USDC: the app's own wallet is upgraded with EIP-7702 and Circle Paymaster takes the gas fee in USDC.
  const canGasless = signer !== undefined && token === 'USDC' && fromId !== 'arc' && toId === 'arc' && GASLESS_DOMAINS[from.chain.id] !== undefined
  const gasless = canGasless && useUsdcGas

  // The fee depends on the amount and changes, so it is fetched again for each amount.
  const quoteAmount = useDeferredValue(raw)
  const { data: quoteData } = useQuery({
    queryKey: ['gasless-quote', from.chain.id, quoteAmount?.toString()],
    queryFn: () => quoteGaslessBridge(from.chain.id, quoteAmount as bigint),
    enabled: gasless && quoteAmount !== undefined,
    staleTime: 15_000,
    retry: 0,
  })
  const quote: Quote | null = gasless && quoteAmount !== undefined && quoteAmount === raw ? (quoteData ?? null) : null
  const gaslessShort = gasless && raw !== undefined && quote !== null && raw + quote.maxFee + GAS_RESERVE > bal

  const options: PickerOption<ChainId>[] = networks.map((n) => ({
    id: n.id,
    label: n.label,
    sub: n.id === 'arc' ? 'USDC is the gas token' : `Gas in ${n.chain.nativeCurrency.symbol}`,
    right: address ? `${fmtAsset(balanceOn(n.id), token)} ${token}` : undefined,
    icon: <n.Icon variant="branded" size={28} />,
  }))

  const tokenOptions: PickerOption<AssetSymbol>[] = BRIDGE_TOKENS.map((t) => ({
    id: t,
    label: t,
    sub: ASSETS[t].name,
    icon: <TokenBadge symbol={t} size={28} />,
  }))
  const pickToken = (t: AssetSymbol) => {
    const ids = NETWORKS.filter((n) => tokenAddress(t, n) !== undefined).map((n) => n.id)
    const nextFrom = ids.includes(fromId) ? fromId : (ids.find((id) => id !== 'arc') ?? ids[0])
    const nextTo = ids.includes(toId) && toId !== nextFrom ? toId : (ids.find((id) => id !== nextFrom) ?? ids[0])
    setToken(t)
    setFromId(nextFrom)
    setToId(nextTo)
    setAmount('')
    clear()
  }

  const clear = () => {
    setResult(null)
    setError(null)
    setSent(null)
  }

  const fillMax = async () => {
    clear()
    if (!gasless) {
      setAmount(fmtToken(usable, asset.decimals, asset.decimals).replace(/,/g, ''))
      return
    }
    try {
      const q = await quoteGaslessBridge(from.chain.id, bal)
      const room = bal > q.maxFee + GAS_RESERVE ? bal - q.maxFee - GAS_RESERVE : 0n
      setAmount(fmtToken(room, asset.decimals, asset.decimals).replace(/,/g, ''))
    } catch {
      setError('Could not get the bridge fee. Try again in a moment.')
    }
  }

  const runGasless = async () => {
    if (!signer || raw === undefined) return
    setBusy(true)
    setError(null)
    setResult(null)
    setSent(null)
    try {
      const q = await quoteGaslessBridge(from.chain.id, raw)
      if (raw + q.maxFee + GAS_RESERVE > bal) throw new Error('short')
      const { txHash } = await gaslessBridge({ chain: from.chain, signer, quote: q, onStage: setGStage })
      setSent(txHash)
      setAmount('')
      void refetch()
    } catch (e) {
      setError(gaslessError(e))
    } finally {
      setGStage(null)
      setBusy(false)
    }
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
        // USDC is the default. Other tokens go through Circle's CCTP for expanded assets.
        ...(token === 'USDC' ? {} : { token }),
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
          <Picker title="Token to bridge" label="Token" value={token} options={tokenOptions} onChange={pickToken} disabled={busy} />
        </div>

        <div className="inner p-4">
          <div className="flex items-center justify-between gap-2">
            <span className="label">From</span>
            <button
              className="num min-h-8 text-xs font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
              disabled={usable === 0n || busy}
              onClick={() => void fillMax()}
            >
              Max {fmtAsset(bal, token)}
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
              Balance {fmtAsset(balanceOn(toId), token)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-3">
            <div className="display num min-w-0 flex-1 truncate text-4xl font-semibold" style={{ color: raw ? 'var(--ink)' : 'var(--subtle)' }}>
              {raw ? fmtAsset(raw, token) : '0'}
            </div>
            <Picker title="Bridge to" label="Destination network" value={toId} options={options} onChange={pickTo} disabled={busy} />
          </div>
        </div>

        <dl className="mt-3 space-y-2 px-1 text-sm">
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>You receive</dt>
            <dd className="num font-medium">{raw ? `${fmtAsset(raw, token)} ${token}` : 'Same amount'}</dd>
          </div>
          {gasless && quote && (
            <>
              <div className="flex items-center justify-between gap-3">
                <dt style={{ color: 'var(--muted)' }}>Circle bridge fee (at most)</dt>
                <dd className="num font-medium">{fmtAsset(quote.maxFee, 'USDC')} USDC</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt style={{ color: 'var(--muted)' }}>You pay on {from.label.split(' ')[0]}</dt>
                <dd className="num font-medium">{fmtAsset(quote.total, 'USDC')} USDC</dd>
              </div>
            </>
          )}
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>Gas</dt>
            <dd className="text-right font-medium">
              {gasless
                ? 'Paid in USDC, +10% paymaster fee'
                : `${from.chain.nativeCurrency.symbol} on ${from.label.split(' ')[0]} · ${to.chain.nativeCurrency.symbol} on ${to.label.split(' ')[0]}`}
            </dd>
          </div>
        </dl>

        {canGasless && (
          <div className="inner mt-3 flex items-start justify-between gap-3 p-3.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold">Pay gas in USDC</div>
              <p className="mt-0.5 text-pretty text-xs" style={{ color: 'var(--subtle)' }}>
                No {from.chain.nativeCurrency.symbol} needed. Circle Paymaster covers the network fee and takes it back in USDC, and Circle delivers the USDC on Arc. Your wallet is upgraded once on this network with EIP-7702. Keep about 1 USDC extra for gas.
              </p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={useUsdcGas}
              aria-label="Pay gas in USDC"
              disabled={busy}
              onClick={() => {
                setUseUsdcGas((v) => !v)
                clear()
              }}
              className="relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-50"
              style={{ background: useUsdcGas ? 'var(--accent)' : 'var(--surface-strong)' }}
            >
              <span className="absolute left-0.5 top-0.5 size-6 rounded-full transition-transform motion-reduce:transition-none" style={{ background: 'var(--bg)', transform: useUsdcGas ? 'translateX(20px)' : 'translateX(0)' }} />
            </button>
          </div>
        )}
        {!canGasless && isConnected && !signer && token === 'USDC' && fromId !== 'arc' && toId === 'arc' && (
          <p className="mt-3 px-1 text-xs" style={{ color: 'var(--subtle)' }}>
            Paying gas in USDC works with the app's built-in wallet (Google or email sign-in). Browser wallets pay gas in {from.chain.nativeCurrency.symbol}.
          </p>
        )}

        {token !== 'USDC' && (
          <p className="mt-3 px-1 text-xs" style={{ color: 'var(--subtle)' }}>
            {token === 'EURC' ? 'EURC can be bridged between Ethereum Sepolia, Base Sepolia and Arc Testnet.' : 'cirBTC can be bridged between Ethereum Sepolia and Arc Testnet.'}
          </p>
        )}

        {busy && gasless && gStage && (
          <div className="inner mt-3 flex items-center gap-2.5 p-4 text-sm" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            {GASLESS_STEPS[gStage]}
          </div>
        )}
        {busy && !gasless && <StepProgress reached={reached} />}

        {error && (
          <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(255,122,138,0.1)', color: 'var(--danger)' }}>
            <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {result && <BridgeReceipt result={result} />}

        {sent && (
          <div role="status" className="inner mt-3 space-y-1.5 p-4 text-sm">
            <div className="flex items-center gap-2 font-semibold" style={{ color: 'var(--success)' }}>
              <CheckCircle2 className="size-4" /> Sent on {from.label.split(' ')[0]}
            </div>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>
              Circle is delivering your USDC to Arc. It usually lands within a minute and your balance updates on its own.
            </p>
            {from.chain.blockExplorers && (
              <a href={`${from.chain.blockExplorers.default.url}/tx/${sent}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                View transaction <ExternalLink className="size-3" />
              </a>
            )}
          </div>
        )}

        <div className="mt-4">
          {!isConnected ? (
            <ConnectCta className="btn-primary w-full" />
          ) : (
            <button
              className="btn-primary w-full"
              disabled={raw === undefined || insufficient || (!gasless && needsFees) || (gasless && (quote === null || gaslessShort)) || busy}
              onClick={() => void (gasless ? runGasless() : bridge())}
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> Bridging, keep this tab open
                </>
              ) : raw === undefined ? (
                'Enter an amount'
              ) : insufficient ? (
                'Insufficient balance'
              ) : gasless && quote === null ? (
                'Getting the bridge fee'
              ) : gaslessShort ? (
                'Keep about 1 USDC for gas and fees'
              ) : gasless ? (
                `Bridge ${amount} USDC, gas in USDC`
              ) : needsFees ? (
                'Keep some USDC for fees'
              ) : (
                `Bridge ${amount} ${token}`
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
  if (n.includes('approve')) return 'Approve token'
  if (n.includes('burn')) return 'Burn on the source network'
  if (n.includes('attest')) return 'Circle confirmation'
  if (n.includes('mint')) return 'Mint on the destination network'
  return name
}

function BridgeReceipt({ result }: { result: BridgeResult<string> }) {
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

function gaslessError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? '').toLowerCase()
  if (text.includes('user rejected') || text.includes('user denied') || text.includes('rejected the request')) return 'Request cancelled.'
  if (text.includes('short')) return 'Not enough USDC to cover the amount, the bridge fee and gas.'
  if (text.includes('fee') || text.includes('not available')) return 'Fast transfers are not available on this route right now. Try again, or turn off Pay gas in USDC.'
  return 'The gas-in-USDC bridge could not be sent. Try again, or turn off Pay gas in USDC to use the normal bridge.'
}
