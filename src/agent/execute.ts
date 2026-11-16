import { AppKit, type BridgeResult, type SwapEstimate, type SwapResult } from '@circle-fin/app-kit'
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2'
import type { EIP1193Provider, Chain } from 'viem'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import type { Connector } from 'wagmi'
import { withAddChainFallback } from '@/lib/wallet'
import type { ChainKey, Token } from './schema'

export const kit = new AppKit()

type KitChain = 'Arc_Testnet' | 'Ethereum_Sepolia' | 'Base_Sepolia' | 'Arbitrum_Sepolia' | 'Polygon_Amoy_Testnet'

export const NETWORKS: Record<ChainKey, { chain: Chain; kitChain: KitChain }> = {
  arc: { chain: arcTestnet, kitChain: 'Arc_Testnet' },
  eth: { chain: sepolia, kitChain: 'Ethereum_Sepolia' },
  base: { chain: baseSepolia, kitChain: 'Base_Sepolia' },
  arb: { chain: arbitrumSepolia, kitChain: 'Arbitrum_Sepolia' },
  pol: { chain: polygonAmoy, kitChain: 'Polygon_Amoy_Testnet' },
}

const KNOWN_CHAINS = Object.values(NETWORKS).map((n) => n.chain) as unknown as readonly [Chain, ...Chain[]]

const sdkToken = (t: Token) => (t === 'cirBTC' ? 'CIRBTC' : t) as SwapEstimate['tokenIn']

async function adapterFor(connector: Connector) {
  const provider = (await connector.getProvider()) as EIP1193Provider
  return createViemAdapterFromProvider({ provider: withAddChainFallback(provider, KNOWN_CHAINS) })
}

interface SwapParams {
  tokenIn: Token
  tokenOut: Token
  amount: string
  slippageBps: number
}

/** Quoting never signs or sends anything. */
export async function estimateSwap(connector: Connector, p: SwapParams): Promise<SwapEstimate> {
  const adapter = await adapterFor(connector)
  return kit.estimateSwap({
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn: sdkToken(p.tokenIn),
    tokenOut: sdkToken(p.tokenOut),
    amountIn: p.amount,
    config: { slippageBps: p.slippageBps },
  })
}

export async function runSwap(connector: Connector, p: SwapParams): Promise<SwapResult> {
  const adapter = await adapterFor(connector)
  return kit.swap({
    from: { adapter, chain: 'Arc_Testnet' },
    tokenIn: sdkToken(p.tokenIn),
    tokenOut: sdkToken(p.tokenOut),
    amountIn: p.amount,
    config: { slippageBps: p.slippageBps },
  })
}

export async function runBridge(
  connector: Connector,
  currentChainId: number | undefined,
  switchChain: (chainId: number) => Promise<unknown>,
  p: { from: ChainKey; to: ChainKey; amount: string },
  onStep: (index: number) => void,
): Promise<BridgeResult> {
  const from = NETWORKS[p.from]
  const to = NETWORKS[p.to]
  const handlers = [
    ['bridge.approve', () => onStep(0)],
    ['bridge.burn', () => onStep(1)],
    ['bridge.fetchAttestation', () => onStep(2)],
    ['bridge.mint', () => onStep(3)],
  ] as const
  for (const [name, fn] of handlers) kit.on(name, fn)
  try {
    if (currentChainId !== from.chain.id) await switchChain(from.chain.id)
    const adapter = await adapterFor(connector)
    return await kit.bridge({
      from: { adapter, chain: from.kitChain },
      to: { adapter, chain: to.kitChain },
      amount: p.amount,
    })
  } finally {
    for (const [name, fn] of handlers) kit.off(name, fn)
  }
}

export function actionError(e: unknown): string {
  const text = String((e as { message?: string })?.message ?? '').toLowerCase()
  if (text.includes('user rejected') || text.includes('user denied')) return 'You cancelled the request in your wallet.'
  if (text.includes('slippage')) return 'The price moved more than your slippage limit. Nothing was spent.'
  if (text.includes('route') || text.includes('liquidity')) return 'No route is available for this amount right now. Try a smaller amount.'
  if (text.includes('insufficient')) return 'Insufficient balance or gas for this action.'
  if (text.includes('unsupported')) return 'This route is not supported right now.'
  return 'The action could not be completed. Please try again.'
}
