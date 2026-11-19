import { accountFrom, errText, makeClients, sleep } from './chain'
import { scanAndLiquidate } from './liquidator'
import { relayPrices } from './relay'
import { acquireLock, releaseLock, addActions, getActions, getCounter, getStatus, setCounter, setStatus } from './state'
import type { Action, Env, ExecutionContext, ScheduledController, Status } from './types'

/**
 * One run = a few short ticks inside a single cron invocation, so prices and liquidations are checked
 * every few seconds instead of once a minute. Each tick: copy any newer Chainlink price onto the
 * testnet feeds, then look for loans below the liquidation line and ask the pool to liquidate them.
 */
export async function run(env: Env): Promise<Status | null> {
  if (!acquireLock()) return getStatus(env)
  try {
    return await runChecks(env)
  } finally {
    releaseLock()
  }
}

async function runChecks(env: Env): Promise<Status | null> {
  const started = Date.now()
  const ticks = Math.max(1, Math.min(6, Number(env.TICKS_PER_RUN ?? '3')))
  const tickMs = Math.max(2000, Number(env.TICK_MS ?? '15000'))
  const c = makeClients(env)

  let relayerAddress: string | null = null
  let liquidatorAddress: string | null = null
  try {
    relayerAddress = accountFrom(env.RELAYER_PRIVATE_KEY)?.address ?? null
    liquidatorAddress = accountFrom(env.LIQUIDATOR_PRIVATE_KEY)?.address ?? null
  } catch (e) {
    await addActions(env, [{ t: Date.now(), kind: 'error', text: errText(e) }])
  }

  let status: Status = {
    lastRun: started,
    lastRunMs: 0,
    pricesFresh: null,
    priceAgeSec: {},
    borrowersWatched: 0,
    atRisk: 0,
    liquidatable: 0,
    liquidationsTotal: await getCounter(env, 'liquidations'),
    relayerAddress,
    liquidatorAddress,
    dryRun: env.DRY_RUN === '1',
    lastError: null,
  }

  for (let i = 0; i < ticks; i++) {
    const actions: Action[] = []
    try {
      const relay = await relayPrices(env, c)
      actions.push(...relay.actions)
      status.priceAgeSec = relay.ageSec
      const scan = await scanAndLiquidate(env, c, { refresh: i === 0 })
      actions.push(...scan.actions)
      status = {
        ...status,
        pricesFresh: scan.pricesFresh,
        borrowersWatched: scan.borrowersWatched || status.borrowersWatched,
        atRisk: scan.atRisk,
        liquidatable: scan.liquidatable,
        lastError: scan.error ?? null,
      }
      if (scan.liquidationsDone > 0) {
        const total = status.liquidationsTotal + scan.liquidationsDone
        await setCounter(env, 'liquidations', total)
        status.liquidationsTotal = total
      }
    } catch (e) {
      status.lastError = errText(e)
      actions.push({ t: Date.now(), kind: 'error', text: errText(e) })
    }
    await addActions(env, actions)
    if (i < ticks - 1) await sleep(tickMs)
  }

  status.lastRunMs = Date.now() - started
  await setStatus(env, status)
  return status
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
  })

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(run(env).then(() => undefined))
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' } })
    }
    if (url.pathname === '/health') return json({ ok: true })
    if (url.pathname === '/status' && request.method === 'GET') {
      // Public, read-only: wallet addresses and counters only. No keys, no secrets.
      return json({ status: await getStatus(env), actions: (await getActions(env)).slice(0, 20), pool: env.POOL_ADDRESS })
    }
    if (url.pathname === '/run' && request.method === 'POST') {
      const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: 'forbidden' }, 403)
      ctx.waitUntil(run(env).then(() => undefined))
      return json({ started: true }, 202)
    }
    return json({ error: 'not_found' }, 404)
  },
}
