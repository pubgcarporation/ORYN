import type { Action, Env, Status } from './types'

const MAX_ACTIONS = 40

async function readJson<T>(env: Env, key: string, fallback: T): Promise<T> {
  const raw = await env.STATE.get(key)
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function getActions(env: Env): Promise<Action[]> {
  return readJson<Action[]>(env, 'actions', [])
}

/** The same message repeated within this window is logged once, so a stuck problem does not fill the log. */
const REPEAT_WINDOW_MS = 10 * 60_000

/** Cloudflare's free plan allows about 1,000 KV writes a day, so the log is only written when something new happened. */
export async function addActions(env: Env, items: Action[]): Promise<void> {
  if (items.length === 0) return
  const current = await getActions(env)
  const fresh = items.filter((a) => a.kind === 'relay' || a.kind === 'liquidate' || !current.some((c) => c.kind === a.kind && c.text === a.text && a.t - c.t < REPEAT_WINDOW_MS))
  if (fresh.length === 0) return
  await env.STATE.put('actions', JSON.stringify([...fresh.reverse(), ...current].slice(0, MAX_ACTIONS)))
}

export async function getCounter(env: Env, key: string): Promise<number> {
  return readJson<number>(env, key, 0)
}

export async function setCounter(env: Env, key: string, value: number): Promise<void> {
  await env.STATE.put(key, JSON.stringify(value))
}

export async function getStatus(env: Env): Promise<Status | null> {
  return readJson<Status | null>(env, 'status', null)
}

const STATUS_REFRESH_MS = 10 * 60_000

/** Saves the status when something changed, or at least every 10 minutes, to stay inside the free KV write limit. */
export async function setStatus(env: Env, status: Status): Promise<void> {
  const prev = await getStatus(env)
  const same =
    prev !== null &&
    status.lastRun - prev.lastRun < STATUS_REFRESH_MS &&
    prev.pricesFresh === status.pricesFresh &&
    prev.borrowersWatched === status.borrowersWatched &&
    prev.atRisk === status.atRisk &&
    prev.liquidatable === status.liquidatable &&
    prev.liquidationsTotal === status.liquidationsTotal &&
    prev.relayerAddress === status.relayerAddress &&
    prev.liquidatorAddress === status.liquidatorAddress &&
    prev.dryRun === status.dryRun &&
    prev.lastError === status.lastError
  if (same) return
  await env.STATE.put('status', JSON.stringify(status))
}

export interface BorrowerState {
  /** Next block to ask the explorer for Borrow events from. */
  cursor: number
  addresses: string[]
}

export async function getBorrowers(env: Env): Promise<BorrowerState> {
  return readJson<BorrowerState>(env, 'borrowers', { cursor: Number(env.POOL_DEPLOY_BLOCK), addresses: [] })
}

/** Moving the scan cursor alone is not worth a write until it has advanced a long way. */
const CURSOR_STEP = 20_000

export async function setBorrowers(env: Env, state: BorrowerState, previous?: BorrowerState): Promise<void> {
  if (previous && previous.addresses.length === state.addresses.length && state.addresses.every((a, i) => a === previous.addresses[i]) && state.cursor - previous.cursor < CURSOR_STEP) return
  await env.STATE.put('borrowers', JSON.stringify(state))
}

/** Stops two runs in the same Worker instance from overlapping. It costs no KV writes. */
let running = false

export function acquireLock(): boolean {
  if (running) return false
  running = true
  return true
}

export function releaseLock(): void {
  running = false
}
