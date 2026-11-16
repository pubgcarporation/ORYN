// The agent wallet: one Circle developer-controlled wallet per signed-in user, driven by the assistant.
// Every limit is checked here, on the server, before anything is signed.
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets'
import { AppKit, type SwapEstimate } from '@circle-fin/app-kit'
import { createCircleWalletsAdapter } from '@circle-fin/adapter-circle-wallets'
import { parseUnits, type Address } from 'viem'
import { buildTxExplorerUrl } from '../../src/onchain-facts.js'
import { waitForSuccessfulTransaction } from '../../src/onchain-wait.js'
import { spendable } from '../../src/lib/gas.js'
import { evaluate, sanitizeLimits, type Limits } from '../../src/agent/rules.js'
import { TOKEN_DECIMALS, toAddress, toAmount, toToken, type AgentAction, type Token } from '../../src/agent/schema.js'
import { HttpError } from './errors.js'
import { getStore, type Store } from './store.js'
import { ARC_ID, balanceOf, readPricesUsd, tokenAddress } from './chain.js'
import { cleanMessage, interpretMessage } from './ai.js'

interface WalletRecord {
  walletId: string
  address: Address
  /** The only place a withdrawal can go. Set once, when the wallet is created. */
  owner: Address
  limits: Limits
  paused: boolean
  createdAt: number
}

export interface ActivityEntry {
  at: number
  kind: 'send' | 'swap' | 'withdraw' | 'blocked' | 'failed'
  text: string
  usd?: number
  url?: string
}

export interface ChatResult {
  status: 'info' | 'done' | 'blocked' | 'failed' | 'pending'
  reply: string
  links: { label: string; url: string }[]
  source?: 'ai' | 'basic'
}

const DAY_SECONDS = 60 * 60 * 24 * 2
const kit = new AppKit()

const recKey = (uid: string) => `agent:wallet:${uid}`
const logKey = (uid: string) => `agent:log:${uid}`
const spentKey = (uid: string) => `agent:spent:${uid}:${new Date().toISOString().slice(0, 10)}`

function circle() {
  const apiKey = process.env.CIRCLE_API_KEY
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET
  if (!apiKey || !entitySecret) throw new HttpError(503, 'circle_not_configured', 'Set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET on the server to turn on the agent wallet.')
  return { client: initiateDeveloperControlledWalletsClient({ apiKey, entitySecret }), apiKey, entitySecret }
}

async function loadRecord(store: Store, uid: string): Promise<WalletRecord | undefined> {
  const raw = await store.get(recKey(uid))
  if (!raw) return undefined
  const rec = JSON.parse(raw) as WalletRecord
  return { ...rec, limits: sanitizeLimits(rec.limits) }
}

async function requireRecord(store: Store, uid: string): Promise<WalletRecord> {
  const rec = await loadRecord(store, uid)
  if (!rec) throw new HttpError(404, 'no_wallet', 'Create your agent wallet first.')
  return rec
}

async function log(store: Store, uid: string, entry: Omit<ActivityEntry, 'at'>) {
  await store.push(logKey(uid), JSON.stringify({ at: Date.now(), ...entry }), 30)
}

export async function walletStatus(uid: string) {
  const store = getStore()
  const rec = await loadRecord(store, uid)
  if (!rec) return { wallet: null }
  const spentCents = Number((await store.get(spentKey(uid))) ?? 0)
  const activity = (await store.list(logKey(uid), 20)).map((l) => JSON.parse(l) as ActivityEntry)
  return {
    wallet: { address: rec.address, owner: rec.owner, paused: rec.paused },
    limits: rec.limits,
    spentTodayUsd: spentCents / 100,
    activity,
  }
}

export async function createWallet(uid: string, ownerInput: unknown) {
  const store = getStore()
  const owner = toAddress(ownerInput)
  if (!owner) throw new HttpError(400, 'bad_owner', 'Connect a wallet first. Withdrawals go back to it.')
  if (await loadRecord(store, uid)) throw new HttpError(409, 'exists', 'You already have an agent wallet.')
  // Two taps at once must not create two wallets.
  if ((await store.incrBy(`agent:creating:${uid}`, 1, 120)) > 1) throw new HttpError(409, 'busy', 'Your wallet is being created. Wait a moment.')

  const { client } = circle()
  const set = await client.createWalletSet({ name: `oryn-agent-${uid.slice(-8)}` })
  const walletSetId = set.data?.walletSet?.id
  if (!walletSetId) throw new HttpError(502, 'unavailable', 'Circle did not create the wallet. Try again.')
  const made = await client.createWallets({ accountType: 'EOA', blockchains: ['ARC-TESTNET'], count: 1, walletSetId })
  const wallet = made.data?.wallets?.[0]
  const address = toAddress(wallet?.address)
  if (!wallet?.id || !address) throw new HttpError(502, 'unavailable', 'Circle did not create the wallet. Try again.')

  const rec: WalletRecord = { walletId: wallet.id, address, owner, limits: sanitizeLimits(undefined), paused: false, createdAt: Date.now() }
  // Starts tight: the person raises limits on purpose.
  rec.limits = { ...rec.limits, maxPerActionUsd: 25, dailyTotalUsd: 50, strictRecipients: true }
  await store.set(recKey(uid), JSON.stringify(rec))
  return walletStatus(uid)
}

export async function saveLimits(uid: string, input: unknown) {
  const store = getStore()
  const rec = await requireRecord(store, uid)
  rec.limits = sanitizeLimits(input)
  await store.set(recKey(uid), JSON.stringify(rec))
  return walletStatus(uid)
}

export async function setPaused(uid: string, paused: unknown) {
  const store = getStore()
  const rec = await requireRecord(store, uid)
  rec.paused = paused === true
  await store.set(recKey(uid), JSON.stringify(rec))
  return walletStatus(uid)
}

async function sendToken(rec: WalletRecord, token: Token, amount: string, to: Address) {
  const { client } = circle()
  const tx = await client.createTransaction({
    walletId: rec.walletId,
    tokenAddress: tokenAddress(token),
    destinationAddress: to,
    amount: [amount],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
  })
  const id = tx.data?.id
  if (!id) throw new Error('no transaction id')
  const done = await waitForSuccessfulTransaction(
    () => client.getTransaction({ id }),
    (r) => r.data?.transaction?.state,
    { timeoutMs: 40_000, label: 'Transfer' },
  )
  const hash = done.data?.transaction?.txHash
  return hash ? buildTxExplorerUrl(ARC_ID, hash) : undefined
}

const sdkToken = (t: Token) => (t === 'cirBTC' ? 'CIRBTC' : t) as SwapEstimate['tokenIn']

async function swapTokens(rec: WalletRecord, action: Extract<AgentAction, { type: 'swap' }>, prices: Record<Token, number>, valueUsd: number) {
  const { apiKey, entitySecret } = circle()
  const adapter = createCircleWalletsAdapter({ apiKey, entitySecret })
  const params = {
    from: { adapter, chain: 'Arc_Testnet' as const, address: rec.address },
    tokenIn: sdkToken(action.tokenIn),
    tokenOut: sdkToken(action.tokenOut),
    amountIn: action.amount,
    config: { slippageBps: action.slippageBps },
  }
  const estimate = await kit.estimateSwap(params)
  // A thin testnet pool can quote far below the market. Refuse rather than swap into it.
  const outUsd = Number(estimate.estimatedOutput.amount) * prices[action.tokenOut]
  if (!(outUsd >= valueUsd * 0.95)) throw new HttpError(422, 'bad_quote', 'The swap quote is more than 5% below the market price, so I did not run it. Try a smaller amount.')
  const result = await kit.swap(params)
  return result
}

const blocked = (reply: string): ChatResult => ({ status: 'blocked', reply, links: [] })

/** Reads a request, checks every limit on the server, and only then moves money from the agent wallet. */
export async function agentChat(uid: string, messageInput: unknown): Promise<ChatResult> {
  const store = getStore()
  const rec = await requireRecord(store, uid)
  const message = cleanMessage(messageInput)
  if (!message) throw new HttpError(400, 'empty', 'Type a request.')

  const { reply, action, source } = await interpretMessage(message, rec.limits.contacts)
  if (!action) return { status: 'info', reply, links: [], source }

  if (rec.paused) return { ...blocked('The agent wallet is paused. Turn it back on to run actions.'), source }
  if (action.type === 'bridge') return { ...blocked('Bridging is not available from the agent wallet yet. Use the Bridge page, where you confirm in your own wallet.'), source }

  const token: Token = action.type === 'send' ? action.token : action.tokenIn
  let prices: Record<Token, number>
  try {
    prices = await readPricesUsd()
  } catch (e) {
    if (e instanceof HttpError) return { ...blocked(e.message), source }
    throw e
  }
  const valueUsd = Number(action.amount) * prices[token]
  const spentCents = Number((await store.get(spentKey(uid))) ?? 0)
  const verdict = evaluate({ action, limits: rec.limits, valueUsd, spentUsd: spentCents / 100, message, account: rec.address })

  const reasons = [...verdict.blocks]
  // Nobody is here to tick the "I checked this address" box, so an unsaved recipient never runs.
  if (verdict.needsRecipientAck) reasons.push('That recipient is not saved. Add it to your saved recipients first.')

  const raw = parseUnits(action.amount, TOKEN_DECIMALS[token])
  if (reasons.length === 0) {
    const bal = await balanceOf(rec.address, token)
    if (raw > bal) reasons.push(`The agent wallet holds less than ${action.amount} ${token}. Fund it first.`)
    else if (raw > spendable(bal, token === 'USDC')) reasons.push('Keep some USDC in the agent wallet for network fees.')
  }
  if (reasons.length > 0) {
    await log(store, uid, { kind: 'blocked', text: `Blocked: ${message.slice(0, 80)}. ${reasons[0]}` })
    return { ...blocked(reasons.join(' ')), source }
  }

  // Reserve the spend first, so two requests at once cannot both pass the daily limit.
  const cents = Math.ceil(valueUsd * 100)
  const total = await store.incrBy(spentKey(uid), cents, DAY_SECONDS)
  if (total / 100 > rec.limits.dailyTotalUsd) {
    await store.incrBy(spentKey(uid), -cents, DAY_SECONDS)
    return { ...blocked('That would pass your daily total.'), source }
  }

  try {
    if (action.type === 'send') {
      const url = await sendToken(rec, action.token, action.amount, action.to)
      const text = `Sent ${action.amount} ${action.token} to ${action.to.slice(0, 6)}...${action.to.slice(-4)}`
      await log(store, uid, { kind: 'send', text, usd: valueUsd, url })
      return { status: 'done', reply: `${text}.`, links: url ? [{ label: 'View transaction', url }] : [], source }
    }
    const res = await swapTokens(rec, action, prices, valueUsd)
    const text = `Swapped ${res.amountIn} ${res.tokenIn} for ${res.amountOut ?? 'your tokens'} ${res.tokenOut}`
    await log(store, uid, { kind: 'swap', text, usd: valueUsd, url: res.explorerUrl })
    return { status: 'done', reply: `${text}.`, links: res.explorerUrl ? [{ label: 'View transaction', url: res.explorerUrl }] : [], source }
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TransactionTimeoutError'
    if (timedOut) {
      // It may still land, so the reservation stays.
      await log(store, uid, { kind: 'send', text: 'Waiting for Circle to confirm a transfer', usd: valueUsd })
      return { status: 'pending', reply: 'The transfer is taking longer than usual. Check the activity list in a minute.', links: [], source }
    }
    await store.incrBy(spentKey(uid), -cents, DAY_SECONDS)
    const reason = e instanceof HttpError ? e.message : 'The action could not be completed. Nothing was counted against your limits.'
    await log(store, uid, { kind: 'failed', text: reason })
    return { status: 'failed', reply: reason, links: [], source }
  }
}

/** Moves funds from the agent wallet back to its owner. This is the only way money leaves besides limited actions. */
export async function withdraw(uid: string, tokenInput: unknown, amountInput: unknown): Promise<ChatResult> {
  const store = getStore()
  const rec = await requireRecord(store, uid)
  const token = toToken(tokenInput)
  const amount = token ? toAmount(amountInput, TOKEN_DECIMALS[token]) : undefined
  if (!token || !amount) throw new HttpError(400, 'bad_request', 'Pick a token and a valid amount.')
  const bal = await balanceOf(rec.address, token)
  const raw = parseUnits(amount, TOKEN_DECIMALS[token])
  if (raw > bal) throw new HttpError(400, 'insufficient', 'The agent wallet does not hold that much.')
  if (token === 'USDC' && raw > spendable(bal, true)) throw new HttpError(400, 'fees', 'Keep a little USDC in the wallet to pay network fees.')
  const url = await sendToken(rec, token, amount, rec.owner)
  const text = `Withdrew ${amount} ${token} to your wallet`
  await log(store, uid, { kind: 'withdraw', text, url })
  return { status: 'done', reply: `${text}.`, links: url ? [{ label: 'View transaction', url }] : [] }
}
