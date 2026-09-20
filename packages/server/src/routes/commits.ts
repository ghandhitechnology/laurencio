import {
  type BlobId,
  type BlobRef,
  CommitRequest,
  checkProtocolVersion,
  type DeviceId,
  PROTOCOL_VERSION,
  RevisionId,
  type RevisionSummary,
  RevisionSummary as RevisionSummarySchema,
  StoreId,
} from '@laurencio/protocol'
import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import { Hono } from 'hono'
import { verifyStoredObjects } from '../blob-verification'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requirePrincipal } from '../context'
import type { Database } from '../db/client'
import { blobs, revisionBlobs, revisions } from '../db/schema'
import { recordAudit, requireStore, type StoreRow } from '../devices'
import { badRequest, conflict, forbidden, protocolMismatch } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { asBlobId, asDeviceId, asRevisionId, asStoreId } from '../ids'
import { requireCompatibleProfileWrite } from '../profile-version'
import { assertWithinQuota, limitsFor } from '../quota'
import { enforceRateLimit } from '../rate'

type RevisionRow = typeof revisions.$inferSelect

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500

export function createCommitRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.post('/v1/stores/:id/commits', async (c) => {
    const principal = requirePrincipal(c)
    enforceRateLimit(deps.rateLimiter, `commit:${rateLimitKey(principal)}`)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const store = await requireStore(deps.db, principal.userId, storeId)
    requireCompatibleProfileWrite(store, c.req.raw.headers)
    if (!principal.deviceId) {
      throw forbidden('commits require a device token; enroll a device first')
    }
    const parsed = CommitRequest.safeParse(await readJson(c))
    if (!parsed.success) {
      throw badRequest('invalid commit request', { issues: parsed.error.issues })
    }
    const request = parsed.data
    const version = checkProtocolVersion(request.protocolVersion)
    if (!version.ok) throw protocolMismatch(version.reason)

    // Idempotency: the client-generated revision id is the whole contract.
    const existing = await findRevision(deps.db, request.revision.id)
    if (existing) {
      if (existing.storeId !== storeId) {
        throw conflict('revision id belongs to another store', { revisionId: request.revision.id })
      }
      return c.json(accepted(request.revision.id))
    }

    const missingParents = await findMissingParents(deps.db, storeId, request.revision.parents)
    if (missingParents.length > 0) {
      throw badRequest('commit references unknown parent revisions', { missingParents })
    }

    const referenced = collectBlobRefs(request)
    const missing = await checkBlobs(deps.db, storeId, referenced)
    if (missing.length > 0) {
      return c.json({ revisionId: request.revision.id, accepted: false, missing })
    }
    const outstanding = await verifyStoredObjects(deps, storeId, referenced)
    if (outstanding.length > 0) {
      return c.json({ revisionId: request.revision.id, accepted: false, missing: outstanding })
    }

    const stored = await storeRevision(deps, {
      storeId,
      store,
      deviceId: principal.deviceId,
      request,
      referenced,
    })
    if (!stored) {
      // A concurrent duplicate won the insert; the stored row is the result.
      return c.json(accepted(request.revision.id))
    }
    await recordAudit(deps.db, {
      actorUserId: principal.userId,
      deviceId: principal.deviceId,
      action: 'commit.create',
      subject: request.revision.id,
      meta: { blobs: referenced.length, note: request.note ?? null },
    })
    return c.json(accepted(request.revision.id), 201)
  })

  app.get('/v1/stores/:id/commits', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)

    const limit = readLimit(c.req.query('limit'))
    const sinceParam = c.req.query('since')
    let sinceFilter: Date | null = null
    if (sinceParam) {
      const since = parseParam(RevisionId, sinceParam, 'since revision')
      const rows = await findRevision(deps.db, since)
      // `since` is a server-stored revision, so its server-set createdAt is
      // the only ordering key the client cannot influence. An unknown id is
      // treated as "no filter" and returns the newest page.
      if (rows && rows.storeId === storeId) sinceFilter = rows.createdAt
    }

    const headRows = await deps.db
      .select({ id: revisions.id })
      .from(revisions)
      .where(eq(revisions.storeId, storeId))
      .orderBy(desc(revisions.createdAt), desc(revisions.id))
      .limit(1)
    const head = headRows.at(0)?.id ?? null

    const rows = await deps.db
      .select()
      .from(revisions)
      .where(
        sinceFilter
          ? and(eq(revisions.storeId, storeId), gt(revisions.createdAt, sinceFilter))
          : eq(revisions.storeId, storeId),
      )
      .orderBy(desc(revisions.createdAt), desc(revisions.id))
      .limit(limit)

    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      revisions: rows.map(toRevisionSummary),
      head: head ? asRevisionId(head) : null,
    })
  })

  return app
}

function accepted(revisionId: string): {
  revisionId: RevisionId
  accepted: boolean
  missing: BlobId[]
} {
  return { revisionId: asRevisionId(revisionId), accepted: true, missing: [] }
}

function collectBlobRefs(request: CommitRequest): BlobRef[] {
  const seen = new Map<string, BlobRef>()
  seen.set(request.revision.manifest.id, request.revision.manifest)
  for (const blob of request.blobs) seen.set(blob.id, blob)
  return [...seen.values()]
}

async function findRevision(db: Database, revisionId: string): Promise<RevisionRow | null> {
  const rows = await db.select().from(revisions).where(eq(revisions.id, revisionId)).limit(1)
  return rows.at(0) ?? null
}

async function findMissingParents(
  db: Database,
  storeId: StoreId,
  parents: RevisionId[],
): Promise<string[]> {
  if (parents.length === 0) return []
  const found = await db
    .select({ id: revisions.id })
    .from(revisions)
    .where(and(eq(revisions.storeId, storeId), inArray(revisions.id, parents)))
  const known = new Set(found.map((row) => row.id))
  return parents.filter((parent) => !known.has(parent))
}

/** Returns the referenced blob ids that have no row in this store. */
async function checkBlobs(
  db: Database,
  storeId: StoreId,
  referenced: BlobRef[],
): Promise<BlobId[]> {
  const found = await db
    .select({ id: blobs.id, size: blobs.size })
    .from(blobs)
    .where(
      and(
        eq(blobs.storeId, storeId),
        inArray(
          blobs.id,
          referenced.map((blob) => blob.id),
        ),
      ),
    )
  const byId = new Map(found.map((row) => [row.id, row.size]))
  const missing: BlobId[] = []
  for (const blob of referenced) {
    const storedSize = byId.get(blob.id)
    if (storedSize === undefined) {
      missing.push(blob.id)
      continue
    }
    if (storedSize !== blob.size) {
      throw badRequest('declared size does not match the registered blob', {
        blobId: blob.id,
        declaredSize: blob.size,
        storedSize,
      })
    }
  }
  return missing
}

async function storeRevision(
  deps: RouteDeps,
  input: {
    storeId: StoreId
    store: StoreRow
    deviceId: DeviceId
    request: CommitRequest
    referenced: BlobRef[]
  },
): Promise<boolean> {
  try {
    return await deps.db.transaction(async (tx) => {
      // Quota is enforced against committed blobs here, where the insert can
      // no longer race a concurrent presign that never uploaded anything.
      const fresh = await uncommittedRefs(tx, input.storeId, input.referenced)
      await assertWithinQuota(tx, input.storeId, limitsFor(deps.env, input.store), {
        bytes: fresh.reduce((total, blob) => total + blob.size, 0),
        blobs: fresh.length,
      })
      const inserted = await tx
        .insert(revisions)
        .values({
          id: input.request.revision.id,
          storeId: input.storeId,
          deviceId: input.deviceId,
          parents: input.request.revision.parents,
          manifestBlobId: input.request.revision.manifest.id,
          manifestSize: input.request.revision.manifest.size,
          note: input.request.note ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: revisions.id })
      if (inserted.length === 0) return false
      await tx.insert(revisionBlobs).values(
        input.referenced.map((blob) => ({
          revisionId: input.request.revision.id,
          storeId: input.storeId,
          blobId: blob.id,
          size: blob.size,
        })),
      )
      return true
    })
  } catch (error) {
    if (!isUniqueViolation(error)) throw error
    return false
  }
}

/** Refs no committed revision references yet; only those add usage. */
async function uncommittedRefs(
  db: Pick<Database, 'select' | 'selectDistinct'>,
  storeId: StoreId,
  referenced: BlobRef[],
): Promise<BlobRef[]> {
  if (referenced.length === 0) return []
  const rows = await db
    .selectDistinct({ id: revisionBlobs.blobId })
    .from(revisionBlobs)
    .where(
      and(
        eq(revisionBlobs.storeId, storeId),
        inArray(
          revisionBlobs.blobId,
          referenced.map((blob) => blob.id),
        ),
      ),
    )
  const committed = new Set(rows.map((row) => row.id))
  return referenced.filter((blob) => !committed.has(blob.id))
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false
  return (error as { code: unknown }).code === '23505'
}

export function toRevisionSummary(row: RevisionRow): RevisionSummary {
  return RevisionSummarySchema.parse({
    id: asRevisionId(row.id),
    storeId: asStoreId(row.storeId),
    deviceId: asDeviceId(row.deviceId),
    parents: row.parents.map((parent) => asRevisionId(parent)),
    manifest: { id: asBlobId(row.manifestBlobId), size: row.manifestSize },
    createdAt: row.createdAt.toISOString(),
  })
}

function readLimit(raw: string | undefined): number {
  if (!raw) return DEFAULT_LIMIT
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) throw badRequest('limit must be a positive integer')
  return Math.min(value, MAX_LIMIT)
}
