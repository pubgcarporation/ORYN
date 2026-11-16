// Where the agent wallet keeps its state: the wallet record, the daily spend counter and the activity log.
// On Vercel a function forgets everything between calls, so it needs Redis (the Upstash integration).
// Locally, with no Redis set, a JSON file keeps things going.
import fs from 'node:fs'
import path from 'node:path'
import { HttpError } from './errors.js'

export interface Store {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  /** Atomic add. The key expires after `ttlSeconds`. Returns the new total. */
  incrBy(key: string, amount: number, ttlSeconds: number): Promise<number>
  /** Adds to the front of a list and keeps only the newest `max`. */
  push(key: string, value: string, max: number): Promise<void>
  list(key: string, max: number): Promise<string[]>
}

const redisUrl = () => process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
const redisToken = () => process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN

async function pipeline(commands: (string | number)[][]): Promise<{ result?: unknown; error?: string }[]> {
  const res = await fetch(`${redisUrl()}/pipeline`, {
    method: 'POST',
    headers: { authorization: `Bearer ${redisToken()}`, 'content-type': 'application/json' },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`redis ${res.status}`)
  const out = (await res.json()) as { result?: unknown; error?: string }[]
  if (out.some((o) => o.error)) throw new Error('redis command failed')
  return out
}

const redisStore: Store = {
  async get(key) {
    const [r] = await pipeline([['GET', key]])
    return typeof r.result === 'string' ? r.result : null
  },
  async set(key, value) {
    await pipeline([['SET', key, value]])
  },
  async incrBy(key, amount, ttlSeconds) {
    const [r] = await pipeline([
      ['INCRBY', key, amount],
      ['EXPIRE', key, ttlSeconds],
    ])
    return Number(r.result)
  },
  async push(key, value, max) {
    await pipeline([
      ['LPUSH', key, value],
      ['LTRIM', key, 0, max - 1],
    ])
  },
  async list(key, max) {
    const [r] = await pipeline([['LRANGE', key, 0, max - 1]])
    return Array.isArray(r.result) ? (r.result as string[]) : []
  },
}

// Local development only. Not safe across several processes, which is fine for one dev server.
const FILE = path.join(process.cwd(), '.agent-data', 'store.json')
interface FileData {
  kv: Record<string, string>
  lists: Record<string, string[]>
}

function readFile(): FileData {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')) as FileData
  } catch {
    return { kv: {}, lists: {} }
  }
}

function writeFile(data: FileData) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(data))
}

const fileStore: Store = {
  get: async (key) => readFile().kv[key] ?? null,
  async set(key, value) {
    const d = readFile()
    d.kv[key] = value
    writeFile(d)
  },
  async incrBy(key, amount) {
    const d = readFile()
    const next = Number(d.kv[key] ?? 0) + amount
    d.kv[key] = String(next)
    writeFile(d)
    return next
  },
  async push(key, value, max) {
    const d = readFile()
    d.lists[key] = [value, ...(d.lists[key] ?? [])].slice(0, max)
    writeFile(d)
  },
  list: async (key, max) => (readFile().lists[key] ?? []).slice(0, max),
}

export function storageKind(): 'redis' | 'file' | 'none' {
  if (redisUrl() && redisToken()) return 'redis'
  // A hosted function cannot keep a file between calls, so without Redis the agent wallet stays off.
  return process.env.VERCEL ? 'none' : 'file'
}

export function getStore(): Store {
  const kind = storageKind()
  if (kind === 'none') throw new HttpError(503, 'storage_not_configured', 'Add a Redis database (Upstash) to this Vercel project to turn on the agent wallet.')
  return kind === 'redis' ? redisStore : fileStore
}
