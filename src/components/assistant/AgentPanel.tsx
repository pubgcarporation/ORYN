import { useEffect, useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, Loader2, Pause, Play } from 'lucide-react'
import { ConnectCta } from '@/auth/ConnectCta'
import { buildAddressExplorerUrl } from '@/onchain-facts'
import { ARC_ID } from '@/lib/pool'
import type { Limits } from '@/agent/rules'
import type { useAgentWallet } from '@/agent/useAgentWallet'
import { AgentMoney } from './AgentMoney'
import { LimitsPanel } from './LimitsPanel'

type Agent = ReturnType<typeof useAgentWallet>

interface Props {
  agent: Agent
  available: boolean
}

const ago = (at: number) => {
  const s = Math.max(1, Math.round((Date.now() - at) / 1000))
  if (s < 90) return `${s}s ago`
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-sm" style={{ color: 'var(--muted)' }}>
      {children}
    </p>
  )
}

/** The agent wallet: a separate wallet the assistant spends from on its own, inside limits the server enforces. */
export function AgentPanel({ agent, available }: Props) {
  const { status, loading, error, authenticated } = agent
  const wallet = status?.wallet ?? null
  const [creating, setCreating] = useState(false)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<Limits | undefined>(status?.limits)
  const [saving, setSaving] = useState(false)
  const [savedNote, setSavedNote] = useState(false)

  // Take in limits from the server only when they really changed there. A background refresh returns
  // an equal copy, and must not wipe what the person is typing.
  const serverLimits = status?.limits
  const serverKey = useMemo(() => JSON.stringify(serverLimits ?? null), [serverLimits])
  useEffect(() => {
    const t = setTimeout(() => setDraft(JSON.parse(serverKey) as typeof serverLimits), 0)
    return () => clearTimeout(t)
  }, [serverKey])

  const dirty = draft !== undefined && JSON.stringify(draft) !== serverKey

  const copy = async () => {
    if (!wallet) return
    try {
      await navigator.clipboard.writeText(wallet.address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard can be blocked inside frames; the address stays selectable */
    }
  }

  return (
    <section className="card space-y-4 p-4 sm:p-5" aria-label="Agent wallet">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-semibold">Agent wallet</h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            A separate wallet the assistant spends from with no popups, inside your limits. Testnet only.
          </p>
        </div>
        {wallet && (
          <button className="btn-ghost !min-h-11 gap-1.5" onClick={() => void agent.setPaused(!wallet.paused)} aria-pressed={wallet.paused}>
            {wallet.paused ? <Play className="size-4" /> : <Pause className="size-4" />}
            {wallet.paused ? 'Resume' : 'Pause'}
          </button>
        )}
      </div>

      {!available && (
        <Notice>
          The agent wallet is not set up on this server yet. It needs a Circle key and entity secret, your Privy app ID, and a Redis database on Vercel.
        </Notice>
      )}

      {available && !authenticated && (
        <>
          <Notice>Sign in so the server knows whose agent wallet this is.</Notice>
          <ConnectCta />
        </>
      )}

      {available && authenticated && !wallet && (
        <>
          <Notice>
            {loading ? 'Loading your agent wallet.' : 'You do not have an agent wallet yet. It starts with tight limits ($25 per action, $50 a day, saved recipients only), and withdrawals can only go back to your connected wallet.'}
          </Notice>
          {!loading && (
            <button
              className="btn-primary w-full"
              disabled={creating}
              onClick={() => {
                setCreating(true)
                void agent.create().finally(() => setCreating(false))
              }}
            >
              {creating && <Loader2 className="size-4 animate-spin" />} Create agent wallet
            </button>
          )}
        </>
      )}

      {wallet && (
        <>
          <div className="inner p-3">
            <span className="label">Address on Arc Testnet</span>
            <div className="mt-1 flex items-center justify-between gap-2">
              <button onClick={() => void copy()} className="num min-h-8 min-w-0 break-all text-left text-xs font-medium" style={{ color: 'var(--ink-2)' }}>
                {wallet.address}
              </button>
              <span className="flex shrink-0 items-center gap-1">
                <button className="btn-ghost !min-h-11 !min-w-11 !px-0" aria-label="Copy address" onClick={() => void copy()}>
                  {copied ? <Check className="size-4" style={{ color: 'var(--success)' }} /> : <Copy className="size-4" />}
                </button>
                <a className="btn-ghost !min-h-11 !min-w-11 !px-0" aria-label="View on explorer" href={buildAddressExplorerUrl(ARC_ID, wallet.address)} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="size-4" />
                </a>
              </span>
            </div>
            {wallet.paused && (
              <p className="mt-2 text-xs" style={{ color: 'var(--warn)' }}>
                Paused. The assistant will not spend until you resume.
              </p>
            )}
          </div>

          <AgentMoney agent={wallet.address} owner={wallet.owner} onWithdraw={agent.withdraw} />

          {status?.activity && status.activity.length > 0 && (
            <div>
              <p className="label mb-2">Recent activity</p>
              <ul className="space-y-1.5">
                {status.activity.slice(0, 8).map((a) => (
                  <li key={`${a.at}-${a.text}`} className="inner flex items-start justify-between gap-2 px-3 py-2 text-xs">
                    <span className="min-w-0" style={{ color: a.kind === 'blocked' || a.kind === 'failed' ? 'var(--warn)' : 'var(--ink-2)' }}>
                      {a.text}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5" style={{ color: 'var(--subtle)' }}>
                      {ago(a.at)}
                      {a.url && (
                        <a href={a.url} target="_blank" rel="noopener noreferrer" aria-label="View transaction">
                          <ExternalLink className="size-3" />
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {error && (
        <p role="alert" className="text-xs" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {wallet && draft && (
        <div className="space-y-2">
          <LimitsPanel limits={draft} update={(patch) => setDraft({ ...draft, ...patch })} account={wallet.address} spentUsd={status?.spentTodayUsd ?? 0} />
          <button
            className="btn-primary w-full"
            disabled={!dirty || saving}
            onClick={() => {
              setSaving(true)
              void agent.saveLimits(draft).then((ok) => {
                setSaving(false)
                setSavedNote(ok)
                setTimeout(() => setSavedNote(false), 2000)
              })
            }}
          >
            {saving && <Loader2 className="size-4 animate-spin" />} {savedNote ? 'Limits saved' : 'Save limits'}
          </button>
          <p className="text-center text-[11px]" style={{ color: 'var(--subtle)' }}>
            Limits are enforced on the server. Only saved recipients can be sent to.
          </p>
        </div>
      )}
    </section>
  )
}
