import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronDown, X } from 'lucide-react'

export interface PickerOption<T extends string> {
  id: T
  label: string
  /** Second line under the label, for example the full token name. */
  sub?: string
  /** Right-aligned value, for example a balance. */
  right?: string
  icon: ReactNode
}

interface Props<T extends string> {
  /** Dialog heading, for example "Select network". */
  title: string
  value: T
  options: PickerOption<T>[]
  onChange: (id: T) => void
  disabled?: boolean
  /** Visible trigger label for screen readers, for example "Pay token". */
  label: string
}

/** A pill that shows the current choice and opens a sheet to change it. Used for tokens and networks. */
export function Picker<T extends string>({ title, value, options, onChange, disabled, label }: Props<T>) {
  const [open, setOpen] = useState(false)
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const selected = options.find((o) => o.id === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    closeRef.current?.focus()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-label={`${label}: ${selected.label}. Change`}
        className="flex min-h-11 shrink-0 items-center gap-2 rounded-full py-1.5 pl-2 pr-3 text-sm font-semibold transition-colors hover:bg-white/15 disabled:opacity-50"
        style={{ background: 'var(--surface-strong)' }}
      >
        <span className="flex size-6 items-center justify-center">{selected.icon}</span>
        <span className="whitespace-nowrap">{selected.label}</span>
        <ChevronDown className="size-4" style={{ color: 'var(--subtle)' }} aria-hidden="true" />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              className="card safe-bottom relative max-h-[80dvh] w-full max-w-sm overflow-y-auto rounded-b-none p-4 sm:rounded-3xl"
              style={{ background: 'rgba(18,36,58,0.98)' }}
              initial={{ y: 40, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 40, opacity: 0 }}
              transition={{ type: 'spring', stiffness: 380, damping: 34 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <h2 id={titleId} className="display text-lg font-semibold">
                  {title}
                </h2>
                <button ref={closeRef} className="btn-ghost !min-h-11 !min-w-11 !px-0" onClick={() => setOpen(false)} aria-label="Close">
                  <X className="size-4" />
                </button>
              </div>
              <ul className="space-y-1" role="listbox" aria-labelledby={titleId}>
                {options.map((o) => {
                  const active = o.id === value
                  return (
                    <li key={o.id} role="option" aria-selected={active}>
                      <button
                        type="button"
                        className="flex min-h-14 w-full items-center gap-3 rounded-2xl px-3 text-left transition-colors hover:bg-white/10"
                        style={{ background: active ? 'var(--surface-strong)' : 'transparent' }}
                        onClick={() => {
                          onChange(o.id)
                          setOpen(false)
                        }}
                      >
                        <span className="flex size-8 shrink-0 items-center justify-center">{o.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold">{o.label}</span>
                          {o.sub && (
                            <span className="block truncate text-xs" style={{ color: 'var(--subtle)' }}>
                              {o.sub}
                            </span>
                          )}
                        </span>
                        {o.right && <span className="num text-xs" style={{ color: 'var(--muted)' }}>{o.right}</span>}
                        {active && <Check className="size-4 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden="true" />}
                      </button>
                    </li>
                  )
                })}
              </ul>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
