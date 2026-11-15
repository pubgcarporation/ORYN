import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrivyProvider } from '@privy-io/react-auth'
import { WagmiProvider } from '@privy-io/wagmi'
import { arcTestnet } from 'viem/chains'
import { PRIVY_APP_ID, privyChains, privyWagmiConfig } from './config'
import { Logo } from './components/Logo'

const queryClient = new QueryClient()

/** One sign-in window for everything: Google, browser wallets and WalletConnect, all through Privy. */
export function Providers({ children }: { children: ReactNode }) {
  if (!PRIVY_APP_ID) return <SetupNotice />

  return (
    <PrivyProvider
      appId={PRIVY_APP_ID}
      config={{
        loginMethods: ['google', 'email', 'wallet'],
        appearance: { theme: 'dark', accentColor: '#b9a6ff', showWalletLoginFirst: false },
        embeddedWallets: { ethereum: { createOnLogin: 'users-without-wallets' } },
        defaultChain: arcTestnet,
        supportedChains: [...privyChains],
      }}
    >
      <QueryClientProvider client={queryClient}>
        <WagmiProvider config={privyWagmiConfig}>{children}</WagmiProvider>
      </QueryClientProvider>
    </PrivyProvider>
  )
}

function SetupNotice() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <div className="card max-w-md p-8 text-center">
        <div className="mb-4 flex justify-center">
          <Logo />
        </div>
        <h1 className="display text-2xl font-semibold">Sign-in is not set up yet</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>
          Add your Privy app ID to the environment as <span className="mono">VITE_PRIVY_APP_ID</span>, then restart the app.
        </p>
      </div>
    </div>
  )
}
