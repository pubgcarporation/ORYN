// Pure limit rules, shared by the browser and the agent wallet API. Relative `.js` imports keep it runnable in Node.
import { CHAIN_KEYS, TOKENS, type AgentAction, type ChainKey, type Token } from './schema.js'
import type { Contact } from './parse.js'

export interface Limits {
  enabled: boolean
  maxPerActionUsd: number
  dailyTotalUsd: number
  maxSlippageBps: number
  tokens: Record<Token, boolean>
  chains: Record<ChainKey, boolean>
  /** When on, sends are only allowed to saved recipients. */
  strictRecipients: boolean
  contacts: Contact[]
}

export const DEFAULT_LIMITS: Limits = {
  enabled: true,
  maxPerActionUsd: 100,
  dailyTotalUsd: 250,
  maxSlippageBps: 100,
  tokens: { USDC: true, EURC: true, cirBTC: true },
  chains: { arc: true, eth: true, base: true, arb: true, pol: true },
  strictRecipients: false,
  contacts: [],
}


export interface Verdict {
  /** Reasons the action cannot run. Any entry means the confirm button stays off. */
  blocks: string[]
  /** The recipient is not saved, so the user must tick a box to confirm they checked it. */
  needsRecipientAck: boolean
}

interface EvalInput {
  action: AgentAction
  limits: Limits
  valueUsd: number | undefined
  spentUsd: number
  /** What the user typed. A recipient address must appear in it or in the saved list. */
  message: string
  account: string | undefined
}

/** The one place limits are enforced. Pure, so it can be reasoned about and tested on its own. */
export function evaluate({ action, limits, valueUsd, spentUsd, message, account }: EvalInput): Verdict {
  const blocks: string[] = []
  let needsRecipientAck = false

  if (!limits.enabled) blocks.push('Assistant actions are turned off in your limits.')

  if (valueUsd === undefined) blocks.push('Waiting for live prices to check your limits.')
  else {
    if (valueUsd > limits.maxPerActionUsd) blocks.push(`About $${valueUsd.toFixed(2)} is over your $${limits.maxPerActionUsd} per-action limit.`)
    const left = Math.max(0, limits.dailyTotalUsd - spentUsd)
    if (valueUsd > left) blocks.push(`This would pass your $${limits.dailyTotalUsd} daily total. $${left.toFixed(2)} left today.`)
  }

  if (action.type === 'send') {
    if (!limits.tokens[action.token]) blocks.push(`${action.token} is not allowed in your limits.`)
    const saved = limits.contacts.some((c) => c.address.toLowerCase() === action.to.toLowerCase())
    const typed = message.toLowerCase().includes(action.to.toLowerCase())
    if (action.to === '0x0000000000000000000000000000000000000000') blocks.push('That is the zero address.')
    if (account && action.to.toLowerCase() === account.toLowerCase()) blocks.push('That is your own address.')
    if (!saved && !typed) blocks.push('The recipient address was not in your message, so it was not used.')
    if (!saved) {
      if (limits.strictRecipients) blocks.push('Your limits only allow saved recipients.')
      else needsRecipientAck = true
    }
  }

  if (action.type === 'swap') {
    if (!limits.tokens[action.tokenIn] || !limits.tokens[action.tokenOut]) blocks.push('One of these tokens is not allowed in your limits.')
    if (action.slippageBps > limits.maxSlippageBps) blocks.push(`Slippage is above your ${(limits.maxSlippageBps / 100).toFixed(2)}% limit.`)
  }

  if (action.type === 'bridge') {
    if (!limits.tokens.USDC) blocks.push('USDC is not allowed in your limits.')
    if (!limits.chains[action.from] || !limits.chains[action.to]) blocks.push('One of these networks is not allowed in your limits.')
  }

  return { blocks, needsRecipientAck }
}

function pickBooleans<K extends string>(source: unknown, keys: readonly K[]): Partial<Record<K, boolean>> {
  const out: Partial<Record<K, boolean>> = {}
  if (!source || typeof source !== 'object') return out
  for (const key of keys) {
    const v = (source as Record<string, unknown>)[key]
    if (typeof v === 'boolean') out[key] = v
  }
  return out
}

/** Turns stored or submitted limits into a well-formed Limits, filling gaps with the defaults. */
export function sanitizeLimits(input: unknown): Limits {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<Limits>
  const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback)
  return {
    enabled: raw.enabled !== false,
    maxPerActionUsd: num(raw.maxPerActionUsd, DEFAULT_LIMITS.maxPerActionUsd),
    dailyTotalUsd: num(raw.dailyTotalUsd, DEFAULT_LIMITS.dailyTotalUsd),
    maxSlippageBps: Math.min(1000, num(raw.maxSlippageBps, DEFAULT_LIMITS.maxSlippageBps)),
    tokens: { ...DEFAULT_LIMITS.tokens, ...pickBooleans(raw.tokens, TOKENS) },
    chains: { ...DEFAULT_LIMITS.chains, ...pickBooleans(raw.chains, CHAIN_KEYS) },
    strictRecipients: raw.strictRecipients === true,
    contacts: Array.isArray(raw.contacts)
      ? raw.contacts
          .filter((c): c is Contact => typeof c?.label === 'string' && typeof c?.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(c.address))
          .map((c) => ({ label: c.label.slice(0, 32), address: c.address }))
          .slice(0, 20)
      : [],
  }
}
