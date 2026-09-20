import {
  BlobId,
  PROTOCOL_VERSION,
  PresignRequest,
  PresignResponse,
  StoreId,
} from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requirePrincipal } from '../context'
import { blobs } from '../db/schema'
import { requireStore } from '../devices'
import { badRequest, conflict, notFound } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { requireCompatibleProfileWrite } from '../profile-version'
import { assertWithinQuota, limitsFor } from '../quota'
import { enforceRateLimit } from '../rate'
import type { FsBlobStore } from '../storage'
import { blobKey, sha256Hex } from '../storage/types'

/** Short-lived links: the client uploads or downloads immediately. */
export const PRESIGN_TTL_SECONDS = 10 * 60

export function createBlobRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.post('/v1/stores/:id/blobs/presign', async (c) => {
    const principal = requirePrincipal(c)
    enforceRateLimit(deps.rateLimiter, `presign:${rateLimitKey(principal)}`)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const store = await requireStore(deps.db, principal.userId, storeId)
    requireCompatibleProfileWrite(store, c.req.raw.headers)
    const body = PresignRequest.safeParse(await readJson(c))
    if (!body.success)
      throw badRequest('blob id and size are required', { issues: body.error.issues })
    const { id: blobId, size } = body.data.blob
    if (size > deps.env.quota.maxBlobBytes) {
      throw badRequest('blob exceeds the per-object size limit', {
        maxBlobBytes: deps.env.quota.maxBlobBytes,
        size,
      })
    }

    const existingRows = await deps.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.storeId, storeId), eq(blobs.id, blobId)))
      .limit(1)
    const existing = existingRows.at(0)
    if (existing && existing.size !== size) {
      throw conflict('blob id is already registered with a different size', {
        blobId,
        storedSize: existing.size,
        declaredSize: size,
      })
    }
    if (!existing) {
      // Optimistic only: the row is a storage registry for GC and size checks,
      // not a quota reservation, so an abandoned upload never consumes quota.
      await assertWithinQuota(deps.db, storeId, limitsFor(deps.env, store), {
        bytes: size,
        blobs: 1,
      })
      await deps.db.insert(blobs).values({ id: blobId, storeId, size }).onConflictDoNothing()
    }

    const upload = await deps.storage.presignPut({
      key: blobKey(storeId, blobId),
      size,
      // Blob ids are the sha256 of the ciphertext; uploads must prove it.
      sha256: blobId,
      expiresInSeconds: PRESIGN_TTL_SECONDS,
    })
    const response = PresignResponse.parse({
      url: upload.url,
      method: 'PUT',
      expiresAt: upload.expiresAt.toISOString(),
      headers: upload.headers,
      blobId,
    })
    return c.json(response)
  })

  app.get('/v1/stores/:id/blobs/:blobId', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const blobId = parseParam(BlobId, c.req.param('blobId'), 'blob id')
    await requireStore(deps.db, principal.userId, storeId)
    const rows = await deps.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.storeId, storeId), eq(blobs.id, blobId)))
      .limit(1)
    const row = rows.at(0)
    if (!row) throw notFound('unknown blob in this store')
    const download = await deps.storage.presignGet({
      key: blobKey(storeId, blobId),
      expiresInSeconds: PRESIGN_TTL_SECONDS,
    })
    return c.json({
      protocolVersion: PROTOCOL_VERSION,
      blobId,
      size: row.size,
      url: download.url,
      expiresAt: download.expiresAt.toISOString(),
    })
  })

  return app
}

/**
 * Local stand-in for a bucket: the URLs the filesystem store hands out point
 * back here, with the same signature and expiry rules.
 */
export function createLocalBlobRoutes(
  storage: FsBlobStore,
  maxBlobBytes: number,
): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.put('/local-blob/put', async (c) => {
    const query = localQuery(c.req.query('key'), c.req.query('expires'), c.req.query('sig'))
    const sha256 = c.req.query('sha256')
    if (!query || !sha256) throw badRequest('key, expires, sig, and sha256 are required')
    const verdict = storage.verifyPut({ ...query, sha256 })
    if (!verdict.ok) throw badRequest(verdict.reason)
    const declared = Number(c.req.query('size'))
    if (!Number.isInteger(declared) || declared < 0 || declared > maxBlobBytes) {
      throw badRequest('declared size is missing or out of range')
    }
    const body = new Uint8Array(await c.req.arrayBuffer())
    if (body.byteLength !== declared) {
      throw badRequest('uploaded size does not match the presigned size', {
        declared,
        received: body.byteLength,
      })
    }
    const actual = sha256Hex(body)
    if (actual !== sha256) {
      throw badRequest('uploaded bytes do not match the presigned checksum', {
        reason: 'blob_checksum_mismatch',
        expected: sha256,
        received: actual,
      })
    }
    await storage.localPut(query.key, body, sha256)
    return c.body(null, 200)
  })

  app.get('/local-blob/get', async (c) => {
    const query = localQuery(c.req.query('key'), c.req.query('expires'), c.req.query('sig'))
    if (!query) throw badRequest('key, expires, and sig are required')
    const verdict = storage.verifyGet(query)
    if (!verdict.ok) throw badRequest(verdict.reason)
    const bytes = await storage.localGet(query.key)
    if (!bytes) throw notFound('unknown object')
    return new Response(bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    })
  })

  return app
}

function localQuery(
  key: string | undefined,
  expires: string | undefined,
  sig: string | undefined,
): { key: string; expires: number; sig: string } | null {
  if (!key || !expires || !sig) return null
  const parsed = Number(expires)
  if (!Number.isFinite(parsed)) return null
  return { key, expires: parsed, sig }
}
