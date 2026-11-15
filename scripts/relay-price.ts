/**
 * Relays the Arc mainnet Chainlink EURC/USD, USDC/USD and BTC/USD answers onto the Arc Testnet mirror feeds.
 *
 * It copies Chainlink's own answer and its ORIGINAL update time, so the pool judges freshness
 * against when Chainlink published the price, never against when this script ran.
 *
 * Env (names only, never commit values):
 *   VITE_EURC_PRICE_FEED_ADDRESS, VITE_USDC_PRICE_FEED_ADDRESS, VITE_BTC_PRICE_FEED_ADDRESS  mirror feeds on Arc Testnet
 *   RELAYER_PRIVATE_KEY      key of the feed's updater address
 *   MAINNET_RPC_URL          optional, defaults to https://rpc.mainnet.arc.io
 *   TESTNET_RPC_URL          optional, defaults to the Arc Testnet RPC from viem
 *
 * Usage: bun run relay:price            (one update)
 *        bun run relay:price -- --watch (check every 5 minutes)
 */
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { arcTestnet } from 'viem/chains'

const PAIRS = [
  { description: 'EURC / USD', source: '0x361b95c10b76Ca3f35C686d423e43A951755Bf23' as Address, mirror: process.env.VITE_EURC_PRICE_FEED_ADDRESS as Address | undefined },
  { description: 'BTC / USD', source: '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De' as Address, mirror: process.env.VITE_BTC_PRICE_FEED_ADDRESS as Address | undefined },
  { description: 'USDC / USD', source: '0x84EA90AC252Dc437031461836DB5164219147905' as Address, mirror: process.env.VITE_USDC_PRICE_FEED_ADDRESS as Address | undefined },
]
const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
])
const mirrorAbi = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
  'function pushRound(int256 answer, uint256 sourceUpdatedAt, uint80 sourceRoundId)',
])

const key = process.env.RELAYER_PRIVATE_KEY as Hex | undefined
for (const p of PAIRS) if (!p.mirror) throw new Error(`Mirror feed address for ${p.description} is not set`)
if (!key) throw new Error('RELAYER_PRIVATE_KEY is not set')

const mainnet = createPublicClient({ transport: http(process.env.MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io') })
const testnetRpc = process.env.TESTNET_RPC_URL || arcTestnet.rpcUrls.default.http[0]
const testnet = createPublicClient({ chain: arcTestnet, transport: http(testnetRpc) })
const account = privateKeyToAccount(key)
const wallet = createWalletClient({ account, chain: arcTestnet, transport: http(testnetRpc) })

async function relayPair(pair: (typeof PAIRS)[number]): Promise<void> {
  const mirror = pair.mirror as Address
  const [description, decimals] = await Promise.all([
    mainnet.readContract({ address: pair.source, abi: feedAbi, functionName: 'description' }),
    mainnet.readContract({ address: pair.source, abi: feedAbi, functionName: 'decimals' }),
  ])
  if (description !== pair.description || decimals !== 8) throw new Error(`Unexpected source feed: ${description} (${decimals} decimals)`)
  const [roundId, answer, , updatedAt] = await mainnet.readContract({ address: pair.source, abi: feedAbi, functionName: 'latestRoundData' })
  if (answer <= 0n || updatedAt === 0n) throw new Error(`${pair.description}: source feed returned an invalid round`)

  let last = 0n
  try {
    last = (await testnet.readContract({ address: mirror, abi: mirrorAbi, functionName: 'latestRoundData' }))[3]
  } catch {
    // No round pushed yet.
  }
  if (updatedAt <= last) {
    console.log(`${pair.description}: up to date (Chainlink round ${roundId}, updated ${new Date(Number(updatedAt) * 1000).toISOString()})`)
    return
  }
  const hash = await wallet.writeContract({ address: mirror, abi: mirrorAbi, functionName: 'pushRound', args: [answer, updatedAt, roundId] })
  await testnet.waitForTransactionReceipt({ hash })
  console.log(`${pair.description}: relayed ${Number(answer) / 1e8} (Chainlink round ${roundId}) in ${hash}`)
}

async function relayOnce(): Promise<void> {
  for (const pair of PAIRS) await relayPair(pair)
}

const watch = process.argv.includes('--watch')
await relayOnce()
while (watch) {
  await new Promise((r) => setTimeout(r, 5 * 60_000))
  try {
    await relayOnce()
  } catch (e) {
    console.error('relay failed:', e instanceof Error ? e.message : e)
  }
}
