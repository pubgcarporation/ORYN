import { getAddress, toEventSelector } from 'viem'
import type { Clients } from './chain'
import { errText } from './chain'
import { getBorrowers, setBorrowers, type BorrowerState } from './state'
import type { Env } from './types'

const BORROW_TOPIC = toEventSelector('Borrow(address,address,uint256,uint256)')
const PAGE = 1000
const MAX_PAGES = 3
const MAX_TRACKED = 500

interface ApiLog {
  topics?: (string | null)[]
  blockNumber?: string
}

/**
 * Keeps the list of wallets that ever borrowed. Reads Borrow events from the explorer starting at the
 * pool's deploy block, then only newer blocks on every later run, so it never re-scans the whole chain.
 */
export async function discoverBorrowers(env: Env, c: Clients): Promise<{ state: BorrowerState; error?: string }> {
  const state = await getBorrowers(env)
  const known = new Set(state.addresses)
  let cursor = state.cursor
  let error: string | undefined
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${env.EXPLORER_BASE}/api?module=logs&action=getLogs&fromBlock=${cursor}&toBlock=latest&address=${env.POOL_ADDRESS}&topic0=${BORROW_TOPIC}&page=${page}&offset=${PAGE}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`explorer answered ${res.status}`)
      const body = (await res.json()) as { result?: unknown }
      const rows = Array.isArray(body.result) ? (body.result as ApiLog[]) : []
      for (const row of rows) {
        const topic = row.topics?.[1]
        if (typeof topic === 'string' && topic.length >= 42) known.add(getAddress(`0x${topic.slice(-40)}`).toLowerCase())
        if (row.blockNumber) cursor = Math.max(cursor, Number(BigInt(row.blockNumber)))
      }
      if (rows.length < PAGE) break
    }
    if (known.size === state.addresses.length) {
      // Nothing new: move the cursor close to the chain head so the next read is small.
      const head = Number(await c.testnet.getBlockNumber())
      cursor = Math.max(cursor, head - 50)
    }
  } catch (e) {
    error = `could not read borrow events: ${errText(e)}`
  }
  const next: BorrowerState = { cursor, addresses: [...known].slice(-MAX_TRACKED) }
  await setBorrowers(env, next, state)
  return { state: next, error }
}

/** Drops wallets with no debt. They are added again the next time they borrow. */
export async function pruneBorrowers(env: Env, state: BorrowerState, keep: string[]): Promise<BorrowerState> {
  const next = { cursor: state.cursor, addresses: keep }
  await setBorrowers(env, next, state)
  return next
}
