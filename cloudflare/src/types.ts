/** Minimal Cloudflare Workers types, so this folder type-checks without extra packages. */
export interface KV {
  get(key: string): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

export interface ScheduledController {
  scheduledTime: number
  cron: string
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void
}

/** Plain variables live in wrangler.toml. Keys and tokens are Worker secrets, never committed. */
export interface Env {
  STATE: KV
  POOL_ADDRESS: string
  POOL_DEPLOY_BLOCK: string
  MIRROR_EURC: string
  MIRROR_USDC: string
  MIRROR_BTC: string
  EXPLORER_BASE: string
  TESTNET_RPC_URL?: string
  MAINNET_RPC_URL?: string
  TICKS_PER_RUN?: string
  TICK_MS?: string
  MIN_REPAY_USD?: string
  MAX_LIQUIDATIONS_PER_TICK?: string
  /** Set to "1" to receive the borrower's deposit shares instead of the underlying token. */
  RECEIVE_SUPPLY_SHARES?: string
  /** Set to "1" to simulate liquidations without sending them. */
  DRY_RUN?: string
  /** Secret. Must be the updater address of the three mirror feeds. */
  RELAYER_PRIVATE_KEY?: string
  /** Secret. A separate wallet that holds the tokens used to repay debt. */
  LIQUIDATOR_PRIVATE_KEY?: string
  /** Secret. Lets you trigger a run by hand with POST /run. */
  ADMIN_TOKEN?: string
}

export type ActionKind = 'relay' | 'liquidate' | 'skip' | 'error'

export interface Action {
  t: number
  kind: ActionKind
  text: string
  hash?: string
}

export interface Status {
  lastRun: number
  lastRunMs: number
  pricesFresh: boolean | null
  priceAgeSec: Record<string, number>
  borrowersWatched: number
  atRisk: number
  liquidatable: number
  liquidationsTotal: number
  relayerAddress: string | null
  liquidatorAddress: string | null
  dryRun: boolean
  lastError: string | null
}
