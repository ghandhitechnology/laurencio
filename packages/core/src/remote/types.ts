import type {
  BlobId,
  BlobRef,
  DeviceRecord,
  RevisionId,
  RevisionSummary,
} from '@laurencio/protocol'
import { BlobId as BlobIdSchema } from '@laurencio/protocol'
import type { KdfParams } from '../crypto/kdf'
import type { Manifest, RevisionMeta, SurfaceDigest } from '../model'

/** One content-addressed ciphertext blob, as uploaded. The remote never sees plaintext. */
export interface BlobUpload {
  blobId: BlobId
  bytes: Uint8Array
}

export interface RemoteCommit {
  revision: RevisionSummary
  /** Every content blob the manifest references. */
  blobs: BlobRef[]
  /** Per-surface file counts and bytes, carried alongside the opaque manifest. */
  digest: SurfaceDigest[]
  note?: string
}

export type RemoteCommitRejection = 'missing-blobs' | 'stale-parents'

export interface RemoteCommitResult {
  revisionId: RevisionId
  accepted: boolean
  missing: BlobId[]
  /** Why a commit was refused; absent when accepted. */
  reason?: RemoteCommitRejection
  /** Heads observed when a commit was refused for stale parents. */
  heads?: RevisionId[]
}

/** Raised when the remote head advanced between planning and committing. */
export class StaleParentsError extends Error {
  readonly heads: readonly RevisionId[]

  constructor(heads: readonly RevisionId[]) {
    super(`remote head advanced during commit; re-pull and merge (heads: ${heads.join(', ')})`)
    this.name = 'StaleParentsError'
    this.heads = heads
  }
}

export interface RemoteRevisionList {
  revisions: RevisionMeta[]
  /** Set only when the store has exactly one head; null when forked or empty. */
  head: RevisionId | null
  /** Revisions that are not a parent of any other revision, in commit order. */
  heads: RevisionId[]
}

export interface RemoteListOptions {
  /** Only revisions committed after this one, in creation order. */
  since?: RevisionId
  /** Return at most this many of the newest revisions. */
  limit?: number
}

export type RemoteErrorCode = 'not-found' | 'blob-mismatch' | 'missing-blobs' | 'corrupt-store'

export class RemoteError extends Error {
  readonly code: RemoteErrorCode

  constructor(code: RemoteErrorCode, message: string) {
    super(message)
    this.name = 'RemoteError'
    this.code = code
  }
}

/**
 * The transport contract. Phase 12 implements it over HTTP against the server;
 * {@link FileRemote} implements it over a directory for offline runs and tests.
 * Blobs are opaque: the caller seals and opens them, the remote only stores them
 * under their ciphertext hash.
 */
export interface Remote {
  /** Public KDF parameters for the store, or null before enrollment. */
  getKdfParams(): Promise<KdfParams | null>
  listRevisions(options?: RemoteListOptions): Promise<RemoteRevisionList>
  /** Framed ciphertext of the revision's manifest blob. */
  getManifest(revisionId: RevisionId): Promise<Uint8Array>
  putBlob(blob: BlobUpload): Promise<BlobRef>
  getBlob(blobId: BlobId): Promise<Uint8Array>
  commit(commit: RemoteCommit): Promise<RemoteCommitResult>
  listDevices(): Promise<DeviceRecord[]>
}

/** Parses a decrypted manifest blob, rejecting anything that is not a manifest. */
export function parseManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null) throw new Error('manifest must be an object')
  const record = value as Record<string, unknown>
  if (typeof record.revisionId !== 'string') throw new Error('manifest revisionId is missing')
  if (typeof record.deviceId !== 'string') throw new Error('manifest deviceId is missing')
  if (typeof record.createdAt !== 'string') throw new Error('manifest createdAt is missing')
  if (!Array.isArray(record.entries)) throw new Error('manifest entries must be an array')
  const entries = record.entries.map((entry) => parseManifestEntry(entry))
  return {
    revisionId: record.revisionId as Manifest['revisionId'],
    deviceId: record.deviceId as Manifest['deviceId'],
    createdAt: record.createdAt,
    entries,
  }
}

function parseManifestEntry(value: unknown): Manifest['entries'][number] {
  if (typeof value !== 'object' || value === null) throw new Error('manifest entry is malformed')
  const record = value as Record<string, unknown>
  if (typeof record.surfaceId !== 'string') throw new Error('manifest entry surfaceId is missing')
  if (typeof record.path !== 'string') throw new Error('manifest entry path is missing')
  const kind = record.kind === 'tombstone' ? 'tombstone' : 'file'
  if (typeof record.hash !== 'string') throw new Error('manifest entry hash is missing')
  if (typeof record.size !== 'number') throw new Error('manifest entry size is missing')
  if (typeof record.mode !== 'number') throw new Error('manifest entry mode is missing')
  const entry: Manifest['entries'][number] = {
    surfaceId: record.surfaceId as Manifest['entries'][number]['surfaceId'],
    path: record.path,
    kind,
    hash: record.hash,
    size: record.size,
    mode: record.mode,
  }
  if (typeof record.blob === 'object' && record.blob !== null) {
    const blob = record.blob as Record<string, unknown>
    if (typeof blob.id === 'string' && typeof blob.size === 'number') {
      entry.blob = { id: BlobIdSchema.parse(blob.id), size: blob.size }
    }
  }
  return entry
}
