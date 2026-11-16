import { useEffect, useRef, useState } from 'react'
import { Loader2, SendHorizontal, Sparkles } from 'lucide-react'
import { useAccount } from 'wagmi'
import { usePool } from '@/hooks/usePool'
import { fetchAiStatus, interpret, type AiStatus } from '@/agent/interpret'
import { useLimits } from '@/agent/limits'
import type { AgentAction } from '@/agent/schema'
import { ActionCard } from './ActionCard'
import { LimitsPanel } from './LimitsPanel'
import { AgentPanel } from './AgentPanel'
import { useAgentWallet } from '@/agent/useAgentWallet'

interface Message {
  id: number
  role: 'user' | 'assistant'
  text: string
  /** The user message this reply answers, kept so limits can check the recipient was really typed. */
  prompt?: string
  action?: AgentAction
  /** Set when the agent wallet already ran or refused the request. */
  outcome?: 'done' | 'blocked' | 'failed' | 'pending' | 'info'
  links?: { label: string; url: string }[]
}

type Mode = 'wallet' | 'agent'

const SUGGESTIONS = ['swap 5 USDC to EURC', 'bridge 10 USDC from Ethereum to Arc', 'send 1 USDC to 0x...']

const INTRO: Message = {
  id: 0,
  role: 'assistant',
  text: 'Tell me what to send, swap or bridge. I draft it, check it against your limits, and nothing moves until you confirm in your wallet.',
}

export function AssistantPage() {
  const { address } = useAccount()
  const pool = usePool()
  const { limits, update } = useLimits()
  const [messages, setMessages] = useState<Message[]>([INTRO])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [ai, setAi] = useState<AiStatus>({ configured: false })
  const [mode, setMode] = useState<Mode>('wallet')
  const agent = useAgentWallet(ai.agentAvailable === true)
  const nextId = useRef(1)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void fetchAiStatus().then(setAi)
  }, [])

  // Scroll the chat itself to the newest message. Scrolling the page would jump it on load.
  useEffect(() => {
    const list = listRef.current
    if (list && messages.length > 1) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [messages.length, busy])

  const send = async (raw: string) => {
    const text = raw.trim().slice(0, 500)
    if (!text || busy) return
    setInput('')
    setBusy(true)
    const userMsg: Message = { id: nextId.current++, role: 'user', text }
    setMessages((m) => [...m, userMsg])
    if (mode === 'agent') {
      const res = agent.status?.wallet
        ? await agent.chat(text)
        : { status: 'info' as const, reply: 'Create your agent wallet first, in the panel on the right.', links: [] }
      setMessages((m) => [...m, { id: nextId.current++, role: 'assistant', text: res.reply, outcome: res.status, links: res.links }])
      setBusy(false)
      return
    }
    const res = await interpret(text, limits.contacts, ai.configured)
    setMessages((m) => [...m, { id: nextId.current++, role: 'assistant', text: res.reply, prompt: text, action: res.action }])
    setBusy(false)
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <section className="card flex h-[min(44rem,calc(100dvh-9rem))] min-h-[28rem] flex-col p-4 sm:p-5" aria-label="Assistant chat">
        <div className="mb-3 flex items-center justify-between gap-2">
          <h1 className="display text-2xl font-semibold">Assistant</h1>
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{ background: 'var(--surface-strong)', color: ai.configured ? 'var(--success)' : 'var(--muted)' }}
            title={ai.configured ? 'Free-form requests are read by an AI model.' : 'No AI key is set on the server, so only plain commands work.'}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
            {ai.configured ? 'AI on' : 'Basic commands'}
          </span>
        </div>

        <div className="mb-3 grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: 'var(--surface-muted)' }} role="group" aria-label="How actions are approved">
          {(
            [
              ['wallet', 'Confirm in my wallet'],
              ['agent', 'Agent wallet'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={mode === id}
              className="min-h-11 rounded-lg px-2 text-sm font-semibold transition-colors"
              style={mode === id ? { background: 'var(--surface-strong)', color: 'var(--ink)' } : { color: 'var(--muted)' }}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'agent' && (
          <p className="mb-3 text-xs" style={{ color: 'var(--muted)' }}>
            The agent wallet runs sends and swaps for you with no popups, inside the limits saved on the server. Bridging still needs your own wallet.
          </p>
        )}

        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
          {messages.map((m) => (
            <div key={m.id} className={m.role === 'user' ? 'flex justify-end' : 'flex'}>
              <div
                className="max-w-[92%] rounded-2xl px-3.5 py-2.5 text-sm"
                style={
                  m.role === 'user'
                    ? { background: 'var(--accent)', color: 'var(--accent-ink)' }
                    : { background: 'var(--surface-strong)', color: m.outcome === 'done' ? 'var(--success)' : m.outcome === 'blocked' || m.outcome === 'failed' ? 'var(--warn)' : undefined }
                }
              >
                <p className="text-pretty">{m.text}</p>
                {m.action && m.prompt && <ActionCard action={m.action} message={m.prompt} limits={limits} pool={pool} />}
                {m.links?.map((l) => (
                  <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="mt-1 block text-xs font-semibold" style={{ color: 'var(--accent)' }}>
                    {l.label}
                  </a>
                ))}
              </div>
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted)' }}>
              <Loader2 className="size-3.5 animate-spin" /> Reading your request
            </div>
          )}
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} className="chip" onClick={() => setInput(s)} disabled={busy}>
              {s}
            </button>
          ))}
        </div>

        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void send(input)
          }}
        >
          <input
            className="field inner min-h-12 min-w-0 flex-1 px-3.5 text-sm"
            placeholder="Send 5 USDC to 0x..., swap, or bridge"
            aria-label="Message the assistant"
            maxLength={500}
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button type="submit" className="btn-primary !min-w-12 !px-3" disabled={busy || input.trim() === ''} aria-label="Send message">
            <SendHorizontal className="size-4" />
          </button>
        </form>
        <p className="mt-2 text-center text-[11px]" style={{ color: 'var(--subtle)' }}>
          Testnet demo. Always check the amount and address before you confirm.
        </p>
      </section>

      {mode === 'agent' ? <AgentPanel agent={agent} available={ai.agentAvailable === true} /> : <LimitsPanel limits={limits} update={update} account={address} />}
    </div>
  )
}
