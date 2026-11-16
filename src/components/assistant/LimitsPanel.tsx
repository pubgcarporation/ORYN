import { useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { spentToday, type Limits } from '@/agent/limits'
import { CHAIN_KEYS, CHAIN_LABELS, TOKENS, toAddress } from '@/agent/schema'

interface Props {
  limits: Limits
  update: (patch: Partial<Limits>) => void
  account: string | undefined
  /** Spent today as tracked elsewhere, such as the server. Defaults to this browser's own record. */
  spentUsd?: number
}

function NumberField({ label, value, onChange, prefix, suffix, max }: { label: string; value: number; onChange: (n: number) => void; prefix?: string; suffix?: string; max?: number }) {
  return (
    <label className="inner block p-3">
      <span className="label">{label}</span>
      <span className="mt-1.5 flex items-center gap-1.5">
        {prefix && <span style={{ color: 'var(--subtle)' }}>{prefix}</span>}
        <input
          inputMode="decimal"
          className="field num min-w-0 text-xl font-semibold"
          value={Number.isFinite(value) ? String(value) : ''}
          onChange={(e) => {
            const v = Number(e.target.value.replace(/[^0-9.]/g, ''))
            if (Number.isFinite(v)) onChange(max !== undefined ? Math.min(max, v) : v)
          }}
        />
        {suffix && <span style={{ color: 'var(--subtle)' }}>{suffix}</span>}
      </span>
    </label>
  )
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <label className="chip inline-flex min-h-11 cursor-pointer items-center gap-2 px-3">
      <input type="checkbox" className="size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  )
}

/** Everything the assistant is allowed to do. Enforced in code before any wallet prompt. */
export function LimitsPanel({ limits, update, account, spentUsd }: Props) {
  const [label, setLabel] = useState('')
  const [addr, setAddr] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const spent = spentUsd ?? spentToday(account)

  const addContact = () => {
    const address = toAddress(addr)
    const name = label.trim().slice(0, 32)
    if (!name || !address) {
      setErr('Enter a name and a full 0x address.')
      return
    }
    if (limits.contacts.length >= 20) {
      setErr('You can save up to 20 recipients.')
      return
    }
    update({ contacts: [...limits.contacts.filter((c) => c.address !== address), { label: name, address }] })
    setLabel('')
    setAddr('')
    setErr(null)
  }

  return (
    <section className="card space-y-4 p-4 sm:p-5" aria-label="Assistant limits">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-lg font-semibold">Limits</h2>
          <p className="mt-0.5 text-xs" style={{ color: 'var(--muted)' }}>
            Checked in the app before every action, whatever the AI says. Saved in this browser.
          </p>
        </div>
        <Toggle checked={limits.enabled} onChange={(enabled) => update({ enabled })}>
          Enabled
        </Toggle>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Max per action" prefix="$" value={limits.maxPerActionUsd} onChange={(maxPerActionUsd) => update({ maxPerActionUsd })} />
        <NumberField label="Daily total" prefix="$" value={limits.dailyTotalUsd} onChange={(dailyTotalUsd) => update({ dailyTotalUsd })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <NumberField label="Max slippage" suffix="%" value={limits.maxSlippageBps / 100} max={10} onChange={(v) => update({ maxSlippageBps: Math.round(v * 100) })} />
        <div className="inner p-3">
          <span className="label">Spent today (UTC)</span>
          <div className="num mt-1.5 text-xl font-semibold">${spent.toFixed(2)}</div>
        </div>
      </div>

      <div>
        <p className="label mb-2">Allowed tokens</p>
        <div className="flex flex-wrap gap-2">
          {TOKENS.map((t) => (
            <Toggle key={t} checked={limits.tokens[t]} onChange={(v) => update({ tokens: { ...limits.tokens, [t]: v } })}>
              {t}
            </Toggle>
          ))}
        </div>
      </div>

      <div>
        <p className="label mb-2">Allowed networks for bridging</p>
        <div className="flex flex-wrap gap-2">
          {CHAIN_KEYS.map((c) => (
            <Toggle key={c} checked={limits.chains[c]} onChange={(v) => update({ chains: { ...limits.chains, [c]: v } })}>
              {CHAIN_LABELS[c]}
            </Toggle>
          ))}
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="label">Saved recipients</p>
          <Toggle checked={limits.strictRecipients} onChange={(strictRecipients) => update({ strictRecipients })}>
            Only these
          </Toggle>
        </div>
        {limits.contacts.length === 0 && (
          <p className="text-xs" style={{ color: 'var(--subtle)' }}>
            None saved. Any address needs your extra confirmation before it is sent to.
          </p>
        )}
        <ul className="space-y-1.5">
          {limits.contacts.map((c) => (
            <li key={c.address} className="inner flex items-center justify-between gap-2 px-3 py-2">
              <span className="min-w-0">
                <span className="block text-sm font-semibold">{c.label}</span>
                <span className="num block truncate text-[11px]" style={{ color: 'var(--subtle)' }}>
                  {c.address}
                </span>
              </span>
              <button className="btn-ghost !min-h-11 !min-w-11 !px-0" aria-label={`Remove ${c.label}`} onClick={() => update({ contacts: limits.contacts.filter((x) => x.address !== c.address) })}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input className="field inner min-h-11 px-3 text-sm sm:w-32" placeholder="Name" aria-label="Recipient name" maxLength={32} value={label} onChange={(e) => setLabel(e.target.value)} />
          <input className="field inner num min-h-11 min-w-0 flex-1 px-3 text-sm" placeholder="0x address" aria-label="Recipient address" value={addr} onChange={(e) => setAddr(e.target.value)} />
          <button className="btn-ghost" onClick={addContact}>
            <Plus className="size-4" /> Add
          </button>
        </div>
        {err && (
          <p role="alert" className="mt-1.5 text-xs" style={{ color: 'var(--danger)' }}>
            {err}
          </p>
        )}
      </div>
    </section>
  )
}
