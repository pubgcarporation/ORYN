import { useQuery } from '@tanstack/react-query'
import { createPublicClient, http, parseAbi, type Address } from 'viem'
import type { AssetSymbol } from '@/lib/pool'

/** The Chainlink feeds the testnet mirrors copy. Reading them directly shows the price the moment Chainlink publishes it. */
const SOURCES: Record<AssetSymbol, Address> = {
  EURC: '0x361b95c10b76Ca3f35C686d423e43A951755Bf23',
  cirBTC: '0xa109B535C70C8Be9995be64Bb6751AcDB27e03De',
  USDC: '0x84EA90AC252Dc437031461836DB5164219147905',
}

const feedAbi = parseAbi(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)'])

const client = createPublicClient({
  transport: http('https://rpc.mainnet.arc.io', { batch: true, retryCount: 1, timeout: 6_000 }),
})

export const LIVE_PRICE_MS = 4_000

export interface LivePrices {
  /** 8-decimal USD prices straight from Chainlink on Arc mainnet. */
  prices: Record<AssetSymbol, bigint>
  /** Unix seconds when Chainlink published each price. */
  updatedAt: Record<AssetSymbol, number>
}

async function load(): Promise<LivePrices> {
  const symbols = Object.keys(SOURCES) as AssetSymbol[]
  const rounds = await Promise.all(symbols.map((s) => client.readContract({ address: SOURCES[s], abi: feedAbi, functionName: 'latestRoundData' })))
  const prices = {} as Record<AssetSymbol, bigint>
  const updatedAt = {} as Record<AssetSymbol, number>
  symbols.forEach((s, i) => {
    const [, answer, , updated] = rounds[i]
    if (answer <= 0n) throw new Error(`${s} feed returned an invalid price`)
    prices[s] = answer
    updatedAt[s] = Number(updated)
  })
  return { prices, updatedAt }
}

/** Live Chainlink prices, refreshed every few seconds. Undefined until the first read succeeds or if the read fails. */
export function useLivePrices(): LivePrices | undefined {
  const { data } = useQuery({
    queryKey: ['live-chainlink-prices'],
    queryFn: load,
    refetchInterval: LIVE_PRICE_MS,
    staleTime: LIVE_PRICE_MS,
    retry: 1,
  })
  return data
}
