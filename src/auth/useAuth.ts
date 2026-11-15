import { usePrivy } from '@privy-io/react-auth'

export interface AuthActions {
  /** Opens the Privy sign-in window: Google or a wallet. */
  login: () => void
  logout: () => void
  ready: boolean
  /** Email of the signed-in Google account, when there is one. */
  identity: string | undefined
  viaGoogle: boolean
}

export function useAuth(): AuthActions {
  const { login, logout, ready, user } = usePrivy()
  return {
    login: () => login(),
    logout: () => void logout(),
    ready,
    identity: user?.google?.email ?? user?.email?.address,
    viaGoogle: Boolean(user?.google),
  }
}

export const SIGN_IN_LABEL = 'Sign in'
