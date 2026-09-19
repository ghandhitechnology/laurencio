import {
  KdfParams,
  type MeResponse,
  MeResponse as MeResponseSchema,
  PROTOCOL_VERSION,
} from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { requirePrincipal } from '../context'
import { kdfParams } from '../db/schema'
import { ensureStore, listDevices } from '../devices'
import { limitsFor, usageFor } from '../quota'

export function createMeRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/me', async (c) => {
    const principal = requirePrincipal(c)
    const store = await ensureStore(deps.db, principal.userId)
    const [devices, kdfRow, usage] = await Promise.all([
      listDevices(deps.db, principal.userId, { includeRevoked: true }),
      deps.db.select().from(kdfParams).where(eq(kdfParams.storeId, store.id)).limit(1),
      usageFor(deps.db, store.id),
    ])
    const kdf = kdfRow.at(0)
    const body: MeResponse = MeResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      userId: principal.userId,
      storeId: store.id,
      devices,
      kdf: kdf ? toKdfParams(kdf) : null,
      quotas: {
        blobs: usage.blobs,
        bytes: usage.bytes,
        maxBytes: limitsFor(deps.env, store).maxBytes,
      },
    })
    // Sibling field rather than part of the protocol payload: clients that
    // know about rotation read it, older parsers ignore it.
    return c.json({ ...body, kdfGeneration: kdf?.generation ?? null })
  })

  return app
}

export interface KdfRowFields {
  algo: string
  version: number
  salt: string
  m: number
  t: number
  p: number
  calibratedAt: Date
}

export function toKdfParams(row: KdfRowFields): KdfParams {
  // Parse rather than assume: a row that disagrees with the protocol should
  // fail loudly here instead of being handed to a client as-is.
  return KdfParams.parse({
    algo: row.algo,
    version: row.version,
    salt: row.salt,
    m: row.m,
    t: row.t,
    p: row.p,
    calibratedAt: row.calibratedAt.toISOString(),
  })
}
