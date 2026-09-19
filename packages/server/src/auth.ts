import { newId } from '@laurencio/protocol'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { bearer, deviceAuthorization } from 'better-auth/plugins'
import type { Context, Next } from 'hono'
import type { AppBindings } from './context'
import type { Database } from './db/client'
import * as schema from './db/schema'
import { authenticateDeviceToken, touchDevice } from './devices'
import type { ServerEnv } from './env'
import { unauthenticated } from './http/errors'
import { asUserId } from './ids'

export function createAuth(options: { db: Database; env: ServerEnv }) {
  const { db, env } = options
  const github =
    env.auth.githubClientId && env.auth.githubClientSecret
      ? {
          github: {
            clientId: env.auth.githubClientId,
            clientSecret: env.auth.githubClientSecret,
          },
        }
      : null
  return betterAuth({
    appName: 'Laurencio',
    baseURL: env.publicUrl,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    trustedOrigins: env.trustedOrigins,
    emailAndPassword: { enabled: env.auth.allowDevSignin },
    ...(github ? { socialProviders: github } : {}),
    // Generate ids in the same sortable format the protocol uses.
    advanced: { database: { generateId: () => newId() } },
    plugins: [
      bearer(),
      deviceAuthorization({
        verificationUri: '/device',
        interval: env.auth.devicePollInterval,
        validateClient: (clientId) => clientId === env.auth.deviceClientId,
      }),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

export async function getSession(auth: Auth, headers: Headers) {
  return auth.api.getSession({ headers })
}

/**
 * Accepts either a Laurencio device token or a Better Auth session (cookie or
 * bearer token from the device flow). Everything under /v1 uses this.
 */
export function createAuthMiddleware(deps: { auth: Auth; db: Database }) {
  return async (c: Context<AppBindings>, next: Next): Promise<void> => {
    const header = c.req.header('authorization')
    const token = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : null
    if (token?.startsWith('lrn_')) {
      const deviceAuth = await authenticateDeviceToken(deps.db, token)
      if (!deviceAuth) throw unauthenticated('device token is unknown, revoked, or expired')
      await touchDevice(deps.db, deviceAuth)
      c.set('principal', deviceAuth.principal)
      await next()
      return
    }
    const session = await getSession(deps.auth, c.req.raw.headers)
    if (!session?.user) throw unauthenticated('sign in or present a device token')
    c.set('principal', { userId: asUserId(session.user.id), deviceId: null, tokenId: null })
    await next()
  }
}
