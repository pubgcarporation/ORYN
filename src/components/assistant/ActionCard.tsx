import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, Loader2, ShieldAlert } from 'lucide-react'
import { erc20Abi, type Address } from 'viem'
import { useAccount, useReadContract, useSwitchChain, useWriteContract } from 'wagmi'
import type { SwapEstimate } from '@circle-fin/app-kit'
import { ConnectCta } from '@/auth/ConnectCta'
import { ARC_ID, ASSETS, fmtAsset, parseInput, valueUsd8 } from '@/lib/pool'
import { spendable } from '@/lib/gas'
import { buildTxExplorerUrl, getUsdc } from '@/onchain-facts'
import type { PoolState } from '@/hooks/usePool'
import { useTx } from '@/hooks/useTx'
import { evaluate, recordSpend, spentToday, type Limits } from '@/agent/limits'
import { CHAIN_LABELS, TOKEN_DECIMALS, type AgentAction, type Token } from '@/agent/schema'
import { NETWORKS, actionError, estimateSwap, runBridge, runSwap } from '@/agent/execute'

type Status = 'idle' | 'running' | 'done' | 'cancelled'

interface Props {
  action: AgentAction
  message: string
  limits: Limits
  pool: PoolState
}

const BRIDGE_STEPS = ['Approving USDC', 'Burning on the source network', 'Waiting for Circle to confirm', 'Minting on the destination network']
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`

function describe(action: AgentAction): { title: string; rows: [string, string][]; token: Token } {
  if (action.type === 'send') {
    return {
      title: `Send ${action.amount} ${action.token}`,
      token: action.token,
      rows: [
        ['To', short(action.to)],
        ['Network', 'Arc Testnet'],
      ],
    }
  }
  if (action.type === 'swap') {
    return {
      title: `Swap ${action.amount} ${action.tokenIn} to ${action.tokenOut}`,
      token: action.tokenIn,
      rows: [
        ['Network', 'Arc Testnet'],
        ['Slippage', `${(action.slippageBps / 100).toFixed(2)}%`],
      ],
    }
  }
  return {
    title: `Bridge ${action.amount} USDC`,
    token: 'USDC',
    rows: [
      ['From', CHAIN_LABELS[action.from]],
      ['To', CHAIN_LABELS[action.to]],
    ],
  }
}

/** A drafted action, checked against your limits in code, and run only after you confirm in your wallet. */
export function ActionCard({ action, message, limits, pool }: Props) {
  const { address, connector, chainId, isConnected } = useAccount()
  const { switchChainAsync, isPending: switching } = useSwitchChain()
  const { writeContractAsync } = useWriteContract()
  const [status, setStatus] = useState<Status>('idle')
  const [ack, setAck] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [links, setLinks] = useState<{ label: string; url: string }[]>([])
  const [reached, setReached] = useState(-1)
  const [estimate, setEstimate] = useState<SwapEstimate | null>(null)
  const [estimateError, setEstimateError] = useState<string | null>(null)
  const settled = useRef(false)

  const { title, rows, token } = describe(action)
  const decimals = TOKEN_DECIMALS[token]
  const raw = parseInput(action.amount, decimals)

  const valueUsd = pool.loaded && raw !== undefined ? Number(valueUsd8(raw, token, pool.prices)) / 1e8 : undefined
  const verdict = evaluate({ action, limits, valueUsd, spentUsd: spentToday(address), message, account: address })

  // Source balance on the network the money leaves from.
  const sourceChain = action.type === 'bridge' ? NETWORKS[action.from].chain.id : ARC_ID
  const sourceToken = action.type === 'bridge' ? (getUsdc(sourceChain)?.address as Address | undefined) : ASSETS[token].address
  const { data: balance } = useReadContract({
    address: sourceToken,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address as Address],
    chainId: sourceChain,
    query: { enabled: Boolean(address && sourceToken), refetchInterval: 8000 },
  })
  const bal = typeof balance === 'bigint' ? balance : undefined
  const paysGas = token === 'USDC' && sourceChain === ARC_ID
  const insufficient = raw !== undefined && bal !== undefined && raw > bal
  const needsFees = raw !== undefined && bal !== undefined && !insufficient && raw > spendable(bal, paysGas)

  const blocked = verdict.blocks.length > 0 || insufficient || needsFees || raw === undefined
  const onArc = chainId === ARC_ID
  const needsArc = action.type === 'swap' && !onArc

  const resolve = (text: string, urls: { label: string; url: string }[]) => {
    if (settled.current) return
    settled.current = true
    if (address && valueUsd !== undefined) recordSpend(address, valueUsd)
    setSummary(text)
    setLinks(urls)
    setStatus('done')
    pool.refetch()
  }

  // Send runs as one contract call through the shared transaction flow.
  const tx = useTx()
  const sendDone = action.type === 'send' && tx.phase === 'success'
  useEffect(() => {
    if (!sendDone || settled.current) return
    settled.current = true
    if (address && valueUsd !== undefined) recordSpend(address, valueUsd)
    pool.refetch()
  }, [sendDone, address, valueUsd, pool])

  // Preview a swap before asking for a signature. Quoting never signs or sends anything.
  const canQuote = action.type === 'swap' && isConnected && onArc && !blocked && status === 'idle'
  useEffect(() => {
    if (action.type !== 'swap' || !canQuote || !connector) return
    const guard = { cancelled: false }
    estimateSwap(connector, action)
      .then((e) => {
        if (!guard.cancelled) {
          setEstimate(e)
          setEstimateError(null)
        }
      })
      .catch((e: unknown) => {
        if (!guard.cancelled) setEstimateError(actionError(e))
      })
    return () => {
      guard.cancelled = true
    }
  }, [canQuote, action, connector])

  const confirm = async () => {
    if (!connector || blocked) return
    setError(null)
    if (action.type !== 'send') setStatus('running')
    try {
      if (action.type === 'send') {
        const { to, amount, token: t } = action
        const value = parseInput(amount, TOKEN_DECIMALS[t])
        if (value === undefined) throw new Error('invalid amount')
        void tx.run([
          {
            label: `Send ${amount} ${t}`,
            send: () => writeContractAsync({ address: ASSETS[t].address, abi: erc20Abi, functionName: 'transfer', args: [to, value], chainId: ARC_ID }),
          },
        ])
        return
      }
      if (action.type === 'swap') {
        const res = await runSwap(connector, action)
        resolve(
          `Swapped ${res.amountIn} ${res.tokenIn} for ${res.amountOut ?? 'your tokens'} ${res.tokenOut}.`,
          res.explorerUrl ? [{ label: 'View transaction', url: res.explorerUrl }] : [],
        )
        return
      }
      const res = await runBridge(connector, chainId, (id) => switchChainAsync({ chainId: id }), action, (i) => setReached((prev) => Math.max(prev, i)))
      if (res.state === 'success') {
        resolve(
          `Bridged ${action.amount} USDC from ${CHAIN_LABELS[action.from]} to ${CHAIN_LABELS[action.to]}.`,
          res.steps.filter((s) => s.explorerUrl).map((s) => ({ label: s.name, url: s.explorerUrl as string })),
        )
      } else {
        setError('The bridge did not finish. Funds already burned are not lost. Check the destination network before trying again.')
        setStatus('idle')
      }
    } catch (e) {
      setError(actionError(e))
      setStatus('idle')
    }
  }

  const running = status === 'running' || tx.busy
  const shownError = error ?? (tx.phase === 'error' ? tx.error : null)

  if (status === 'cancelled') {
    return (
      <p className="mt-2 text-xs" style={{ color: 'var(--subtle)' }}>
        Cancelled. Nothing was sent.
      </p>
    )
  }

  if (status === 'done' || sendDone) {
    return (
      <div role="status" className="mt-3 rounded-xl p-3 text-sm" style={{ background: 'rgba(94,224,138,0.1)', color: 'var(--success)' }}>
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
          <span>{sendDone && action.type === 'send' ? `Sent ${action.amount} ${action.token} to ${short(action.to)}.` : summary}</span>
        </div>
        {(sendDone && tx.hash ? [{ label: 'View transaction', url: buildTxExplorerUrl(ARC_ID, tx.hash) }] : links).slice(0, 4).map((l) => (
          <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="ml-6 mt-1 inline-flex items-center gap-1 text-xs font-semibold">
            {l.label} <ExternalLink className="size-3" />
          </a>
        ))}
      </div>
    )
  }

  const minReceived = estimate?.stopLimit.amount

  return (
    <div className="inner mt-3 p-4">
      <div className="display text-lg font-semibold">{title}</div>
      <dl className="mt-2 space-y-1.5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>{k}</dt>
            <dd className="num text-right font-medium">{v}</dd>
          </div>
        ))}
        {action.type === 'send' && (
          <div className="break-all text-xs" style={{ color: 'var(--subtle)' }}>
            {action.to}
          </div>
        )}
        {valueUsd !== undefined && (
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>Value</dt>
            <dd className="num font-medium">{`about $${valueUsd.toFixed(2)}`}</dd>
          </div>
        )}
        {bal !== undefined && (
          <div className="flex items-center justify-between gap-3">
            <dt style={{ color: 'var(--muted)' }}>Your balance</dt>
            <dd className="num font-medium">
              {action.type === 'bridge' ? `${fmtAsset(bal, 'USDC')} USDC` : `${fmtAsset(bal, token)} ${token}`}
            </dd>
          </div>
        )}
        {action.type === 'swap' && estimate && (
          <>
            <div className="flex items-center justify-between gap-3">
              <dt style={{ color: 'var(--muted)' }}>You receive (est.)</dt>
              <dd className="num font-medium">{`${Number(estimate.estimatedOutput.amount).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${action.tokenOut}`}</dd>
            </div>
            <div className="flex items-center justify-between gap-3">
              <dt style={{ color: 'var(--muted)' }}>Minimum received</dt>
              <dd className="num font-medium">{`${Number(minReceived).toLocaleString('en-US', { maximumFractionDigits: 6 })} ${action.tokenOut}`}</dd>
            </div>
          </>
        )}
      </dl>

      {[...verdict.blocks, ...(insufficient ? [`Insufficient ${token} for this amount.`] : []), ...(needsFees ? ['Keep some USDC back for network fees.'] : [])].map((b) => (
        <p key={b} className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(255,122,138,0.1)', color: 'var(--danger)' }}>
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {b}
        </p>
      ))}

      {verdict.needsRecipientAck && verdict.blocks.length === 0 && (
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-2.5 rounded-xl p-3 text-xs" style={{ background: 'rgba(245,197,107,0.1)', color: 'var(--warn)' }}>
          <input type="checkbox" className="mt-0.5 size-4 shrink-0" checked={ack} onChange={(e) => setAck(e.target.checked)} disabled={running} />
          <span>This recipient is not in your saved list. I checked the full address above and it is correct.</span>
        </label>
      )}

      {estimateError && action.type === 'swap' && (
        <p className="mt-3 text-xs" style={{ color: 'var(--warn)' }}>
          {estimateError}
        </p>
      )}

      {shownError && (
        <div role="alert" className="mt-3 flex items-start gap-2 rounded-xl p-3 text-xs" style={{ background: 'rgba(255,122,138,0.1)', color: 'var(--danger)' }}>
          <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
          <span>{shownError}</span>
        </div>
      )}

      {action.type === 'bridge' && running && (
        <p className="mt-3 text-xs" style={{ color: 'var(--muted)' }}>
          {BRIDGE_STEPS[Math.min(reached + 1, BRIDGE_STEPS.length - 1)]}. Keep this tab open.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        {!isConnected ? (
          <ConnectCta className="btn-primary flex-1" />
        ) : needsArc ? (
          <button className="btn-primary flex-1" disabled={switching} onClick={() => void switchChainAsync({ chainId: ARC_ID })}>
            {switching && <Loader2 className="size-4 animate-spin" />} Switch to Arc Testnet
          </button>
        ) : (
          <button
            className="btn-primary flex-1"
            disabled={blocked || running || (verdict.needsRecipientAck && !ack) || (action.type === 'swap' && !estimate)}
            onClick={() => void confirm()}
          >
            {running ? (
              <>
                <Loader2 className="size-4 animate-spin" /> {tx.phase === 'confirming' ? 'Confirming' : 'Confirm in wallet'}
              </>
            ) : action.type === 'swap' && !estimate && !blocked ? (
              'Getting quote'
            ) : (
              'Confirm in wallet'
            )}
          </button>
        )}
        <button className="btn-ghost" disabled={running} onClick={() => setStatus('cancelled')}>
          Cancel
        </button>
      </div>
    </div>
  )
}
