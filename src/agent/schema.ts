// Shared by the browser and the AI server, so it imports only viem and uses relative paths.
import { getAddress, isAddress } from 'viem'

export const TOKENS = ['USDC', 'EURC', 'cirBTC'] as const
export type Token = (typeof TOKENS)[number]

export const TOKEN_DECIMALS: Record<Token, number> = { USDC: 6, EURC: 6, cirBTC: 8 }

export const CHAIN_KEYS = ['arc', 'eth', 'base', 'arb', 'pol'] as const
export type ChainKey = (typeof CHAIN_KEYS)[number]

export const CHAIN_LABELS: Record<ChainKey, string> = {
  arc: 'Arc Testnet',
  eth: 'Ethereum Sepolia',
  base: 'Base Sepolia',
  arb: 'Arbitrum Sepolia',
  pol: 'Polygon Amoy',
}

const CHAIN_ALIASES: Record<string, ChainKey> = {
  arc: 'arc',
  'arc testnet': 'arc',
  eth: 'eth',
  ethereum: 'eth',
  sepolia: 'eth',
  'ethereum sepolia': 'eth',
  base: 'base',
  'base sepolia': 'base',
  arb: 'arb',
  arbitrum: 'arb',
  'arbitrum sepolia': 'arb',
  pol: 'pol',
  polygon: 'pol',
  amoy: 'pol',
  'polygon amoy': 'pol',
}

export type Address = `0x${string}`

export type AgentAction =
  | { type: 'send'; token: Token; amount: string; to: Address }
  | { type: 'swap'; tokenIn: Token; tokenOut: Token; amount: string; slippageBps: number }
  | { type: 'bridge'; from: ChainKey; to: ChainKey; amount: string }

export const DEFAULT_SLIPPAGE_BPS = 50

export function toToken(value: unknown): Token | undefined {
  if (typeof value !== 'string') return undefined
  return TOKENS.find((t) => t.toLowerCase() === value.trim().toLowerCase())
}

export function toChain(value: unknown): ChainKey | undefined {
  if (typeof value !== 'string') return undefined
  return CHAIN_ALIASES[value.trim().toLowerCase().replace(/\s+/g, ' ')]
}

/** A plain positive decimal such as "12.5". Rejects exponents, signs and more fraction digits than the token has. */
export function toAmount(value: unknown, decimals: number): string | undefined {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : ''
  const match = /^(\d{1,15})(?:\.(\d{1,18}))?$/.exec(text)
  if (!match) return undefined
  if ((match[2]?.length ?? 0) > decimals) return undefined
  if (Number(text) <= 0) return undefined
  return text
}

export function toAddress(value: unknown): Address | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return isAddress(text, { strict: false }) ? getAddress(text.toLowerCase()) : undefined
}

/**
 * Turns anything an AI model returned into a well-formed action, or nothing.
 * Both the server and the browser run this: model output is never trusted as it arrives.
 */
export function sanitizeAction(raw: unknown): AgentAction | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const a = raw as Record<string, unknown>

  if (a.type === 'send') {
    const token = toToken(a.token)
    const to = toAddress(a.to)
    const amount = token ? toAmount(a.amount, TOKEN_DECIMALS[token]) : undefined
    return token && to && amount ? { type: 'send', token, amount, to } : undefined
  }

  if (a.type === 'swap') {
    const tokenIn = toToken(a.tokenIn)
    const tokenOut = toToken(a.tokenOut)
    const amount = tokenIn ? toAmount(a.amount, TOKEN_DECIMALS[tokenIn]) : undefined
    if (!tokenIn || !tokenOut || !amount || tokenIn === tokenOut) return undefined
    const bps = Number(a.slippageBps)
    const slippageBps = Number.isInteger(bps) && bps >= 1 && bps <= 1000 ? bps : DEFAULT_SLIPPAGE_BPS
    return { type: 'swap', tokenIn, tokenOut, amount, slippageBps }
  }

  if (a.type === 'bridge') {
    const from = toChain(a.from)
    const to = toChain(a.to)
    const amount = toAmount(a.amount, TOKEN_DECIMALS.USDC)
    return from && to && amount && from !== to ? { type: 'bridge', from, to, amount } : undefined
  }

  return undefined
}
