import { KdfParams, PROTOCOL_VERSION, StoreId } from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requirePrincipal } from '../context'
import type { Database } from '../db/client'
import { kdfParams } from '../db/schema'
import { recordAudit, requireStore } from '../devices'
import { badRequest, conflict } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { enforceRateLimit } from '../rate'
import { toKdfParams } from './me'

type KdfRow = typeof kdfParams.$inferSelect
type KdfInput = KdfParams

/**
 * The request carries the full public parameter set. Reads are open to the
 * store owner; the first write wins and later writes must match it exactly.
 */
const KdfWriteRequest = KdfParams.refine((value) => value.m <= 4_000_000, 'm is out of range')
  .refine((value) => value.t <= 100, 't is out of range')
  .refine((value) => value.p <= 64, 'p is out of range')

export function createKdfRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/stores/:id/kdf-params', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const row = await readKdf(deps.db, storeId)
    return c.json({ protocolVersion: PROTOCOL_VERSION, kdf: row ? toKdfParams(row) : null })
  })

  app.put('/v1/stores/:id/kdf-params', async (c) => {
    const principal = requirePrincipal(c)
    enforceRateLimit(deps.rateLimiter, `kdf:${rateLimitKey(principal)}`)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const body = KdfWriteRequest.safeParse(await readJson(c))
    if (!body.success) throw badRequest('invalid KDF parameters', { issues: body.error.issues })

    const result = await writeOnce(deps.db, storeId, body.data)
    if (result.created) {
      await recordAudit(deps.db, {
        actorUserId: principal.userId,
        deviceId: principal.deviceId,
        action: 'kdf.set',
        subject: storeId,
        meta: { m: body.data.m, t: body.data.t, p: body.data.p },
      })
    }
    return c.json({ protocolVersion: PROTOCOL_VERSION, kdf: toKdfParams(result.row) })
  })

  return app
}

async function readKdf(db: Database, storeId: string): Promise<KdfRow | null> {
  const rows = await db.select().from(kdfParams).where(eq(kdfParams.storeId, storeId)).limit(1)
  return rows.at(0) ?? null
}

async function writeOnce(
  db: Database,
  storeId: string,
  incoming: KdfInput,
): Promise<{ row: KdfRow; created: boolean }> {
  const existing = await readKdf(db, storeId)
  if (existing) {
    if (!matches(existing, incoming)) throw alreadySet(existing)
    return { row: existing, created: false }
  }
  await db
    .insert(kdfParams)
    .values({
      storeId,
      algo: incoming.algo,
      version: incoming.version,
      salt: incoming.salt,
      m: incoming.m,
      t: incoming.t,
      p: incoming.p,
      calibratedAt: new Date(incoming.calibratedAt),
    })
    .onConflictDoNothing()
  const stored = await readKdf(db, storeId)
  if (!stored) throw new Error('kdf parameters vanished between insert and read')
  if (!matches(stored, incoming)) throw alreadySet(stored)
  return { row: stored, created: true }
}

function matches(row: KdfRow, incoming: KdfInput): boolean {
  return (
    row.algo === incoming.algo &&
    row.version === incoming.version &&
    row.salt === incoming.salt &&
    row.m === incoming.m &&
    row.t === incoming.t &&
    row.p === incoming.p &&
    row.calibratedAt.getTime() === new Date(incoming.calibratedAt).getTime()
  )
}

function alreadySet(row: KdfRow) {
  return conflict('KDF parameters are already set for this store and cannot change', {
    setAt: row.setAt.toISOString(),
  })
}
