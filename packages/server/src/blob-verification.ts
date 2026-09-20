import type { BlobId, BlobRef, StoreId } from '@laurencio/protocol'
import { and, eq, inArray } from 'drizzle-orm'
import type { RouteDeps } from './context'
import { blobs } from './db/schema'
import { badRequest } from './http/errors'
import { asBlobId } from './ids'
import { blobKey } from './storage/types'

/** HEAD requests per verification run, bounded so one request cannot fan out unbounded. */
const VERIFY_CONCURRENCY = 32

type BlobVerificationDeps = Pick<RouteDeps, 'db' | 'storage'>

/**
 * Verifies that registered blob rows have matching objects in storage. A blob is
 * marked verified only after both its size and ciphertext hash match.
 */
export async function verifyStoredObjects(
  deps: BlobVerificationDeps,
  storeId: StoreId,
  referenced: readonly BlobRef[],
): Promise<BlobId[]> {
  if (referenced.length === 0) return []
  const rows = await deps.db
    .select({ id: blobs.id, size: blobs.size, verifiedAt: blobs.verifiedAt })
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
  const registered = new Set(rows.map((row) => row.id))
  const missing = referenced.filter((blob) => !registered.has(blob.id)).map((blob) => blob.id)
  const toCheck = rows.filter((row) => row.verifiedAt === null)
  for (let index = 0; index < toCheck.length; index += VERIFY_CONCURRENCY) {
    const chunk = toCheck.slice(index, index + VERIFY_CONCURRENCY)
    const results = await Promise.all(
      chunk.map(async (row) => ({
        row,
        head: await deps.storage.head(blobKey(storeId, asBlobId(row.id))),
      })),
    )
    for (const { row, head } of results) {
      if (!head) {
        missing.push(asBlobId(row.id))
        continue
      }
      if (head.size !== row.size) {
        throw badRequest('stored object size does not match the registered blob', {
          blobId: row.id,
          storedSize: head.size,
          registeredSize: row.size,
        })
      }
      if (head.sha256 === null) {
        throw badRequest('stored object has no checksum to verify against', {
          blobId: row.id,
          reason: 'blob_checksum_missing',
        })
      }
      if (head.sha256 !== row.id) {
        throw badRequest('stored object checksum does not match the registered blob', {
          blobId: row.id,
          reason: 'blob_checksum_mismatch',
          expected: row.id,
          stored: head.sha256,
        })
      }
      await deps.db
        .update(blobs)
        .set({ verifiedAt: new Date() })
        .where(and(eq(blobs.storeId, storeId), eq(blobs.id, row.id)))
    }
  }
  return missing
}

/** Refuses to publish an opaque head until its uploaded object is verified. */
export async function requireStoredObject(
  deps: BlobVerificationDeps,
  storeId: StoreId,
  blob: BlobRef,
  kind: 'profile' | 'vault',
): Promise<void> {
  const missing = await verifyStoredObjects(deps, storeId, [blob])
  if (missing.length > 0) {
    throw badRequest(`${kind} blob is not present in storage`, { blobId: blob.id })
  }
}
