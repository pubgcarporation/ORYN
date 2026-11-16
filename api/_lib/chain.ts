import { createPublicClient, erc20Abi, http, parseAbi, type Address } from 'viem'
import { arcTestnet } from 'viem/chains'
import { getChain, getUsdc } from '../../src/onchain-facts.js'
import { TOKENS, TOKEN_DECIMALS, type Token } from '../../src/agent/schema.js'
import { HttpError } from './errors.js'

export const ARC_ID = arcTestnet.id

function required(name: string): Address {
  const value = process.env[name]
  if (!value || !/^0x[0-9a-fA-F]{40}$/.test(value)) throw new HttpError(503, 'chain_not_configured', `Set ${name} on the server to turn on the agent wallet.`)
  return value as Address
}

export function tokenAddress(token: Token): Address {
  if (token === 'USDC') {
    const usdc = getUsdc(ARC_ID)
    if (!usdc) throw new HttpError(503, 'chain_not_configured', 'USDC is not registered for Arc Testnet.')
    return usdc.address as Address
  }
  return required(token === 'EURC' ? 'VITE_EURC_ADDRESS' : 'VITE_CIRBTC_ADDRESS')
}

const poolAbi = parseAbi([
  'function getReserveData(address asset) view returns (uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, uint256 utilization, uint256 supplyRateApr, uint256 borrowRateApr, uint256 supplyCap, uint256 borrowCap, uint256 ltv, uint256 liquidationThreshold, uint256 liquidationBonus, uint256 price8)',
  'function isPriceFresh() view returns (bool)',
])

/** The sandbox RPC proxy when it covers Arc Testnet, a per-chain override, or the public endpoint. */
function rpcUrl(): string {
  const override = process.env.RPC_URL_Arc_Testnet
  if (override) return override
  const chains = (process.env.RPC_PROXY_CHAINS || '').split(',')
  if (process.env.RPC_PROXY_BASE_URL && chains.includes('Arc_Testnet')) {
    return `${process.env.RPC_PROXY_BASE_URL}/api/rpc/Arc_Testnet?_rpc_token=${process.env.RPC_PROXY_TOKEN}`
  }
  const fallback = getChain(ARC_ID)?.rpcUrls[0]
  if (!fallback) throw new HttpError(503, 'chain_not_configured', 'No RPC endpoint for Arc Testnet.')
  return fallback
}

let client: ReturnType<typeof createPublicClient> | undefined
export function arcClient() {
  client ??= createPublicClient({ chain: arcTestnet, transport: http(rpcUrl()) })
  return client
}

/** USD price of each token, read from the same Chainlink-fed market the app shows. Fails closed. */
export async function readPricesUsd(): Promise<Record<Token, number>> {
  const pool = required('VITE_LENDING_POOL_ADDRESS')
  const c = arcClient()
  const fresh = await c.readContract({ address: pool, abi: poolAbi, functionName: 'isPriceFresh' })
  if (!fresh) throw new HttpError(503, 'prices_stale', 'The price feeds are out of date, so the agent is paused.')
  const entries = await Promise.all(
    TOKENS.map(async (t) => {
      const reserve = await c.readContract({ address: pool, abi: poolAbi, functionName: 'getReserveData', args: [tokenAddress(t)] })
      const price8 = reserve[11]
      if (price8 <= 0n) throw new HttpError(503, 'prices_missing', `No price for ${t}.`)
      return [t, Number(price8) / 1e8] as const
    }),
  )
  return Object.fromEntries(entries) as Record<Token, number>
}

export async function balanceOf(owner: Address, token: Token): Promise<bigint> {
  return arcClient().readContract({ address: tokenAddress(token), abi: erc20Abi, functionName: 'balanceOf', args: [owner] })
}

export const decimalsOf = (t: Token) => TOKEN_DECIMALS[t]
