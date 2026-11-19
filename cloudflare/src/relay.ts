import type { Address } from 'viem'
import { errText, feedAbi, mirrorAbi, walletFor, type Clients } from './chain'
import type { Action, Env } from './types'

/** Live Chainlink feeds on Arc mainnet. The Arc Testnet mirrors copy these answers. */
const PAIRS = [
  { name: 'EURC / USD', source: '0x361b95c10b76Ca3f35C686d423e43A951755Bf23' as Address, mirror: (e: Env) => e.MIRROR_EURC },
  { name: 'BTC / USD', source: '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De' as Address, mirror: (e: Env) => e.MIRROR_BTC },
  { name: 'USDC / USD', source: '0x84EA90AC252Dc437031461836DB5164219147905' as Address, mirror: (e: Env) => e.MIRROR_USDC },
]

export interface RelayResult {
  actions: Action[]
  /** Age in seconds of each mirror's price after this run. */
  ageSec: Record<string, number>
}

/**
 * Copies each live Chainlink answer onto its testnet mirror with the ORIGINAL Chainlink timestamp.
 * The pool judges freshness against Chainlink's own update time, never against when this ran.
 * All reads go out together (one batched request per chain), then any needed updates are sent one by one.
 */
export async function relayPrices(env: Env, c: Clients): Promise<RelayResult> {
  const actions: Action[] = []
  const ageSec: Record<string, number> = {}
  const now = Math.floor(Date.now() / 1000)

  let wallet: ReturnType<typeof walletFor>
  try {
    wallet = walletFor(env, c, env.RELAYER_PRIVATE_KEY)
  } catch (e) {
    actions.push({ t: Date.now(), kind: 'error', text: `RELAYER_PRIVATE_KEY: ${errText(e)}` })
  }

  const reads = await Promise.all(
    PAIRS.map(async (pair) => {
      const mirror = pair.mirror(env) as Address
      try {
        const [source, current] = await Promise.all([
          c.mainnet.readContract({ address: pair.source, abi: feedAbi, functionName: 'latestRoundData' }),
          c.testnet.readContract({ address: mirror, abi: mirrorAbi, functionName: 'latestRoundData' }).catch(() => undefined),
        ])
        return { pair, mirror, source, current, error: undefined as unknown }
      } catch (error) {
        return { pair, mirror, source: undefined, current: undefined, error }
      }
    }),
  )

  for (const read of reads) {
    const { pair, mirror } = read
    try {
      if (read.error !== undefined || !read.source) throw read.error ?? new Error('no data')
      const [roundId, answer, , updatedAt] = read.source
      const mirrorUpdated = read.current ? read.current[3] : 0n
      ageSec[pair.name] = mirrorUpdated > 0n ? now - Number(mirrorUpdated) : -1
      if (answer <= 0n || updatedAt === 0n) throw new Error('the Chainlink source returned an invalid round')
      if (updatedAt <= mirrorUpdated) continue
      if (!wallet) {
        actions.push({ t: Date.now(), kind: 'skip', text: `${pair.name}: a newer Chainlink price exists but no relayer key is set` })
        continue
      }
      const hash = await wallet.client.writeContract({ address: mirror, abi: mirrorAbi, functionName: 'pushRound', args: [answer, updatedAt, roundId] })
      await c.testnet.waitForTransactionReceipt({ hash, timeout: 25_000 })
      ageSec[pair.name] = now - Number(updatedAt)
      actions.push({ t: Date.now(), kind: 'relay', text: `${pair.name}: copied Chainlink price ${(Number(answer) / 1e8).toFixed(4)}`, hash })
    } catch (e) {
      actions.push({ t: Date.now(), kind: 'error', text: `${pair.name}: ${errText(e)}` })
    }
  }
  return { actions, ageSec }
}
