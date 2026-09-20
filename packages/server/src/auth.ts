import { newId } from '@laurencio/protocol'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { APIError, createAuthMiddleware as authHook } from 'better-auth/api'
import { bearer, deviceAuthorization } from 'better-auth/plugins'
import type { Context, Next } from 'hono'
import type { AppBindings } from './context'
import type { Database } from './db/client'
import * as schema from './db/schema'
import { authenticateDeviceToken, touchDevice } from './devices'
import type { ServerEnv } from './env'
import { tokenExpired, unauthenticated } from './http/errors'
import { asUserId } from './ids'

export function createAuth(options: { db: Database; env: ServerEnv }) {
  const { db, env } = options
  return betterAuth({
    appName: 'Laurencio',
    baseURL: env.publicUrl,
    secret: env.secret,
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    trustedOrigins: env.trustedOrigins,
    emailAndPassword: { enabled: env.auth.allowDevSignin },
    hooks: {
      before: authHook(async (ctx) => {
        if (env.nodeEnv !== 'staging') return
        if (ctx.path !== '/sign-in/email' && ctx.path !== '/sign-up/email') return
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email.trim().toLowerCase() : ''
        if (!env.auth.stagingEmailAllowlist.includes(email)) {
          throw new APIError('FORBIDDEN', { message: 'This email does not have staging access.' })
        }
      }),
    },
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
      const result = await authenticateDeviceToken(deps.db, token)
      if (!result.ok) {
        if (result.reason === 'expired') throw tokenExpired()
        throw unauthenticated('device token is unknown or revoked')
      }
      await touchDevice(deps.db, result.auth)
      c.set('principal', result.auth.principal)
      await next()
      return
    }
    const session = await getSession(deps.auth, c.req.raw.headers)
    if (!session?.user) throw unauthenticated('sign in or present a device token')
    c.set('principal', { userId: asUserId(session.user.id), deviceId: null, tokenId: null })
    await next()
  }
}
