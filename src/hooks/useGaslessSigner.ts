import { useMemo } from 'react'
import { useSign7702Authorization, useSignTypedData, useWallets } from '@privy-io/react-auth'
import type { Address, TypedDataDefinition } from 'viem'
import { useAccount } from 'wagmi'
import type { GaslessSigner } from '@/lib/gaslessBridge'

/**
 * A signer for gas-in-USDC bridging, or undefined when the connected wallet cannot do it.
 * EIP-7702 upgrades are signed by the app's own (Privy) wallet. Browser wallets such as MetaMask do not
 * let a website sign one, so they keep the normal bridge.
 */
export function useGaslessSigner(): GaslessSigner | undefined {
  const { address } = useAccount()
  const { wallets } = useWallets()
  const { signAuthorization } = useSign7702Authorization()
  const { signTypedData } = useSignTypedData()

  const embedded = wallets.find((w) => w.walletClientType === 'privy' && w.address.toLowerCase() === address?.toLowerCase())
  const owner = embedded?.address as Address | undefined

  return useMemo(() => {
    if (!owner) return undefined
    return {
      address: owner,
      signTypedData: async (data: TypedDataDefinition) => {
        const { signature } = await signTypedData(data as unknown as Parameters<typeof signTypedData>[0], { address: owner })
        return signature as `0x${string}`
      },
      signAuthorization: async ({ contractAddress, chainId, nonce }) => {
        const signed = await signAuthorization({ contractAddress, chainId, nonce }, { address: owner })
        return { ...signed, address: signed.address }
      },
    }
  }, [owner, signAuthorization, signTypedData])
}
