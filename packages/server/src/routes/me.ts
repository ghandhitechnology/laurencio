import {
  KdfParams,
  type MeResponse,
  MeResponse as MeResponseSchema,
  PROTOCOL_VERSION,
} from '@laurencio/protocol'
import { count, eq, sum } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { requirePrincipal } from '../context'
import { blobs, kdfParams } from '../db/schema'
import { ensureStore, listDevices } from '../devices'
import { limitsFor } from '../quota'

export function createMeRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/me', async (c) => {
    const principal = requirePrincipal(c)
    const store = await ensureStore(deps.db, principal.userId)
    const [devices, kdfRow, usageRows] = await Promise.all([
      listDevices(deps.db, principal.userId, { includeRevoked: true }),
      deps.db.select().from(kdfParams).where(eq(kdfParams.storeId, store.id)).limit(1),
      deps.db
        .select({ blobs: count(), bytes: sum(blobs.size) })
        .from(blobs)
        .where(eq(blobs.storeId, store.id)),
    ])
    const kdf = kdfRow.at(0)
    const usage = usageRows.at(0)
    const body: MeResponse = MeResponseSchema.parse({
      protocolVersion: PROTOCOL_VERSION,
      userId: principal.userId,
      storeId: store.id,
      devices,
      kdf: kdf ? toKdfParams(kdf) : null,
      quotas: {
        blobs: Number(usage?.blobs ?? 0),
        bytes: usage?.bytes ? Number(usage.bytes) : 0,
        maxBytes: limitsFor(deps.env, store).maxBytes,
      },
    })
    return c.json(body)
  })

  return app
}

export function toKdfParams(row: typeof kdfParams.$inferSelect): KdfParams {
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
