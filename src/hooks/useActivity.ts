import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, type Address, type Hex } from 'viem'
import { requireChain } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, poolEventsAbi, type AssetSymbol } from '@/lib/pool'

export type ActivityKind = 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'liquidated' | 'liquidation'

export interface ActivityItem {
  id: string
  kind: ActivityKind
  symbol: AssetSymbol
  amount: bigint
  hash: string
  /** Unix seconds, or 0 when the explorer gave no timestamp. */
  timestamp: number
}

interface RawLog {
  topics: (string | null)[]
  data: string
  transaction_hash: string
  block_timestamp: string | null
  block_number: number
  index: number
}

const PAGE_LIMIT = 6
const WANTED = 25

function isRawLog(value: unknown): value is RawLog {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.topics) && typeof v.data === 'string' && typeof v.transaction_hash === 'string'
}

function symbolOf(address: string): AssetSymbol | undefined {
  return ASSET_LIST.find((a) => a.address.toLowerCase() === address.toLowerCase())?.symbol
}

export function toItem(log: RawLog, user: string): ActivityItem | undefined {
  const topics = log.topics.filter((t): t is string => typeof t === 'string')
  if (topics.length === 0) return undefined
  let decoded
  try {
    decoded = decodeEventLog({ abi: poolEventsAbi, data: log.data as Hex, topics: topics as [Hex, ...Hex[]] })
  } catch {
    return undefined // not one of the events shown in the feed
  }
  const me = user.toLowerCase()
  const base = {
    id: `${log.transaction_hash}-${log.index}`,
    hash: log.transaction_hash,
    timestamp: log.block_timestamp ? Math.floor(new Date(log.block_timestamp).getTime() / 1000) : 0,
  }
  switch (decoded.eventName) {
    case 'Deposit':
    case 'Withdraw':
    case 'Borrow': {
      const { user: who, asset, amount } = decoded.args
      const symbol = symbolOf(asset)
      if (!symbol || who.toLowerCase() !== me) return undefined
      return { ...base, kind: decoded.eventName === 'Deposit' ? 'deposit' : decoded.eventName === 'Withdraw' ? 'withdraw' : 'borrow', symbol, amount }
    }
    case 'Repay': {
      const { user: who, asset, amount } = decoded.args
      const symbol = symbolOf(asset)
      if (!symbol || who.toLowerCase() !== me) return undefined
      return { ...base, kind: 'repay', symbol, amount }
    }
    case 'Liquidation': {
      const { liquidator, borrower, debtAsset, repaid } = decoded.args
      const symbol = symbolOf(debtAsset)
      if (!symbol) return undefined
      if (borrower.toLowerCase() === me) return { ...base, kind: 'liquidated', symbol, amount: repaid }
      if (liquidator.toLowerCase() === me) return { ...base, kind: 'liquidation', symbol, amount: repaid }
      return undefined
    }
  }
}

/**
 * The wallet's own pool activity, newest first, read from the explorer's log index.
 * The explorer lists every log for the contract, so pages are scanned until enough
 * of this wallet's events are found or the page cap is reached.
 */
async function loadActivity(address: Address): Promise<ActivityItem[]> {
  const api = `${requireChain(ARC_ID).explorerBase}/api/v2/addresses/${POOL_ADDRESS}/logs`
  const items: ActivityItem[] = []
  let query = ''
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const res = await fetch(`${api}${query}`)
    if (!res.ok) throw new Error(`Explorer responded ${res.status}`)
    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null) break
    const { items: rows, next_page_params: next } = body as { items?: unknown; next_page_params?: unknown }
    if (Array.isArray(rows)) {
      for (const row of rows) {
        if (!isRawLog(row)) continue
        const item = toItem(row, address)
        if (item) items.push(item)
      }
    }
    if (items.length >= WANTED || !next || typeof next !== 'object') break
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) params.set(k, String(v))
    query = `?${params.toString()}`
  }
  return items.slice(0, WANTED)
}

export function useActivity(address: Address | undefined) {
  return useQuery({
    queryKey: ['activity', address],
    queryFn: () => loadActivity(address as Address),
    enabled: Boolean(address),
    refetchInterval: 20_000,
    staleTime: 10_000,
    retry: 1,
  })
}
