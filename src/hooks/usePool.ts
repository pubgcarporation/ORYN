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
  type Reserve,
} from '@/lib/pool'

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
  eurc8: bigint
  priceFresh: boolean
  paused: boolean
  loaded: boolean
  refetch: () => void
}

/** Market-wide state: both reserves, the EURC price, oracle freshness and the pause flag. */
export function usePool(): PoolState {
  const { data, isSuccess, refetch } = useReadContracts({
    contracts: [
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getReserveData', args: [ASSETS.USDC.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'getReserveData', args: [ASSETS.EURC.address], chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'eurUsdPrice', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'isPriceFresh', chainId: ARC_ID },
      { address: POOL_ADDRESS, abi: poolAbi, functionName: 'paused', chainId: ARC_ID },
    ],
    query: { refetchInterval: REFRESH_MS },
  })

  const usdc = data?.[0]?.result
  const eurc = data?.[1]?.result
  const price = data?.[2]?.result
  const fresh = data?.[3]?.result
  const paused = data?.[4]?.result

  return {
    reserves: {
      USDC: usdc ? reserveFromTuple(usdc) : EMPTY_RESERVE,
      EURC: eurc ? reserveFromTuple(eurc) : EMPTY_RESERVE,
    },
    eurc8: typeof price === 'bigint' ? price : 0n,
    priceFresh: fresh === true,
    paused: paused === true,
    loaded: isSuccess && Boolean(usdc) && Boolean(eurc),
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
export function useUser(): UserState {
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

  const accountRaw: unknown = data?.[12]?.result
  const account = Array.isArray(accountRaw) && accountRaw.length === 5 ? (accountRaw as readonly bigint[]) : undefined
  const hasAccount = account !== undefined

  return {
    address,
    assets: address ? { USDC: position(0), EURC: position(6) } : { USDC: EMPTY_POSITION, EURC: EMPTY_POSITION },
    collateralUsd8: hasAccount ? account[0] : 0n,
    debtUsd8: hasAccount ? account[1] : 0n,
    borrowLimitUsd8: hasAccount ? account[2] : 0n,
    liquidationUsd8: hasAccount ? account[3] : 0n,
    healthWad: hasAccount ? account[4] : MAX_UINT,
    loaded: Boolean(address) && isSuccess,
    refetch: () => void refetch(),
  }
}
