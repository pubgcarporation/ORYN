import { createRemoteJWKSet, jwtVerify } from 'jose'
import { HttpError } from './errors.js'

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined

/**
 * Checks the Privy sign-in token against Privy's public keys and returns the account id.
 * Without this, anyone who finds the API could spend from somebody's agent wallet.
 */
export async function requireUser(authorization: string | string[] | undefined): Promise<string> {
  const appId = process.env.VITE_PRIVY_APP_ID
  if (!appId) throw new HttpError(503, 'auth_not_configured', 'Set VITE_PRIVY_APP_ID on the server to turn on the agent wallet.')

  const header = Array.isArray(authorization) ? authorization[0] : authorization
  const token = header?.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'unauthorized', 'Sign in to use the agent wallet.')

  jwks ??= createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`))
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: 'privy.io', audience: appId })
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) throw new Error('no subject')
    return payload.sub
  } catch {
    throw new HttpError(401, 'unauthorized', 'Your sign-in expired. Sign in again.')
  }
}
