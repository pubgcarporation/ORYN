import { useQuery } from '@tanstack/react-query'
import { decodeEventLog, toEventSelector, type Hex } from 'viem'
import { requireChain } from '@/onchain-facts'
import { ARC_ID, ASSET_LIST, POOL_ADDRESS, poolEventsAbi, type AssetSymbol } from '@/lib/pool'
import type { PoolEvent } from '@/lib/stats'

const PAGE_SIZE = 1000
const MAX_PAGES = 5

const SIGNATURES = [
  'Deposit(address,address,uint256,uint256)',
  'Withdraw(address,address,uint256,uint256)',
  'Borrow(address,address,uint256,uint256)',
  'Repay(address,address,address,uint256,uint256)',
  'Liquidation(address,address,address,address,uint256,uint256,bool)',
] as const

interface ApiLog {
  topics: (string | null)[]
  data: string
  transactionHash: string
  logIndex: string
  timeStamp: string
}

function isApiLog(v: unknown): v is ApiLog {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return Array.isArray(r.topics) && typeof r.data === 'string' && typeof r.transactionHash === 'string' && typeof r.timeStamp === 'string'
}

function symbolOf(address: string): AssetSymbol | undefined {
  return ASSET_LIST.find((a) => a.address.toLowerCase() === address.toLowerCase())?.symbol
}

function toEvent(log: ApiLog): PoolEvent | undefined {
  const topics = log.topics.filter((t): t is string => typeof t === 'string')
  if (topics.length === 0) return undefined
  let decoded
  try {
    decoded = decodeEventLog({ abi: poolEventsAbi, data: log.data as Hex, topics: topics as [Hex, ...Hex[]] })
  } catch {
    return undefined
  }
  const base = { id: `${log.transactionHash}-${log.logIndex}`, hash: log.transactionHash, ts: Number(BigInt(log.timeStamp)) }
  switch (decoded.eventName) {
    case 'Deposit':
    case 'Withdraw':
    case 'Borrow': {
      const symbol = symbolOf(decoded.args.asset)
      if (!symbol) return undefined
      return { ...base, kind: decoded.eventName === 'Deposit' ? 'deposit' : decoded.eventName === 'Withdraw' ? 'withdraw' : 'borrow', user: decoded.args.user.toLowerCase(), symbol, amount: decoded.args.amount }
    }
    case 'Repay': {
      const symbol = symbolOf(decoded.args.asset)
      if (!symbol) return undefined
      return { ...base, kind: 'repay', user: decoded.args.user.toLowerCase(), symbol, amount: decoded.args.amount }
    }
    case 'Liquidation': {
      const symbol = symbolOf(decoded.args.debtAsset)
      const collateralSymbol = symbolOf(decoded.args.collateralAsset)
      if (!symbol || !collateralSymbol) return undefined
      return {
        ...base,
        kind: 'liquidation',
        user: decoded.args.liquidator.toLowerCase(),
        borrower: decoded.args.borrower.toLowerCase(),
        symbol,
        amount: decoded.args.repaid,
        collateralSymbol,
        seized: decoded.args.seized,
      }
    }
  }
}

async function loadTopic(base: string, topic0: string): Promise<PoolEvent[]> {
  const out: PoolEvent[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${base}/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=${POOL_ADDRESS}&topic0=${topic0}&page=${page}&offset=${PAGE_SIZE}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Explorer responded ${res.status}`)
    const body: unknown = await res.json()
    const rows = typeof body === 'object' && body !== null ? (body as { result?: unknown }).result : undefined
    if (!Array.isArray(rows)) break // an empty index answers with a message, not a list
    for (const row of rows) {
      if (!isApiLog(row)) continue
      const event = toEvent(row)
      if (event) out.push(event)
    }
    if (rows.length < PAGE_SIZE) break
  }
  return out
}

/** Every deposit, withdrawal, borrow, repayment and liquidation the pool has recorded, newest first. */
async function loadAll(): Promise<PoolEvent[]> {
  const base = requireChain(ARC_ID).explorerBase
  const lists = await Promise.all(SIGNATURES.map((s) => loadTopic(base, toEventSelector(s))))
  return lists.flat().sort((a, b) => b.ts - a.ts)
}

export function usePoolEvents() {
  return useQuery({
    queryKey: ['pool-events', POOL_ADDRESS],
    queryFn: loadAll,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  })
}
