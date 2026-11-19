import { useEffect, useRef, useState } from 'react'
import { animate, useReducedMotion } from 'framer-motion'
import { Check, Copy, Droplets } from 'lucide-react'
import { TokenBTC, TokenEURC, TokenUSDC } from '@web3icons/react'
import type { AssetSymbol } from '@/lib/pool'

export function TokenBadge({ symbol, size = 32 }: { symbol: AssetSymbol; size?: number }) {
  if (symbol === 'USDC') return <TokenUSDC variant="branded" size={size} />
  if (symbol === 'cirBTC') return <TokenBTC variant="branded" size={size} />
  return <TokenEURC variant="branded" size={size} />
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="inner p-4">
      <div className="label">{label}</div>
      <div className="display num mt-1.5 break-words text-xl font-semibold sm:text-2xl">{value}</div>
      {sub && (
        <div className="mt-0.5 text-xs" style={{ color: 'var(--subtle)' }}>
          {sub}
        </div>
      )}
    </div>
  )
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="display text-balance text-3xl font-semibold sm:text-4xl">{title}</h1>
      {children && (
        <p className="mt-2 max-w-xl text-pretty text-sm" style={{ color: 'var(--muted)' }}>
          {children}
        </p>
      )}
    </div>
  )
}

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-white/10 ${className}`} />
}

/** Eases a number toward its latest value. Skips the animation for people who prefer reduced motion. */
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const reduce = useReducedMotion()
  const [display, setDisplay] = useState(value)
  const from = useRef(value)

  useEffect(() => {
    const controls = animate(from.current, value, { duration: reduce ? 0 : 0.9, ease: 'easeOut', onUpdate: setDisplay })
    from.current = value
    return () => controls.stop()
  }, [value, reduce])

  return <span className="num">{format(display)}</span>
}

export function FundWallet({ address }: { address: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* clipboard can be blocked inside frames; the address stays selectable */
    }
  }
  return (
    <div className="card mb-6 flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between" style={{ borderColor: 'rgba(185,166,255,0.35)' }}>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl" style={{ background: 'var(--surface-strong)' }}>
          <Droplets className="size-4" style={{ color: 'var(--accent)' }} />
        </div>
        <div>
          <div className="display font-semibold">Your wallet has no USDC yet</div>
          <p className="mt-0.5 text-sm" style={{ color: 'var(--muted)' }}>
            Send test USDC to your address on Arc Testnet to start. USDC also pays network fees on Arc.
          </p>
          <button onClick={() => void copy()} className="num mt-2 inline-flex items-center gap-1.5 break-all text-left text-xs font-medium" style={{ color: 'var(--ink-2)' }}>
            {address}
            {copied ? <Check className="size-3.5 shrink-0" style={{ color: 'var(--success)' }} /> : <Copy className="size-3.5 shrink-0" />}
          </button>
        </div>
      </div>
      <a href="https://faucet.circle.com" target="_blank" rel="noopener noreferrer" className="btn-primary shrink-0">
        Get test USDC
      </a>
    </div>
  )
}
