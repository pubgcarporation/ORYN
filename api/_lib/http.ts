import type { IncomingMessage, ServerResponse } from 'node:http'
import { aiStatus, cleanContacts, cleanMessage, interpretMessage } from './ai.js'
import { agentChat, createWallet, saveLimits, setPaused, walletStatus, withdraw } from './agent.js'
import { requireUser } from './auth.js'
import { HttpError } from './errors.js'
import { getStore, storageKind } from './store.js'

const MAX_BODY = 20_000

interface Answer {
  status: number
  body: unknown
}

const hits: number[] = []
/** A rough cap on AI calls per instance. Per-user caps below do the real work. */
function limited(): boolean {
  const now = Date.now()
  while (hits.length > 0 && now - hits[0] > 60_000) hits.shift()
  if (hits.length >= 60) return true
  hits.push(now)
  return false
}

async function perUserLimit(uid: string) {
  const minute = Math.floor(Date.now() / 60_000)
  if ((await getStore().incrBy(`agent:rate:${uid}:${minute}`, 1, 120)) > 12) throw new HttpError(429, 'rate_limited', 'Slow down. Try again in a minute.')
}

async function route(method: string, path: string, headers: IncomingMessage['headers'], body: Record<string, unknown>): Promise<Answer> {
  const ok = (b: unknown): Answer => ({ status: 200, body: b })

  if (method === 'GET' && path === '/health') {
    const ai = aiStatus()
    const storage = storageKind()
    const circleReady = Boolean(process.env.CIRCLE_API_KEY && process.env.CIRCLE_ENTITY_SECRET && process.env.VITE_PRIVY_APP_ID)
    return ok({ configured: ai.configured, provider: ai.provider, agent: { available: circleReady && storage !== 'none', storage } })
  }

  if (method === 'POST' && path === '/interpret') {
    if (limited()) throw new HttpError(429, 'rate_limited')
    const message = cleanMessage(body.message)
    if (!message) throw new HttpError(400, 'empty')
    const { reply, action } = await interpretMessage(message, cleanContacts(body.contacts))
    return ok({ reply, action: action ?? null })
  }

  if (path.startsWith('/agent/')) {
    const uid = await requireUser(headers.authorization)
    if (method === 'GET' && path === '/agent/status') return ok(await walletStatus(uid))
    if (method !== 'POST') throw new HttpError(404, 'not_found')
    if (path === '/agent/create') return ok(await createWallet(uid, body.owner))
    if (path === '/agent/limits') return ok(await saveLimits(uid, body.limits))
    if (path === '/agent/pause') return ok(await setPaused(uid, body.paused))
    if (path === '/agent/chat') {
      if (limited()) throw new HttpError(429, 'rate_limited')
      await perUserLimit(uid)
      return ok(await agentChat(uid, body.message))
    }
    if (path === '/agent/withdraw') {
      await perUserLimit(uid)
      return ok(await withdraw(uid, body.token, body.amount))
    }
  }

  throw new HttpError(404, 'not_found')
}

async function readBody(req: IncomingMessage & { body?: unknown }): Promise<Record<string, unknown>> {
  if (req.body !== undefined && req.body !== null) {
    const parsed = typeof req.body === 'string' ? (JSON.parse(req.body) as unknown) : req.body
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  }
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > MAX_BODY) throw new HttpError(413, 'too_large')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

/** One entry point for both the Vercel function and the local development server. */
export async function handle(req: IncomingMessage & { body?: unknown }, res: ServerResponse): Promise<void> {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  try {
    const path = new URL(req.url ?? '/', 'http://local').pathname.replace(/^\/api/, '') || '/'
    const body = req.method === 'POST' ? await readBody(req) : {}
    const answer = await route(req.method ?? 'GET', path, req.headers, body)
    send(answer.status, answer.body)
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message })
    if (e instanceof SyntaxError) return send(400, { error: 'bad_json' })
    // Never echo upstream errors: they can carry keys or user text. Log only the kind.
    console.error('api error:', e instanceof Error ? e.name : 'unknown')
    send(502, { error: 'unavailable', message: 'Something went wrong. Please try again.' })
  }
}
