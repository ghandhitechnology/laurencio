import type { DeviceId, UserId } from '@laurencio/protocol'
import type { Hono } from 'hono'
import type { Database } from './db/client'
import type { ServerEnv } from './env'
import { forbidden, unauthenticated } from './http/errors'
import type { Logger } from './log'
import type { RateLimiter } from './rate'
import type { BlobStore } from './storage/types'

export type PrincipalKind = 'account' | 'full-device' | 'temporary-workbench'

export interface Principal {
  userId: UserId
  /** Set when the request authenticated with a device token. */
  deviceId: DeviceId | null
  tokenId: string | null
  kind: PrincipalKind
}

export type PrincipalCapability =
  | 'manage-devices'
  | 'manage-workbench-sessions'
  | 'close-own-workbench'
  | 'write-kdf'
  | 'migrate-profile'
  | 'write-profile'

const ALL_CAPABILITIES: readonly PrincipalCapability[] = [
  'manage-devices',
  'manage-workbench-sessions',
  'close-own-workbench',
  'write-kdf',
  'migrate-profile',
  'write-profile',
]

const CAPABILITIES: Record<PrincipalKind, ReadonlySet<PrincipalCapability>> = {
  account: new Set(ALL_CAPABILITIES),
  'full-device': new Set(ALL_CAPABILITIES),
  'temporary-workbench': new Set(['close-own-workbench']),
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
  now(): Date
}

export function requirePrincipal(ctx: { get: (key: 'principal') => Principal | null }): Principal {
  const principal = ctx.get('principal')
  if (!principal) throw unauthenticated()
  return principal
}

/** Enforces actor privileges before a route reads or mutates protected state. */
export function requireCapability(principal: Principal, capability: PrincipalCapability): void {
  if (!CAPABILITIES[principal.kind].has(capability)) {
    throw forbidden(`temporary workbenches cannot ${capability.replaceAll('-', ' ')}`)
  }
}

export function rateLimitKey(principal: Principal): string {
  return principal.deviceId ? `device:${principal.deviceId}` : `user:${principal.userId}`
}
