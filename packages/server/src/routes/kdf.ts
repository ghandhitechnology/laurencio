import {
  type KdfParams,
  KdfWriteRequest,
  KdfWriteResponse,
  PROTOCOL_VERSION,
  StoreId,
} from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requirePrincipal } from '../context'
import type { Database } from '../db/client'
import { kdfParams, kdfParamVersions } from '../db/schema'
import { recordAudit, requireStore } from '../devices'
import { badRequest, conflict, notFound } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { enforceRateLimit } from '../rate'
import { type KdfRowFields, toKdfParams } from './me'

type KdfRow = typeof kdfParams.$inferSelect
type KdfVersionRow = typeof kdfParamVersions.$inferSelect

const MIN_M = 19_456
const MIN_T = 2
const MIN_P = 1
const MAX_M = 4_000_000
const MAX_T = 100
const MAX_P = 64

/** Bounds keep a malicious device from poisoning enrollment with junk costs. */
const KdfWriteBody = KdfWriteRequest.refine(
  (value) => value.m >= MIN_M && value.m <= MAX_M,
  `m must be between ${MIN_M} and ${MAX_M} KiB`,
)
  .refine(
    (value) => value.t >= MIN_T && value.t <= MAX_T,
    `t must be between ${MIN_T} and ${MAX_T}`,
  )
  .refine(
    (value) => value.p >= MIN_P && value.p <= MAX_P,
    `p must be between ${MIN_P} and ${MAX_P}`,
  )

/**
 * The latest generation is what new devices derive against. Writes rotate:
 * the superseded row is copied to kdf_param_versions, so enrollment can still
 * resolve the generation it was handed while an audit trail survives.
 */
export function createKdfRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/stores/:id/kdf-params', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const row = await readKdf(deps.db, storeId)
    const rawVersion = c.req.query('version')
    if (rawVersion !== undefined) {
      const generation = Number(rawVersion)
      if (!Number.isInteger(generation) || generation < 1) {
        throw badRequest('version must be a positive integer')
      }
      if (row?.generation === generation) {
        return c.json({
          protocolVersion: PROTOCOL_VERSION,
          kdf: toKdfParams(row),
          generation,
        })
      }
      const historical = await readKdfVersion(deps.db, storeId, generation)
      if (!historical) throw notFound('unknown KDF parameter version')
      return c.json({
        protocolVersion: PROTOCOL_VERSION,
        kdf: toKdfParams(historical),
        generation,
      })
    }
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      kdf: row ? toKdfParams(row) : null,
      generation: row?.generation ?? null,
    })
  })

  app.put('/v1/stores/:id/kdf-params', async (c) => {
    const principal = requirePrincipal(c)
    enforceRateLimit(deps.rateLimiter, `kdf:${rateLimitKey(principal)}`)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const body = KdfWriteBody.safeParse(await readJson(c))
    if (!body.success) throw badRequest('invalid KDF parameters', { issues: body.error.issues })

    const result = await writeLatest(deps.db, storeId, body.data)
    if (result.kind === 'conflict') {
      throw conflict('store KDF generation changed', { generation: result.generation })
    }
    if (result.rotated) {
      await recordAudit(deps.db, {
        actorUserId: principal.userId,
        deviceId: principal.deviceId,
        action: 'kdf.rotate',
        subject: storeId,
        meta: {
          generation: result.row.generation,
          m: result.row.m,
          t: result.row.t,
          p: result.row.p,
        },
      })
    } else if (result.created) {
      await recordAudit(deps.db, {
        actorUserId: principal.userId,
        deviceId: principal.deviceId,
        action: 'kdf.set',
        subject: storeId,
        meta: { generation: result.row.generation, m: body.data.m, t: body.data.t, p: body.data.p },
      })
    }
    return c.json(
      KdfWriteResponse.parse({
        protocolVersion: PROTOCOL_VERSION,
        kdf: toKdfParams(result.row),
        generation: result.row.generation,
      }),
    )
  })

  return app
}

async function readKdf(db: Database, storeId: string): Promise<KdfRow | null> {
  const rows = await db.select().from(kdfParams).where(eq(kdfParams.storeId, storeId)).limit(1)
  return rows.at(0) ?? null
}

async function readKdfVersion(
  db: Database,
  storeId: string,
  generation: number,
): Promise<KdfVersionRow | null> {
  const rows = await db
    .select()
    .from(kdfParamVersions)
    .where(and(eq(kdfParamVersions.storeId, storeId), eq(kdfParamVersions.generation, generation)))
    .limit(1)
  return rows.at(0) ?? null
}

interface WriteResult {
  row: KdfRow
  created: boolean
  rotated: boolean
}

type WriteOutcome =
  | ({ kind: 'written' } & WriteResult)
  | { kind: 'conflict'; generation: number | null }

/**
 * Compare-and-set on the generation the writer read. Identical parameters are
 * a no-op, so a retry of a write that already landed still succeeds. The
 * three-attempt loop retries a lost race before reporting a conflict.
 */
async function writeLatest(
  db: Database,
  storeId: string,
  incoming: KdfWriteRequest,
): Promise<WriteOutcome> {
  const expected = incoming.generation
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await readKdf(db, storeId)
    if (!existing) {
      // Null means first write; any other generation expected a row.
      if (expected !== null) return { kind: 'conflict', generation: null }
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
      if (matches(stored, incoming)) {
        return { kind: 'written', row: stored, created: true, rotated: false }
      }
      continue
    }
    if (matches(existing, incoming)) {
      return { kind: 'written', row: existing, created: false, rotated: false }
    }
    if (existing.generation !== expected) {
      return { kind: 'conflict', generation: existing.generation }
    }
    const rotated = await rotate(db, existing, incoming)
    if (rotated) return { kind: 'written', row: rotated, created: false, rotated: true }
  }
  throw new Error('kdf rotation kept losing the compare-and-set race')
}

async function rotate(db: Database, existing: KdfRow, incoming: KdfParams): Promise<KdfRow | null> {
  return db.transaction(async (tx) => {
    await tx
      .insert(kdfParamVersions)
      .values({
        storeId: existing.storeId,
        generation: existing.generation,
        algo: existing.algo,
        version: existing.version,
        salt: existing.salt,
        m: existing.m,
        t: existing.t,
        p: existing.p,
        calibratedAt: existing.calibratedAt,
      })
      .onConflictDoNothing()
    const updated = await tx
      .update(kdfParams)
      .set({
        algo: incoming.algo,
        version: incoming.version,
        salt: incoming.salt,
        m: incoming.m,
        t: incoming.t,
        p: incoming.p,
        calibratedAt: new Date(incoming.calibratedAt),
        setAt: new Date(),
        generation: existing.generation + 1,
      })
      .where(
        and(eq(kdfParams.storeId, existing.storeId), eq(kdfParams.generation, existing.generation)),
      )
      .returning()
    return updated.at(0) ?? null
  })
}

function matches(row: KdfRowFields, incoming: KdfParams): boolean {
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
