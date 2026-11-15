import { ASSETS, type AssetSymbol, type Prices } from '@/lib/pool'

export type EventKind = 'deposit' | 'withdraw' | 'borrow' | 'repay' | 'liquidation'

/** One pool event, decoded from the contract's logs. */
export interface PoolEvent {
  id: string
  kind: EventKind
  /** The wallet that acted. For a liquidation this is the liquidator. */
  user: string
  /** For a liquidation, the wallet that was liquidated. */
  borrower?: string
  symbol: AssetSymbol
  /** Token units: the amount moved, or the debt repaid in a liquidation. */
  amount: bigint
  /** Liquidation only: the collateral token and amount the liquidator received. */
  collateralSymbol?: AssetSymbol
  seized?: bigint
  /** Unix seconds. */
  ts: number
  hash: string
}

export type Period = '24h' | '7d' | '30d' | 'all'

export const PERIODS: { id: Period; label: string; seconds: number }[] = [
  { id: '24h', label: '24h', seconds: 86_400 },
  { id: '7d', label: '7d', seconds: 7 * 86_400 },
  { id: '30d', label: '30d', seconds: 30 * 86_400 },
  { id: 'all', label: 'All time', seconds: Infinity },
]

/** USD value of a token amount at the pool's current Chainlink prices. */
export function usd(amount: bigint, symbol: AssetSymbol, prices: Prices): number {
  const units = Number(amount) / 10 ** ASSETS[symbol].decimals
  return units * (Number(prices[symbol]) / 1e8)
}

export function inPeriod(events: PoolEvent[], period: Period, now: number): PoolEvent[] {
  const window = PERIODS.find((p) => p.id === period)?.seconds ?? Infinity
  return window === Infinity ? events : events.filter((e) => now - e.ts <= window)
}

export type Board = 'suppliers' | 'borrowers' | 'active' | 'liquidators'

export interface Row {
  address: string
  /** The number the board is ranked by, in USD. */
  value: number
  /** How many actions that number comes from. */
  count: number
  /** A second figure shown next to it, in USD. */
  extra: number
}

export const BOARDS: { id: Board; label: string; metric: string; extra: string; blurb: string }[] = [
  { id: 'suppliers', label: 'Suppliers', metric: 'Net supplied', extra: 'Total deposited', blurb: 'Deposits minus withdrawals.' },
  { id: 'borrowers', label: 'Borrowers', metric: 'Net borrowed', extra: 'Total borrowed', blurb: 'Borrowed minus repaid.' },
  { id: 'active', label: 'Most active', metric: 'Volume', extra: 'Actions', blurb: 'Everything a wallet moved through the pool.' },
  { id: 'liquidators', label: 'Liquidators', metric: 'Debt repaid', extra: 'Collateral won', blurb: 'Loans closed out for others.' },
]

/** Ranks wallets for one board, best first. Amounts are valued at today's prices. */
export function buildBoard(events: PoolEvent[], board: Board, prices: Prices): Row[] {
  const rows = new Map<string, Row>()
  const row = (address: string): Row => {
    let r = rows.get(address)
    if (!r) {
      r = { address, value: 0, count: 0, extra: 0 }
      rows.set(address, r)
    }
    return r
  }

  for (const e of events) {
    const v = usd(e.amount, e.symbol, prices)
    if (board === 'suppliers') {
      if (e.kind === 'deposit') {
        const r = row(e.user)
        r.value += v
        r.extra += v
        r.count += 1
      } else if (e.kind === 'withdraw') {
        row(e.user).value -= v
      }
    } else if (board === 'borrowers') {
      if (e.kind === 'borrow') {
        const r = row(e.user)
        r.value += v
        r.extra += v
        r.count += 1
      } else if (e.kind === 'repay') {
        row(e.user).value -= v
      }
    } else if (board === 'active') {
      if (e.kind === 'liquidation') continue
      const r = row(e.user)
      r.value += v
      r.count += 1
      r.extra += 1
    } else if (e.kind === 'liquidation') {
      const r = row(e.user)
      r.value += v
      r.count += 1
      if (e.seized !== undefined && e.collateralSymbol) r.extra += usd(e.seized, e.collateralSymbol, prices)
    }
  }

  return [...rows.values()]
    .filter((r) => r.value > 0.005)
    .sort((a, b) => b.value - a.value || b.count - a.count)
}

export interface Day {
  /** Start of the UTC day, unix seconds. */
  ts: number
  deposit: number
  withdraw: number
  borrow: number
  repay: number
  txs: number
  users: number
}

const DAY = 86_400

/** One bucket per UTC day for the last `days` days, oldest first. */
export function dailySeries(events: PoolEvent[], prices: Prices, days: number, now: number): Day[] {
  const today = Math.floor(now / DAY) * DAY
  const out: Day[] = Array.from({ length: days }, (_, i) => ({
    ts: today - (days - 1 - i) * DAY,
    deposit: 0,
    withdraw: 0,
    borrow: 0,
    repay: 0,
    txs: 0,
    users: 0,
  }))
  const seen = out.map(() => new Set<string>())
  for (const e of events) {
    const index = Math.floor((e.ts - out[0].ts) / DAY)
    if (index < 0 || index >= days) continue
    const d = out[index]
    d.txs += 1
    seen[index].add(e.user)
    if (e.kind === 'liquidation') continue
    d[e.kind] += usd(e.amount, e.symbol, prices)
  }
  out.forEach((d, i) => {
    d.users = seen[i].size
  })
  return out
}

export interface Totals {
  users: number
  actions: number
  volume24h: number
  volumeAll: number
  liquidations: number
  liquidated: number
}

export function totals(events: PoolEvent[], prices: Prices, now: number): Totals {
  const users = new Set<string>()
  let volume24h = 0
  let volumeAll = 0
  let liquidations = 0
  let liquidated = 0
  for (const e of events) {
    users.add(e.user)
    const v = usd(e.amount, e.symbol, prices)
    if (e.kind === 'liquidation') {
      liquidations += 1
      liquidated += v
      continue
    }
    volumeAll += v
    if (now - e.ts <= DAY) volume24h += v
  }
  return { users: users.size, actions: events.length, volume24h, volumeAll, liquidations, liquidated }
}

export const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`

export const money = (n: number, digits = 2) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`

/** Compact dollars for tight spaces: $1.2K, $3.4M. */
export function compact(n: number): string {
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e4) return `$${(n / 1e3).toFixed(1)}K`
  return money(n)
}
