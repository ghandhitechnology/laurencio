import type { DeviceId, UserId } from '@laurencio/protocol'
import type { Hono } from 'hono'
import type { Database } from './db/client'
import type { ServerEnv } from './env'
import { unauthenticated } from './http/errors'
import type { Logger } from './log'
import type { RateLimiter } from './rate'
import type { BlobStore } from './storage/types'

export interface Principal {
  userId: UserId
  /** Set when the request authenticated with a device token. */
  deviceId: DeviceId | null
  tokenId: string | null
}

export interface AppVariables {
  requestId: string
  principal: Principal | null
}

export interface AppBindings {
  Variables: AppVariables
}

export type App = Hono<AppBindings>

export interface RouteDeps {
  env: ServerEnv
  db: Database
  storage: BlobStore
  logger: Logger
  rateLimiter: RateLimiter
  /** Browser-side writes get their own bucket, keyed by client address. */
  webRateLimiter: RateLimiter
}

export function requirePrincipal(ctx: { get: (key: 'principal') => Principal | null }): Principal {
  const principal = ctx.get('principal')
  if (!principal) throw unauthenticated()
  return principal
}

export function rateLimitKey(principal: Principal): string {
  return principal.deviceId ? `device:${principal.deviceId}` : `user:${principal.userId}`
}
