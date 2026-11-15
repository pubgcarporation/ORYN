/**
 * wagmi configuration
 * Built with Arc Studio — https://studio.arc.io
 */

import { http } from 'wagmi'
import { mainnet } from 'wagmi/chains'
import { arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy } from 'viem/chains'
import { createConfig } from '@privy-io/wagmi'
import { registerChain } from './tracing'

// Pre-register chain RPC URLs so trace events show correct chain names immediately
registerChain(arcTestnet.id, arcTestnet.rpcUrls.default.http[0])

/** Privy app ID from the Privy dashboard. Sign-in (Google and wallets) needs it. */
export const PRIVY_APP_ID = (import.meta.env.VITE_PRIVY_APP_ID as string | undefined)?.trim() ?? ''

export const privyChains = [arcTestnet, sepolia, baseSepolia, arbitrumSepolia, polygonAmoy] as const

const chains = [...privyChains, mainnet] as const // mainnet is only for ENS resolution

/** Privy supplies the wallet connectors: embedded wallet, browser wallets and WalletConnect. */
export const privyWagmiConfig = createConfig({
  chains,
  transports: {
    [arcTestnet.id]: http(),
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
    [polygonAmoy.id]: http(),
    [mainnet.id]: http(),
  },
})
