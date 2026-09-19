/**
 * The offline queue. Ops live in `state.db` (`pending_ops`) and drain in
 * creation order once the server is reachable again. Replay is idempotent by
 * construction: blobs are stored under the hash of their ciphertext and
 * revisions are commits under a client-generated id, so re-sending either is a
 * no-op. `sync` and `retry` entries are markers the engine leaves behind for
 * deferred work; a successful sync pass covers them and clears them.
 */

import type { BlobRef, RevisionId } from '@laurencio/protocol'
import { BlobId, DeviceId, RevisionId as RevisionIdSchema, StoreId } from '@laurencio/protocol'
import type { SurfaceDigest } from '../model'
import { isOfflineError } from '../remote/http'
import type { Remote, RemoteCommit } from '../remote/types'
import { RemoteError } from '../remote/types'
import type { PendingOp, SyncState } from '../state'

export const QUEUE_SYNC_KIND = 'sync'
export const QUEUE_RETRY_KIND = 'retry'
export const QUEUE_UPLOAD_KIND = 'upload'
export const QUEUE_COMMIT_KIND = 'commit'

export type QueueEntry =
  | { opId: string; kind: 'sync'; reason: string; createdAt: string }
  | { opId: string; kind: 'retry'; storePath: string; reason: string; createdAt: string }
  | { opId: string; kind: 'upload'; blob: BlobRef; bytes: Uint8Array; createdAt: string }
  | { opId: string; kind: 'commit'; commit: RemoteCommit; createdAt: string }
  | { opId: string; kind: 'unknown'; raw: string; createdAt: string }

export interface QueueFailure {
  opId: string
  kind: string
  reason: string
}

export interface QueueDrainReport {
  /** Ops delivered and removed. */
  replayed: string[]
  /** Ops the server rejected for a reason a retry cannot fix, removed with a reason. */
  failed: QueueFailure[]
  /** Ops still waiting, including the markers a sync pass has to cover. */
  pending: number
  /** True when a transport failure stopped the drain; the current op is kept. */
  offline: boolean
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseReason(payload: string): string {
  const record = asRecord(parseJson(payload))
  if (record !== null && typeof record.reason === 'string') return record.reason
  return payload
}

function parseBlobRef(value: unknown): BlobRef | null {
  const record = asRecord(value)
  if (record === null) return null
  const id = BlobId.safeParse(record.id)
  if (!id.success) return null
  if (typeof record.size !== 'number' || !Number.isInteger(record.size) || record.size < 0) {
    return null
  }
  return { id: id.data, size: record.size }
}

function parseCommit(payload: string): RemoteCommit | null {
  const record = asRecord(parseJson(payload))
  if (record === null) return null
  const revision = asRecord(record.revision)
  if (revision === null) return null
  const id = RevisionIdSchema.safeParse(revision.id)
  const store = StoreId.safeParse(revision.storeId)
  const device = DeviceId.safeParse(revision.deviceId)
  if (!id.success || !store.success || !device.success) return null
  if (typeof revision.createdAt !== 'string') return null
  if (!Array.isArray(revision.parents)) return null
  const manifest = parseBlobRef(revision.manifest)
  if (manifest === null) return null
  const blobs: BlobRef[] = []
  if (Array.isArray(record.blobs)) {
    for (const item of record.blobs) {
      const blob = parseBlobRef(item)
      if (blob !== null) blobs.push(blob)
    }
  }
  const commit: RemoteCommit = {
    revision: {
      id: id.data,
      storeId: store.data,
      deviceId: device.data,
      parents: revision.parents.filter(
        (parent): parent is RevisionId => typeof parent === 'string',
      ),
      manifest,
      createdAt: revision.createdAt,
    },
    blobs,
    digest: parseDigest(record.digest),
  }
  return commit
}

function parseDigest(value: unknown): SurfaceDigest[] {
  if (!Array.isArray(value)) return []
  const digest: SurfaceDigest[] = []
  for (const item of value) {
    const record = asRecord(item)
    if (
      record === null ||
      typeof record.surfaceId !== 'string' ||
      typeof record.files !== 'number' ||
      typeof record.bytes !== 'number'
    ) {
      continue
    }
    digest.push({
      surfaceId: record.surfaceId as SurfaceDigest['surfaceId'],
      files: record.files,
      bytes: record.bytes,
    })
  }
  return digest
}

/** Boundary parser for rows this module wrote, tolerating unknown kinds. */
export function parseQueueEntry(op: PendingOp): QueueEntry {
  switch (op.kind) {
    case QUEUE_SYNC_KIND:
      return {
        opId: op.opId,
        kind: 'sync',
        reason: parseReason(op.payload),
        createdAt: op.createdAt,
      }
    case QUEUE_RETRY_KIND: {
      const record = asRecord(parseJson(op.payload))
      const storePath =
        record !== null && typeof record.storePath === 'string' ? record.storePath : ''
      return {
        opId: op.opId,
        kind: 'retry',
        storePath,
        reason: parseReason(op.payload),
        createdAt: op.createdAt,
      }
    }
    case QUEUE_UPLOAD_KIND: {
      const record = asRecord(parseJson(op.payload))
      const blob = record === null ? null : parseBlobRef({ id: record.blobId, size: record.size })
      const base64 = record !== null && typeof record.base64 === 'string' ? record.base64 : ''
      if (blob === null || base64 === '') {
        return { opId: op.opId, kind: 'unknown', raw: op.payload, createdAt: op.createdAt }
      }
      return {
        opId: op.opId,
        kind: 'upload',
        blob,
        bytes: new Uint8Array(Buffer.from(base64, 'base64')),
        createdAt: op.createdAt,
      }
    }
    case QUEUE_COMMIT_KIND: {
      const commit = parseCommit(op.payload)
      if (commit === null) {
        return { opId: op.opId, kind: 'unknown', raw: op.payload, createdAt: op.createdAt }
      }
      return { opId: op.opId, kind: 'commit', commit, createdAt: op.createdAt }
    }
    default:
      return { opId: op.opId, kind: 'unknown', raw: op.payload, createdAt: op.createdAt }
  }
}

export function listQueue(state: SyncState): QueueEntry[] {
  return state.listPendingOps().map(parseQueueEntry)
}

export interface EnqueueOptions {
  createdAt?: string
}

export function enqueueSync(
  state: SyncState,
  reason: string,
  options: EnqueueOptions = {},
): string {
  return state.enqueueOp({
    kind: QUEUE_SYNC_KIND,
    payload: JSON.stringify({ reason }),
    createdAt: options.createdAt ?? new Date().toISOString(),
  })
}

export function enqueueUpload(
  state: SyncState,
  blob: BlobRef,
  bytes: Uint8Array,
  options: EnqueueOptions = {},
): string {
  return state.enqueueOp({
    kind: QUEUE_UPLOAD_KIND,
    payload: JSON.stringify({
      blobId: blob.id,
      size: blob.size,
      base64: Buffer.from(bytes).toString('base64'),
    }),
    createdAt: options.createdAt ?? new Date().toISOString(),
  })
}

export function enqueueCommit(
  state: SyncState,
  commit: RemoteCommit,
  options: EnqueueOptions = {},
): string {
  return state.enqueueOp({
    kind: QUEUE_COMMIT_KIND,
    payload: JSON.stringify(commit),
    createdAt: options.createdAt ?? new Date().toISOString(),
  })
}

/** Drops the markers a successful sync pass has covered. Returns how many were removed. */
export function clearSyncMarkers(state: SyncState): number {
  let removed = 0
  for (const entry of listQueue(state)) {
    if (entry.kind === 'sync' || entry.kind === 'retry') {
      state.removePendingOp(entry.opId)
      removed += 1
    }
  }
  return removed
}

export interface QueueDrainOptions {
  state: SyncState
  remote: Remote
}

/**
 * Replays persisted uploads and commits. A transport failure stops the drain
 * and keeps the current op; a rejection that a retry cannot fix drops the op
 * with a reason, because the next full sync rebuilds the same content-addressed
 * ids from local state.
 */
export async function drainQueue(options: QueueDrainOptions): Promise<QueueDrainReport> {
  const replayed: string[] = []
  const failed: QueueFailure[] = []
  let offline = false
  for (const op of options.state.listPendingOps()) {
    const entry = parseQueueEntry(op)
    if (entry.kind !== 'upload' && entry.kind !== 'commit') continue
    try {
      if (entry.kind === 'upload') {
        await options.remote.putBlob({ blobId: entry.blob.id, bytes: entry.bytes })
      } else {
        const result = await options.remote.commit(entry.commit)
        if (!result.accepted) {
          throw new RemoteError(
            'missing-blobs',
            `commit ${entry.commit.revision.id} is missing blobs: ${result.missing.join(', ')}`,
          )
        }
      }
      options.state.removePendingOp(entry.opId)
      replayed.push(entry.opId)
    } catch (error) {
      if (isOfflineError(error)) {
        offline = true
        break
      }
      options.state.removePendingOp(entry.opId)
      failed.push({ opId: entry.opId, kind: entry.kind, reason: reasonFor(error) })
    }
  }
  return {
    replayed,
    failed,
    pending: options.state.listPendingOps().length,
    offline,
  }
}
