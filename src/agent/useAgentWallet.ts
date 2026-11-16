import { useCallback, useEffect, useState } from 'react'
import { usePrivy } from '@privy-io/react-auth'
import { useAccount } from 'wagmi'
import type { Limits } from './rules'

export interface ActivityEntry {
  at: number
  kind: 'send' | 'swap' | 'withdraw' | 'blocked' | 'failed'
  text: string
  usd?: number
  url?: string
}

export interface AgentStatus {
  wallet: { address: `0x${string}`; owner: `0x${string}`; paused: boolean } | null
  limits?: Limits
  spentTodayUsd?: number
  activity?: ActivityEntry[]
}

export interface ChatResult {
  status: 'info' | 'done' | 'blocked' | 'failed' | 'pending'
  reply: string
  links: { label: string; url: string }[]
}

const REFRESH_MS = 20_000

/** The signed-in person's agent wallet on the server, with every call authenticated by their Privy sign-in. */
export function useAgentWallet(available: boolean) {
  const { authenticated, getAccessToken } = usePrivy()
  const { address } = useAccount()
  const [status, setStatus] = useState<AgentStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const call = useCallback(
    async <T,>(path: string, body?: unknown): Promise<T> => {
      const token = await getAccessToken()
      if (!token) throw new Error('Sign in to use the agent wallet.')
      const res = await fetch(`/api/agent/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = (await res.json().catch(() => ({}))) as { message?: string }
      if (!res.ok) throw new Error(data.message ?? 'Something went wrong. Please try again.')
      return data as T
    },
    [getAccessToken],
  )

  const refresh = useCallback(async () => {
    if (!available || !authenticated) return
    try {
      setStatus(await call<AgentStatus>('status'))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load your agent wallet.')
    }
  }, [available, authenticated, call])

  useEffect(() => {
    if (!available || !authenticated) return
    const first = setTimeout(() => {
      setLoading(true)
      void refresh().finally(() => setLoading(false))
    }, 0)
    const timer = setInterval(() => void refresh(), REFRESH_MS)
    return () => {
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [available, authenticated, refresh])

  const run = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setError(null)
    try {
      return await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
      return undefined
    }
  }

  return {
    status,
    loading,
    error,
    authenticated,
    refresh,
    create: async () => {
      if (!address) return setError('Connect a wallet first. Withdrawals go back to it.')
      const next = await run(() => call<AgentStatus>('create', { owner: address }))
      if (next) setStatus(next)
    },
    saveLimits: async (limits: Limits) => {
      const next = await run(() => call<AgentStatus>('limits', { limits }))
      if (next) setStatus(next)
      return Boolean(next)
    },
    setPaused: async (paused: boolean) => {
      const next = await run(() => call<AgentStatus>('pause', { paused }))
      if (next) setStatus(next)
    },
    withdraw: async (token: string, amount: string) => {
      const res = await run(() => call<ChatResult>('withdraw', { token, amount }))
      void refresh()
      return res
    },
    chat: async (message: string): Promise<ChatResult> => {
      try {
        const res = await call<ChatResult>('chat', { message })
        void refresh()
        return res
      } catch (e) {
        return { status: 'failed', reply: e instanceof Error ? e.message : 'Something went wrong.', links: [] }
      }
    },
  }
}
