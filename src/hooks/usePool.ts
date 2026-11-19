import { useReadContracts, useAccount } from 'wagmi'
import { erc20Abi, type Address } from 'viem'
import {
  ARC_ID,
  ASSET_LIST,
  ASSETS,
  MAX_UINT,
  POOL_ADDRESS,
  poolAbi,
  reserveFromTuple,
  type AssetSymbol,
  type Prices,
  type Reserve,
} from '@/lib/pool'
import { useLivePrices } from '@/hooks/useLivePrices'

const REFRESH_MS = 8_000

const EMPTY_RESERVE: Reserve = {
  totalSupplied: 0n,
  totalBorrowed: 0n,
  availableLiquidity: 0n,
  utilization: 0n,
  supplyRateApr: 0n,
  borrowRateApr: 0n,
  supplyCap: 0n,
  borrowCap: 0n,
  ltv: 0n,
  liquidationThreshold: 0n,
  liquidationBonus: 0n,
  price8: 0n,
}

export interface PoolState {
  reserves: Record<AssetSymbol, Reserve>
  /** 8-decimal USD price of every asset, from the pool's own feeds (the testnet copies of Chainlink). Every onchain check uses these. */
  prices: Prices
  /** Same as `prices`. Kept so older code that reads it still works. */
  poolPrices: Prices
  /** True when the live Chainlink prices could be read, for comparing against the pool's feeds. */
  live: boolean
  /** Live Chainlink prices straight from Arc mainnet. Used only to show how far the pool's feeds are behind. */
  chainlink: Prices | undefined
  /** Unix seconds when Chainlink published each live price. */
  liveUpdatedAt: Record<AssetSymbol, number> | undefined
  priceFresh: boolean
  paused: boolean
  loaded: boolean
  refetch: () => void
}

/** Market-wide state: every reserve, the Chainlink prices, oracle freshness and the pause flag. */
export function usePool(): PoolState {
  const { data, isSuccess, refetch } = useReadContracts({
    contracts: [
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getReserveData', args: [ASSETS.USDC.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getReserveData', args: [ASSETS.EURC.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getReserveData', args: [ASSETS.cirBTC.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'isPriceFresh', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'paused', chainId: ARC_ID },
    ],
    query: { refetchInterval: REFRESH_MS },
  })

  const usdc = data?.[0]?.result
  const eurc = data?.[1]?.result
  const btc = data?.[2]?.result
  const fresh = data?.[3]?.result
  const paused = data?.[4]?.result
  const liveFeed = useLivePrices()

  const poolPrices: Prices = {
    USDC: usdc ? reserveFromTuple(usdc).price8 : 0n,
    EURC: eurc ? reserveFromTuple(eurc).price8 : 0n,
    cirBTC: btc ? reserveFromTuple(btc).price8 : 0n,
  }
  const live = liveFeed !== undefined
  const prices: Prices = poolPrices

  return {
    reserves: {
      USDC: usdc ? reserveFromTuple(usdc) : EMPTY_RESERVE,
      EURC: eurc ? reserveFromTuple(eurc) : EMPTY_RESERVE,
      cirBTC: btc ? reserveFromTuple(btc) : EMPTY_RESERVE,
    },
    prices,
    poolPrices,
    live,
    chainlink: liveFeed?.prices,
    liveUpdatedAt: liveFeed?.updatedAt,
    priceFresh: fresh === true,
    paused: paused === true,
    loaded: isSuccess && Boolean(usdc) && Boolean(eurc) && Boolean(btc),
    refetch: () => void refetch(),
  }
}

export interface AssetPosition {
  walletBalance: bigint
  allowance: bigint
  supplied: bigint
  debt: bigint
  maxBorrow: bigint
  maxWithdraw: bigint
}

export interface UserState {
  address: Address | undefined
  assets: Record<AssetSymbol, AssetPosition>
  collateralUsd8: bigint
  debtUsd8: bigint
  borrowLimitUsd8: bigint
  liquidationUsd8: bigint
  healthWad: bigint
  loaded: boolean
  refetch: () => void
}

const EMPTY_POSITION: AssetPosition = {
  walletBalance: 0n,
  allowance: 0n,
  supplied: 0n,
  debt: 0n,
  maxBorrow: 0n,
  maxWithdraw: 0n,
}

/** The connected wallet's balances, allowances, supplied and borrowed amounts, and account health. */
export function useUser(pool?: PoolState): UserState {
  const { address } = useAccount()
  const user = address as Address

  const contracts = ASSET_LIST.flatMap((asset) => [
    { address: asset.address, abi: erc20Abi, functionName: 'balanceOf', args: [user], chainId: ARC_ID },
    { address: asset.address, abi: erc20Abi, functionName: 'allowance', args: [user, POOL_ADDRESS], chainId: ARC_ID },
    { address: POOL_ADDRESS, abi: poolAbi, functionName: 'supplyBalanceOf', args: [asset.address, user], chainId: ARC_ID },
    { address: POOL_ADDRESS, abi: poolAbi, functionName: 'debtBalanceOf', args: [asset.address, user], chainId: ARC_ID },
    { address: POOL_ADDRESS, abi: poolAbi, functionName: 'maxBorrowable', args: [asset.address, user], chainId: ARC_ID },
    { address: POOL_ADDRESS, abi: poolAbi, functionName: 'maxWithdrawable', args: [asset.address, user], chainId: ARC_ID },
  ] as const)

  const { data, isSuccess, refetch } = useReadContracts({
    contracts: [
      ...contracts,
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getUserAccount', args: [user], chainId: ARC_ID },
    ],
    query: { enabled: Boolean(address), refetchInterval: REFRESH_MS },
  })

  const num = (i: number): bigint => {
    const v = data?.[i]?.result
    return typeof v === 'bigint' ? v : 0n
  }
  const position = (base: number): AssetPosition => ({
    walletBalance: num(base),
    allowance: num(base + 1),
    supplied: num(base + 2),
    debt: num(base + 3),
    maxBorrow: num(base + 4),
    maxWithdraw: num(base + 5),
  })

  const accountRaw: unknown = data?.[18]?.result
  const account = Array.isArray(accountRaw) && accountRaw.length === 5 ? (accountRaw as readonly bigint[]) : undefined
  const hasAccount = account !== undefined

  const assets: Record<AssetSymbol, AssetPosition> = address
    ? { USDC: position(0), EURC: position(6), cirBTC: position(12) }
    : { USDC: EMPTY_POSITION, EURC: EMPTY_POSITION, cirBTC: EMPTY_POSITION }

  // With the pool's current prices, re-value the account from the wallet's balances and the pool's risk
  // settings, so health and limits move the moment a price does. Without them, use the pool's own numbers.
  let collateral = hasAccount ? account[0] : 0n
  let debt = hasAccount ? account[1] : 0n
  let limit = hasAccount ? account[2] : 0n
  let liquidation = hasAccount ? account[3] : 0n
  let health = hasAccount ? account[4] : MAX_UINT
  if (hasAccount && pool?.loaded) {
    collateral = 0n
    debt = 0n
    limit = 0n
    liquidation = 0n
    for (const a of ASSET_LIST) {
      const r = pool.reserves[a.symbol]
      const unit = 10n ** BigInt(a.decimals)
      const value = (assets[a.symbol].supplied * pool.prices[a.symbol]) / unit
      collateral += value
      limit += (value * r.ltv) / 10_000n
      liquidation += (value * r.liquidationThreshold) / 10_000n
      debt += (assets[a.symbol].debt * pool.prices[a.symbol] + unit - 1n) / unit
    }
    health = debt === 0n ? MAX_UINT : (liquidation * 10n ** 18n) / debt
  }

  return {
    address,
    assets,
    collateralUsd8: collateral,
    debtUsd8: debt,
    borrowLimitUsd8: limit,
    liquidationUsd8: liquidation,
    healthWad: health,
    loaded: Boolean(address) && isSuccess,
    refetch: () => void refetch(),
  }
}
