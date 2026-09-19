import type { StoreId } from '@laurencio/protocol'
import { count, eq, sum } from 'drizzle-orm'
import type { Database } from './db/client'
import { blobs } from './db/schema'
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

export function limitsFor(env: ServerEnv, store: StoreRow): QuotaLimits {
  return {
    maxBytes: store.maxBytes ?? env.quota.maxBytes,
    maxBlobs: store.maxBlobs ?? env.quota.maxBlobs,
  }
}

export async function usageFor(db: Database, storeId: StoreId): Promise<QuotaUsage> {
  const rows = await db
    .select({ blobs: count(), bytes: sum(blobs.size) })
    .from(blobs)
    .where(eq(blobs.storeId, storeId))
  const row = rows.at(0)
  const bytes = row?.bytes ? Number(row.bytes) : 0
  return { blobs: Number(row?.blobs ?? 0), bytes: Number.isFinite(bytes) ? bytes : 0 }
}

/** Throws the typed quota error the client surfaces when the store is full. */
export async function assertWithinQuota(
  db: Database,
  storeId: StoreId,
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
