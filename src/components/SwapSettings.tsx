import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

export const SLIPPAGE_PRESETS = [10, 50, 100] as const
export const MIN_SLIPPAGE_BPS = 1
export const MAX_SLIPPAGE_BPS = 2000
export const DEFAULT_SLIPPAGE_BPS = 50

const STORAGE_KEY = 'oryn:slippage-bps'

/** Last slippage the person chose, restored on the next visit. */
export function loadSlippage(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY))
    if (Number.isInteger(n) && n >= MIN_SLIPPAGE_BPS && n <= MAX_SLIPPAGE_BPS) return n
  } catch {
    // Storage can be blocked in an embedded frame.
  }
  return DEFAULT_SLIPPAGE_BPS
}

function save(bps: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(bps))
  } catch {
    // Ignore: the setting just will not persist.
  }
}

export const pct = (bps: number) => `${+(bps / 100).toFixed(2)}%`

/** Advice for the current tolerance, or null when it is in a sensible range. */
export function slippageWarning(bps: number): string | null {
  if (bps < 10) return 'Very tight. The swap may fail when the price moves slightly.'
  if (bps > 500) return 'High slippage. You may receive much less than quoted.'
  return null
}

interface Props {
  bps: number
  onChange: (bps: number) => void
  disabled?: boolean
}

/** Slippage presets plus a custom field. Tolerance is the worst price move you accept before the swap reverts. */
export function SwapSettings({ bps, onChange, disabled }: Props) {
  const isPreset = (SLIPPAGE_PRESETS as readonly number[]).includes(bps)
  const [custom, setCustom] = useState(isPreset ? '' : String(bps / 100))
  const [invalid, setInvalid] = useState(false)
  const warning = slippageWarning(bps)

  const choose = (next: number) => {
    onChange(next)
    save(next)
  }

  return (
    <div className="inner mb-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">Slippage tolerance</span>
        <span className="num text-sm font-semibold" style={{ color: 'var(--accent)' }}>
          {pct(bps)}
        </span>
      </div>
      <p className="mt-1 text-xs" style={{ color: 'var(--subtle)' }}>
        The swap reverts if the price moves against you by more than this.
      </p>

      <div className="mt-3 grid grid-cols-4 gap-2">
        {SLIPPAGE_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            disabled={disabled}
            aria-pressed={bps === p}
            className="chip !min-w-0"
            style={bps === p ? { borderColor: 'var(--accent)', background: 'var(--surface-strong)', color: 'var(--ink)' } : undefined}
            onClick={() => {
              setCustom('')
              setInvalid(false)
              choose(p)
            }}
          >
            {pct(p)}
          </button>
        ))}
        <label
          className="flex min-h-9 items-center rounded-full border px-3 text-xs font-semibold [@media(pointer:coarse)]:min-h-11"
          style={{ borderColor: !isPreset ? 'var(--accent)' : invalid ? 'var(--danger)' : 'var(--border)' }}
        >
          <span className="sr-only">Custom slippage percent</span>
          <input
            inputMode="decimal"
            placeholder="Custom"
            value={custom}
            disabled={disabled}
            onChange={(e) => {
              const v = e.target.value.replace(/[^0-9.]/g, '')
              if (!/^\d*\.?\d{0,2}$/.test(v)) return
              setCustom(v)
              const n = Math.round(Number(v) * 100)
              const ok = v !== '' && Number.isFinite(n) && n >= MIN_SLIPPAGE_BPS && n <= MAX_SLIPPAGE_BPS
              setInvalid(v !== '' && !ok)
              if (ok) choose(n)
            }}
            className="num w-full min-w-0 bg-transparent text-right outline-none placeholder:text-[var(--subtle)]"
            style={{ fontSize: 16 }}
          />
          <span className="ml-0.5" style={{ color: 'var(--subtle)' }}>
            %
          </span>
        </label>
      </div>

      {invalid && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger)' }}>
          Enter between {pct(MIN_SLIPPAGE_BPS)} and {pct(MAX_SLIPPAGE_BPS)}.
        </p>
      )}
      {warning && !invalid && (
        <p className="mt-2 flex items-start gap-1.5 text-xs" style={{ color: 'var(--warn)' }}>
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          {warning}
        </p>
      )}
    </div>
  )
}
