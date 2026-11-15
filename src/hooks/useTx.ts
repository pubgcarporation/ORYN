import { useCallback, useState } from 'react'
import { useAccount, usePublicClient, useSwitchChain } from 'wagmi'
import type { Hash } from 'viem'
import { ARC_ID, parseError } from '@/lib/pool'

export type TxPhase = 'idle' | 'wallet' | 'confirming' | 'success' | 'error'

export interface TxStep {
  label: string
  send: () => Promise<Hash>
}

export interface TxState {
  phase: TxPhase
  stepLabel: string
  hash: Hash | undefined
  error: string | undefined
}

const IDLE: TxState = { phase: 'idle', stepLabel: '', hash: undefined, error: undefined }

/**
 * Runs one or more contract writes in order (for example approve, then deposit).
 * Each step waits for its receipt before the next starts, and the wallet is moved
 * to Arc Testnet first.
 */
export function useTx(onDone?: () => void) {
  const { chainId } = useAccount()
  const { switchChainAsync } = useSwitchChain()
  const client = usePublicClient({ chainId: ARC_ID })
  const [state, setState] = useState<TxState>(IDLE)

  const reset = useCallback(() => setState(IDLE), [])

  const run = useCallback(
    async (steps: TxStep[]) => {
      if (!client) return
      try {
        if (chainId !== ARC_ID) await switchChainAsync({ chainId: ARC_ID })
        let last: Hash | undefined
        for (const step of steps) {
          setState({ phase: 'wallet', stepLabel: step.label, hash: last, error: undefined })
          const hash = await step.send()
          setState({ phase: 'confirming', stepLabel: step.label, hash, error: undefined })
          const receipt = await client.waitForTransactionReceipt({ hash })
          if (receipt.status !== 'success') throw new Error('Transaction reverted')
          last = hash
        }
        setState({ phase: 'success', stepLabel: '', hash: last, error: undefined })
        onDone?.()
      } catch (e) {
        const message = parseError(e)
        // A rejected signature is not an error: return to the form quietly.
        setState(message === 'cancelled' ? IDLE : { phase: 'error', stepLabel: '', hash: undefined, error: message })
      }
    },
    [chainId, client, onDone, switchChainAsync],
  )

  return { ...state, run, reset, busy: state.phase === 'wallet' || state.phase === 'confirming' }
}
