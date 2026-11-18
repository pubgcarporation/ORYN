import { erc20Abi, maxUint256, type Address } from 'viem'
import { WAD, errText, poolAbi, poolAddress, walletFor, type Clients } from './chain'
import { discoverBorrowers, pruneBorrowers } from './borrowers'
import { getBorrowers } from './state'
import type { Action, Env } from './types'

export interface ScanResult {
  actions: Action[]
  pricesFresh: boolean
  borrowersWatched: number
  atRisk: number
  liquidatable: number
  liquidationsDone: number
  error?: string
}

interface AssetMeta {
  address: Address
  decimals: number
  symbol: string
}

let assetCache: AssetMeta[] | undefined

async function loadAssets(env: Env, c: Clients): Promise<AssetMeta[]> {
  if (assetCache) return assetCache
  const [usdc, eurc, cirBtc] = await c.testnet.readContract({ address: poolAddress(env), abi: poolAbi, functionName: 'assets' })
  const list: [Address, string][] = [
    [usdc, 'USDC'],
    [eurc, 'EURC'],
    [cirBtc, 'cirBTC'],
  ]
  const decimals = await Promise.all(list.map(([address]) => c.testnet.readContract({ address, abi: erc20Abi, functionName: 'decimals' })))
  assetCache = list.map(([address, symbol], i) => ({ address, symbol, decimals: decimals[i] }))
  return assetCache
}

/** Dollar value with eight decimals, from a token amount and the pool's 8-decimal price. */
const usd8 = (amount: bigint, price8: bigint, decimals: number) => (amount * price8) / 10n ** BigInt(decimals)

/**
 * One pass: find loans whose health is below 1, then ask the pool to liquidate them.
 * The decision is never made off-chain. The bot only chooses who to try, and the contract itself checks
 * that the borrower is below the threshold using its fresh Chainlink-based prices, or it reverts.
 */
export async function scanAndLiquidate(env: Env, c: Clients, opts: { refresh: boolean }): Promise<ScanResult> {
  const actions: Action[] = []
  const result: ScanResult = { actions, pricesFresh: false, borrowersWatched: 0, atRisk: 0, liquidatable: 0, liquidationsDone: 0 }
  const pool = poolAddress(env)

  const [fresh, paused] = await Promise.all([
    c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'isPriceFresh' }),
    c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'paused' }),
  ])
  result.pricesFresh = fresh

  let state = await getBorrowers(env)
  if (opts.refresh) {
    const found = await discoverBorrowers(env, c)
    state = found.state
    if (found.error) result.error = found.error
  }
  const addresses = state.addresses
  result.borrowersWatched = addresses.length
  if (addresses.length === 0) return result

  const accounts = await Promise.all(
    addresses.map((user) =>
      c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'getUserAccount', args: [user as Address] }).then(
        (r) => ({ user, debt: r[1], health: r[4] }),
        () => undefined,
      ),
    ),
  )
  const live = accounts.filter((a): a is NonNullable<typeof a> => a !== undefined)
  if (opts.refresh) {
    const withDebt = live.filter((a) => a.debt > 0n).map((a) => a.user)
    if (withDebt.length !== addresses.length) await pruneBorrowers(env, state, withDebt)
  }
  const open = live.filter((a) => a.debt > 0n)
  result.atRisk = open.filter((a) => a.health < (WAD * 12n) / 10n).length
  const risky = open.filter((a) => a.health < WAD).sort((a, b) => (a.debt < b.debt ? 1 : -1))
  result.liquidatable = risky.length

  if (risky.length === 0) return result
  if (!fresh) {
    actions.push({ t: Date.now(), kind: 'skip', text: `${risky.length} loan(s) look unhealthy, but the pool's Chainlink prices are stale, so it would refuse` })
    return result
  }
  if (paused) {
    actions.push({ t: Date.now(), kind: 'skip', text: 'The pool is paused, so liquidations are off' })
    return result
  }

  const liquidator = walletFor(env, c, env.LIQUIDATOR_PRIVATE_KEY)
  if (!liquidator) {
    actions.push({ t: Date.now(), kind: 'skip', text: `${risky.length} loan(s) can be liquidated, but no liquidator key is set` })
    return result
  }

  const assets = await loadAssets(env, c)
  const prices = await Promise.all(assets.map((a) => c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'priceOf', args: [a.address] })))
  const minRepayUsd8 = BigInt(Math.round(Number(env.MIN_REPAY_USD ?? '0.5') * 1e8))
  const maxPerTick = Number(env.MAX_LIQUIDATIONS_PER_TICK ?? '3')
  const dry = env.DRY_RUN === '1'

  for (const target of risky.slice(0, maxPerTick)) {
    try {
      const position = await c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'getUserPosition', args: [target.user as Address] })
      let debtIdx = 0
      let collIdx = 0
      let bestDebt = -1n
      let bestColl = -1n
      for (let i = 0; i < 3; i++) {
        const dv = usd8(position.debtBalances[i], prices[i], assets[i].decimals)
        const sv = usd8(position.supplyBalances[i], prices[i], assets[i].decimals)
        if (dv > bestDebt) [bestDebt, debtIdx] = [dv, i]
        if (sv > bestColl) [bestColl, collIdx] = [sv, i]
      }
      const debtAsset = assets[debtIdx]
      // Aave V3 style close factor: 50% of one debt asset, or 100% when health is below 0.95.
      const closeBps = await c.testnet.readContract({ address: pool, abi: poolAbi, functionName: 'liquidationCloseFactor', args: [target.user as Address] })
      const half = (position.debtBalances[debtIdx] * closeBps) / 10_000n
      const balance = await c.testnet.readContract({ address: debtAsset.address, abi: erc20Abi, functionName: 'balanceOf', args: [liquidator.account.address] })
      const repay = half < balance ? half : balance
      if (repay === 0n || usd8(repay, prices[debtIdx], debtAsset.decimals) < minRepayUsd8) {
        actions.push({ t: Date.now(), kind: 'skip', text: `Loan ${target.user.slice(0, 8)} is liquidatable but the bot has too little ${debtAsset.symbol} to repay` })
        continue
      }

      const allowance = await c.testnet.readContract({ address: debtAsset.address, abi: erc20Abi, functionName: 'allowance', args: [liquidator.account.address, pool] })
      if (allowance < repay && !dry) {
        const approveHash = await liquidator.client.writeContract({ address: debtAsset.address, abi: erc20Abi, functionName: 'approve', args: [pool, maxUint256] })
        await c.testnet.waitForTransactionReceipt({ hash: approveHash, timeout: 25_000 })
      }

      // A dry run of the call. The contract re-checks health and price freshness and reverts if either fails.
      const { request } = await c.testnet.simulateContract({
        account: liquidator.account,
        address: pool,
        abi: poolAbi,
        functionName: 'liquidate',
        args: [target.user as Address, debtAsset.address, assets[collIdx].address, repay, env.RECEIVE_SUPPLY_SHARES === '1'],
      })
      if (dry) {
        actions.push({ t: Date.now(), kind: 'skip', text: `Dry run: would repay ${debtAsset.symbol} for ${target.user.slice(0, 8)} and take ${assets[collIdx].symbol}` })
        continue
      }
      const hash = await liquidator.client.writeContract(request)
      const receipt = await c.testnet.waitForTransactionReceipt({ hash, timeout: 25_000 })
      if (receipt.status === 'success') {
        result.liquidationsDone += 1
        actions.push({ t: Date.now(), kind: 'liquidate', text: `Liquidated ${target.user.slice(0, 8)}...: repaid ${debtAsset.symbol}, took ${assets[collIdx].symbol}`, hash })
      } else {
        actions.push({ t: Date.now(), kind: 'error', text: `Liquidation of ${target.user.slice(0, 8)} reverted`, hash })
      }
    } catch (e) {
      actions.push({ t: Date.now(), kind: 'error', text: `Liquidation of ${target.user.slice(0, 8)} refused: ${errText(e)}` })
    }
  }
  return result
}
