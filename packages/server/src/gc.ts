import type { StoreId } from '@laurencio/protocol'
import { and, eq, isNull, lt } from 'drizzle-orm'
import type { Database } from './db/client'
import { openDatabase } from './db/client'
import { blobs, revisionBlobs } from './db/schema'
import { loadEnv } from './env'
import { asBlobId, asStoreId } from './ids'
import { createBlobStore } from './storage'
import type { BlobStore } from './storage/types'
import { blobKey } from './storage/types'

export interface GcReport {
  scanned: number
  deleted: number
  bytesFreed: number
  kept: number
}

export interface GcOptions {
  db: Database
  storage: BlobStore
  /** Restrict the sweep to one store; all stores when omitted. */
  storeId?: StoreId
  graceSeconds: number
  dryRun?: boolean
  now?: Date
}

/**
 * Deletes blobs that no committed revision references and that are older than
 * the grace period. A blob uploaded for a commit that never arrived is the
 * normal case, so the grace period has to outlast a slow upload.
 */
export async function collectOrphans(options: GcOptions): Promise<GcReport> {
  const now = options.now ?? new Date()
  const cutoff = new Date(now.getTime() - options.graceSeconds * 1000)
  const scope = options.storeId ? eq(blobs.storeId, options.storeId) : undefined

  const scannedRows = await options.db.select({ total: blobs.id }).from(blobs).where(scope)
  const scanned = scannedRows.length

  const candidates = await options.db
    .select({ id: blobs.id, storeId: blobs.storeId, size: blobs.size })
    .from(blobs)
    .leftJoin(
      revisionBlobs,
      and(eq(revisionBlobs.storeId, blobs.storeId), eq(revisionBlobs.blobId, blobs.id)),
    )
    .where(and(scope, isNull(revisionBlobs.revisionId), lt(blobs.createdAt, cutoff)))

  let deleted = 0
  let bytesFreed = 0
  for (const candidate of candidates) {
    if (options.dryRun) {
      deleted += 1
      bytesFreed += candidate.size
      continue
    }
    await options.storage.delete(blobKey(asStoreId(candidate.storeId), asBlobId(candidate.id)))
    await options.db
      .delete(blobs)
      .where(and(eq(blobs.storeId, candidate.storeId), eq(blobs.id, candidate.id)))
    deleted += 1
    bytesFreed += candidate.size
  }

  return { scanned, deleted, bytesFreed, kept: scanned - deleted }
}

function parseArgs(argv: string[]): {
  dryRun: boolean
  graceSeconds: number | null
  storeId: string | null
} {
  let dryRun = false
  let graceSeconds: number | null = null
  let storeId: string | null = null
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--grace-seconds='))
      graceSeconds = Number(arg.slice('--grace-seconds='.length))
    else if (arg.startsWith('--store=')) storeId = arg.slice('--store='.length)
    else throw new Error(`unknown argument ${arg}`)
  }
  return { dryRun, graceSeconds, storeId }
}

if (import.meta.main) {
  try {
    const env = loadEnv()
    const args = parseArgs(process.argv.slice(2))
    const handle = openDatabase(env)
    const storage = createBlobStore(env)
    try {
      const report = await collectOrphans({
        db: handle.db,
        storage,
        graceSeconds: args.graceSeconds ?? env.gc.graceSeconds,
        dryRun: args.dryRun,
        ...(args.storeId ? { storeId: asStoreId(args.storeId) } : {}),
      })
      process.stdout.write(
        `${JSON.stringify({ level: 'info', msg: 'gc sweep complete', dryRun: args.dryRun, ...report })}\n`,
      )
    } finally {
      await handle.close()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${JSON.stringify({ level: 'error', msg: 'gc sweep failed', message })}\n`)
    process.exit(1)
  }
}
