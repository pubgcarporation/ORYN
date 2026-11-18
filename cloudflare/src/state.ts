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

export async function addActions(env: Env, items: Action[]): Promise<void> {
  if (items.length === 0) return
  const current = await getActions(env)
  await env.STATE.put('actions', JSON.stringify([...items.reverse(), ...current].slice(0, MAX_ACTIONS)))
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

export async function setStatus(env: Env, status: Status): Promise<void> {
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

export async function setBorrowers(env: Env, state: BorrowerState): Promise<void> {
  await env.STATE.put('borrowers', JSON.stringify(state))
}

/** Best-effort lock so two overlapping runs do not both send transactions. */
export async function acquireLock(env: Env): Promise<boolean> {
  const held = await env.STATE.get('lock')
  if (held && Date.now() - Number(held) < 55_000) return false
  await env.STATE.put('lock', String(Date.now()), { expirationTtl: 60 })
  return true
}
