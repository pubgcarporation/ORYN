import { sanitizeAction } from './schema'
import { parseCommand, type Contact, type Interpretation } from './parse'

export interface AiStatus {
  /** The server has an AI key and can read free-form requests. */
  configured: boolean
  provider?: string
  /** The server can run the agent wallet: Circle, sign-in checks and storage are all set up. */
  agentAvailable?: boolean
}

export async function fetchAiStatus(): Promise<AiStatus> {
  try {
    const res = await fetch('/api/health')
    if (!res.ok) return { configured: false }
    const data = (await res.json()) as { configured?: boolean; provider?: string; agent?: { available?: boolean } }
    return { configured: data.configured === true, provider: data.provider, agentAvailable: data.agent?.available === true }
  } catch {
    return { configured: false }
  }
}

/**
 * Turns what the user typed into a draft action. The AI only drafts: its answer is re-validated here,
 * and every limit is checked in code afterwards. Without the AI, a strict command parser takes over.
 */
export async function interpret(message: string, contacts: Contact[], ai: boolean): Promise<Interpretation & { source: 'ai' | 'basic' }> {
  if (ai) {
    try {
      const res = await fetch('/api/interpret', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, contacts }),
      })
      if (res.ok) {
        const data = (await res.json()) as { reply?: unknown; action?: unknown }
        const reply = typeof data.reply === 'string' ? data.reply.slice(0, 500) : 'Done.'
        return { reply, action: sanitizeAction(data.action), source: 'ai' }
      }
    } catch {
      /* fall through to the basic parser */
    }
  }
  return { ...parseCommand(message, contacts), source: 'basic' }
}
