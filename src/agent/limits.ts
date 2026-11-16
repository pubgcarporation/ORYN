import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_LIMITS, sanitizeLimits, type Limits } from './rules'

export { DEFAULT_LIMITS, evaluate, sanitizeLimits, type Limits, type Verdict } from './rules'

const LIMITS_KEY = 'oryn.agent.limits.v1'
const LEDGER_PREFIX = 'oryn.agent.ledger.v1:'

const today = () => new Date().toISOString().slice(0, 10)

function loadLimits(): Limits {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LIMITS_KEY) ?? 'null')
    return raw ? sanitizeLimits(raw) : DEFAULT_LIMITS
  } catch {
    return DEFAULT_LIMITS
  }
}

/** Limits live in this browser only. The app re-checks them before every action, whatever the AI returned. */
export function useLimits() {
  const [limits, setLimits] = useState<Limits>(loadLimits)

  useEffect(() => {
    localStorage.setItem(LIMITS_KEY, JSON.stringify(limits))
  }, [limits])

  const update = useCallback((patch: Partial<Limits>) => setLimits((prev) => ({ ...prev, ...patch })), [])
  return { limits, update }
}

/** USD already spent today by this wallet through the assistant. Resets at 00:00 UTC. */
export function spentToday(address: string | undefined): number {
  if (!address) return 0
  try {
    const raw = JSON.parse(localStorage.getItem(LEDGER_PREFIX + address.toLowerCase()) ?? 'null') as { day?: string; spentUsd?: number } | null
    return raw?.day === today() && typeof raw.spentUsd === 'number' ? raw.spentUsd : 0
  } catch {
    return 0
  }
}

export function recordSpend(address: string, usd: number): void {
  const next = { day: today(), spentUsd: spentToday(address) + usd }
  localStorage.setItem(LEDGER_PREFIX + address.toLowerCase(), JSON.stringify(next))
}

