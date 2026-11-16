import { toAddress, toAmount, toChain, toToken, sanitizeAction, DEFAULT_SLIPPAGE_BPS, TOKEN_DECIMALS, type AgentAction } from './schema.js'

export interface Contact {
  label: string
  address: `0x${string}`
}

export interface Interpretation {
  reply: string
  action?: AgentAction
}

const TOKEN_WORD = '(usdc|eurc|cirbtc)'
const CHAIN_WORD = '(arc testnet|arc|ethereum sepolia|ethereum|sepolia|eth|base sepolia|base|arbitrum sepolia|arbitrum|arb|polygon amoy|polygon|amoy|pol)'

const HELP =
  'I can send, swap and bridge within your limits. Try "send 5 USDC to 0x...", "swap 10 USDC to EURC" or "bridge 20 USDC from Ethereum to Arc".'

/**
 * A strict command parser. It runs when no AI key is set on the server, or when the AI is unreachable,
 * so the assistant always works for plain commands.
 */
export function parseCommand(text: string, contacts: Contact[]): Interpretation {
  const input = text.trim().replace(/\s+/g, ' ')

  const send = new RegExp(`^(?:send|transfer|pay)\\s+([\\d.]+)\\s*${TOKEN_WORD}?\\s+to\\s+(\\S+)$`, 'i').exec(input)
  if (send) {
    const token = toToken(send[2] ?? 'USDC')
    if (!token) return { reply: HELP }
    const amount = toAmount(send[1], TOKEN_DECIMALS[token])
    if (!amount) return { reply: 'That amount is not valid. Use a plain number such as 5 or 0.25.' }
    const target = send[3]
    const contact = contacts.find((c) => c.label.toLowerCase() === target.toLowerCase())
    const to = contact?.address ?? toAddress(target)
    if (!to) return { reply: 'I need a full 0x address, or the name of a saved recipient from your limits.' }
    const action = sanitizeAction({ type: 'send', token, amount, to })
    return action ? { reply: `Ready to send ${amount} ${token}. Review it below.`, action } : { reply: HELP }
  }

  const swap = new RegExp(`^(?:swap|convert|trade|exchange)\\s+([\\d.]+)\\s*${TOKEN_WORD}\\s+(?:to|for|into)\\s+${TOKEN_WORD}$`, 'i').exec(input)
  if (swap) {
    const action = sanitizeAction({ type: 'swap', tokenIn: swap[2], tokenOut: swap[3], amount: swap[1], slippageBps: DEFAULT_SLIPPAGE_BPS })
    return action?.type === 'swap'
      ? { reply: `Ready to swap ${action.amount} ${action.tokenIn} to ${action.tokenOut}. Review it below.`, action }
      : { reply: 'I could not read that swap. Use two different tokens from USDC, EURC and cirBTC.' }
  }

  const bridge = new RegExp(`^bridge\\s+([\\d.]+)\\s*(?:usdc)?\\s+from\\s+${CHAIN_WORD}\\s+to\\s+${CHAIN_WORD}$`, 'i').exec(input)
  if (bridge) {
    const from = toChain(bridge[2])
    const to = toChain(bridge[3])
    const action = sanitizeAction({ type: 'bridge', from, to, amount: bridge[1] })
    return action ? { reply: `Ready to bridge ${bridge[1]} USDC. Review it below.`, action } : { reply: 'Pick two different networks to bridge between.' }
  }

  return { reply: HELP }
}
