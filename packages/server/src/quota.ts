import { and, count, eq, inArray, sum } from 'drizzle-orm'
import type { Database } from './db/client'
import { blobs, revisionBlobs } from './db/schema'
import type { StoreRow } from './devices'
import type { ServerEnv } from './env'
import { quotaExceeded } from './http/errors'

export interface QuotaLimits {
  maxBytes: number
  maxBlobs: number
}

export interface QuotaUsage {
  bytes: number
  blobs: number
}

/** Accepts a transaction as well as the pool so commit-time checks stay atomic. */
type QuotaReader = Pick<Database, 'select'>

export function limitsFor(env: ServerEnv, store: StoreRow): QuotaLimits {
  return {
    maxBytes: store.maxBytes ?? env.quota.maxBytes,
    maxBlobs: store.maxBlobs ?? env.quota.maxBlobs,
  }
}

/**
 * Only blobs a committed revision references count. Presign registers a row so
 * GC and size checks can find the object, but an upload that never lands in a
 * commit must not consume quota.
 */
export async function usageFor(db: QuotaReader, storeId: string): Promise<QuotaUsage> {
  const committed = db
    .select({ id: revisionBlobs.blobId })
    .from(revisionBlobs)
    .where(eq(revisionBlobs.storeId, storeId))
  const rows = await db
    .select({ blobs: count(), bytes: sum(blobs.size) })
    .from(blobs)
    .where(and(eq(blobs.storeId, storeId), inArray(blobs.id, committed)))
  const row = rows.at(0)
  const bytes = row?.bytes ? Number(row.bytes) : 0
  return { blobs: Number(row?.blobs ?? 0), bytes: Number.isFinite(bytes) ? bytes : 0 }
}

/** Throws the typed quota error the client surfaces when the store is full. */
export async function assertWithinQuota(
  db: QuotaReader,
  storeId: string,
  limits: QuotaLimits,
  incoming: { bytes: number; blobs: number },
): Promise<void> {
  const usage = await usageFor(db, storeId)
  if (incoming.blobs > 0 && usage.blobs + incoming.blobs > limits.maxBlobs) {
    throw quotaExceeded('store object limit reached', {
      limit: 'blobs',
      maxBlobs: limits.maxBlobs,
      usedBlobs: usage.blobs,
      incomingBlobs: incoming.blobs,
    })
  }
  if (usage.bytes + incoming.bytes > limits.maxBytes) {
    throw quotaExceeded('store byte limit reached', {
      limit: 'bytes',
      maxBytes: limits.maxBytes,
      usedBytes: usage.bytes,
      incomingBytes: incoming.bytes,
    })
  }
}
