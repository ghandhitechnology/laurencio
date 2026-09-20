import type {
  BlobId,
  BlobRef,
  DeviceRecord,
  ProfileHead,
  ProfileHeadWriteRequest,
  RevisionId,
  RevisionSummary,
  VaultHead,
  VaultHeadWriteRequest,
} from '@laurencio/protocol'
import { BlobId as BlobIdSchema } from '@laurencio/protocol'
import type { KdfParams } from '../crypto/kdf'
import {
  DEFAULT_FILE_MODE,
  type Manifest,
  PERMISSION_MASK,
  type RevisionMeta,
  type SurfaceDigest,
} from '../model'

/** Bounds a decrypted manifest must respect before any entry is trusted. */
export const MAX_MANIFEST_ENTRIES = 50_000
export const MAX_MANIFEST_BYTES = 32 * 1024 * 1024
export const MAX_MANIFEST_ENTRY_BYTES = 64 * 1024 * 1024
export const MAX_STORE_PATH_LENGTH = 4096

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
  /**
   * Legacy plaintext note. Kept for persisted queue entries, but never populated
   * from user content and never sent on the wire.
   */
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

/** The store's public KDF parameters together with their generation counter. */
export interface PublishedKdfParams {
  kdf: KdfParams
  /** Monotonic counter: the enrollment write is 1, every rotation adds one. */
  generation: number
}

export interface KdfParamsLookup {
  /** Resolve a superseded generation instead of the latest. */
  version?: number
}

export interface PublishKdfParamsInput {
  params: KdfParams
  /** ISO time the parameters were calibrated; defaults to the remote's clock. */
  calibratedAt?: string
  /**
   * Compare-and-set against the store generation the caller read before
   * rotating. A remote that supports the check refuses the write when the store
   * moved underneath it.
   */
  expectedGeneration?: number
}

/** The store rotated between the read and the write; re-read and re-plan. */
export class KdfGenerationConflictError extends Error {
  readonly expected: number
  readonly actual: number | null

  constructor(expected: number, actual: number | null) {
    const actualText = actual === null ? 'unknown' : String(actual)
    super(`store KDF generation changed: expected ${expected}, found ${actualText}`)
    this.name = 'KdfGenerationConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** The remote rejected the parameters themselves; `message` carries its reason. */
export class KdfValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KdfValidationError'
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
  getKdfParams(options?: KdfParamsLookup): Promise<PublishedKdfParams | null>
  /** Publishes new parameters; the latest generation is what new devices derive from. */
  putKdfParams(input: PublishKdfParamsInput): Promise<PublishedKdfParams>
  listRevisions(options?: RemoteListOptions): Promise<RemoteRevisionList>
  /** Framed ciphertext of the revision's manifest blob. */
  getManifest(revisionId: RevisionId): Promise<Uint8Array>
  putBlob(blob: BlobUpload): Promise<BlobRef>
  getBlob(blobId: BlobId): Promise<Uint8Array>
  commit(commit: RemoteCommit): Promise<RemoteCommitResult>
  listDevices(): Promise<DeviceRecord[]>
}

/** Optional encrypted-vault capability implemented by v2 profile remotes. */
export interface VaultRemote {
  getVaultHead(): Promise<VaultHead | null>
  putVaultHead(input: VaultHeadWriteRequest): Promise<VaultHead>
}

export class VaultGenerationConflictError extends Error {
  readonly expected: number | null
  readonly actual: number | null

  constructor(expected: number | null, actual: number | null) {
    super(`vault generation changed: expected ${expected ?? 'new'}, found ${actual ?? 'missing'}`)
    this.name = 'VaultGenerationConflictError'
    this.expected = expected
    this.actual = actual
  }
}

export function supportsVault(remote: Remote): remote is Remote & VaultRemote {
  const candidate = remote as Partial<VaultRemote>
  return (
    typeof candidate.getVaultHead === 'function' && typeof candidate.putVaultHead === 'function'
  )
}

/** Optional encrypted-profile capability implemented by v2 profile remotes. */
export interface ProfileRemote {
  getProfileHead(): Promise<ProfileHead | null>
  putProfileHead(input: ProfileHeadWriteRequest): Promise<ProfileHead>
}

export class ProfileGenerationConflictError extends Error {
  readonly expected: number | null
  readonly actual: number | null

  constructor(expected: number | null, actual: number | null) {
    super(`profile generation changed: expected ${expected ?? 'new'}, found ${actual ?? 'missing'}`)
    this.name = 'ProfileGenerationConflictError'
    this.expected = expected
    this.actual = actual
  }
}

export function supportsProfile(remote: Remote): remote is Remote & ProfileRemote {
  const candidate = remote as Partial<ProfileRemote>
  return (
    typeof candidate.getProfileHead === 'function' && typeof candidate.putProfileHead === 'function'
  )
}

export type ManifestErrorCode =
  | 'invalid-manifest'
  | 'invalid-path'
  | 'invalid-mode'
  | 'entry-too-large'
  | 'too-many-entries'
  | 'manifest-too-large'

/** A manifest a peer supplied that is malformed, hostile, or over the size bounds. */
export class ManifestError extends Error {
  readonly code: ManifestErrorCode

  constructor(code: ManifestErrorCode, message: string) {
    super(message)
    this.name = 'ManifestError'
    this.code = code
  }
}

/**
 * Store paths are tokenized paths inside a surface (`$HOME/.claude/CLAUDE.md`).
 * A peer-supplied path must never leave that surface once the engine joins it to
 * a real directory, so traversal, absolutes, and foreign separators are refused.
 */
export function assertSafeStorePath(value: string): string {
  const reject = (reason: string): never => {
    throw new ManifestError(
      'invalid-path',
      `manifest entry path ${reason}: ${JSON.stringify(value)}`,
    )
  }
  if (value === '') reject('is empty')
  if (value.length > MAX_STORE_PATH_LENGTH) {
    reject(`is longer than ${MAX_STORE_PATH_LENGTH} characters`)
  }
  if (value.includes('\u0000')) reject('contains a null byte')
  if (value.includes('\\')) reject('contains a backslash')
  if (value.startsWith('/')) reject('is absolute')
  if (/^[A-Za-z]:/.test(value)) reject('is absolute')
  for (const segment of value.split('/')) {
    if (segment === '') reject('has an empty segment')
    if (segment === '.' || segment === '..') reject(`has a ${segment} segment`)
  }
  return value
}

function parseEntrySize(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ManifestError(
      'invalid-manifest',
      `manifest entry ${what} must be a non-negative integer`,
    )
  }
  if (value > MAX_MANIFEST_ENTRY_BYTES) {
    throw new ManifestError(
      'entry-too-large',
      `manifest entry ${what} is ${value} bytes, over the ${MAX_MANIFEST_ENTRY_BYTES} byte limit`,
    )
  }
  return value
}

function parseMode(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ManifestError('invalid-mode', 'manifest entry mode must be a non-negative integer')
  }
  if ((value & ~PERMISSION_MASK) !== 0) {
    throw new ManifestError(
      'invalid-mode',
      `manifest entry mode 0o${value.toString(8)} carries setuid, setgid, sticky, or file-type bits`,
    )
  }
  return value
}

/**
 * Parses a decrypted manifest blob, rejecting anything that is not a manifest.
 * `byteLength` is the decrypted size when the caller has it, so an oversized
 * blob fails before its entries are walked.
 */
export function parseManifest(value: unknown, byteLength?: number): Manifest {
  if (byteLength !== undefined && byteLength > MAX_MANIFEST_BYTES) {
    throw new ManifestError(
      'manifest-too-large',
      `manifest is ${byteLength} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`,
    )
  }
  if (typeof value !== 'object' || value === null) {
    throw new ManifestError('invalid-manifest', 'manifest must be an object')
  }
  const record = value as Record<string, unknown>
  if (typeof record.revisionId !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest revisionId is missing')
  }
  if (typeof record.deviceId !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest deviceId is missing')
  }
  if (typeof record.createdAt !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest createdAt is missing')
  }
  if (!Array.isArray(record.entries)) {
    throw new ManifestError('invalid-manifest', 'manifest entries must be an array')
  }
  if (record.entries.length > MAX_MANIFEST_ENTRIES) {
    throw new ManifestError(
      'too-many-entries',
      `manifest holds ${record.entries.length} entries, over the ${MAX_MANIFEST_ENTRIES} entry limit`,
    )
  }
  const entries = record.entries.map((entry) => parseManifestEntry(entry))
  return {
    revisionId: record.revisionId as Manifest['revisionId'],
    deviceId: record.deviceId as Manifest['deviceId'],
    createdAt: record.createdAt,
    entries,
  }
}

function parseManifestEntry(value: unknown): Manifest['entries'][number] {
  if (typeof value !== 'object' || value === null) {
    throw new ManifestError('invalid-manifest', 'manifest entry is malformed')
  }
  const record = value as Record<string, unknown>
  if (typeof record.surfaceId !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest entry surfaceId is missing')
  }
  if (typeof record.path !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest entry path is missing')
  }
  const kind = record.kind === 'tombstone' ? 'tombstone' : 'file'
  // Older manifests carry no policy; anything that reached a manifest was syncable then.
  const policy = record.policy === 'opt-in' ? 'opt-in' : 'sync'
  if (typeof record.hash !== 'string') {
    throw new ManifestError('invalid-manifest', 'manifest entry hash is missing')
  }
  const entry: Manifest['entries'][number] = {
    surfaceId: record.surfaceId as Manifest['entries'][number]['surfaceId'],
    path: assertSafeStorePath(record.path),
    kind,
    policy,
    hash: record.hash,
    size: parseEntrySize(record.size, 'size'),
    mode: parseMode(record.mode, kind === 'tombstone' ? 0 : DEFAULT_FILE_MODE),
  }
  if (typeof record.blob === 'object' && record.blob !== null) {
    const blob = record.blob as Record<string, unknown>
    if (typeof blob.id === 'string') {
      const id = BlobIdSchema.safeParse(blob.id)
      if (!id.success) {
        throw new ManifestError('invalid-manifest', `manifest entry blob id is invalid: ${blob.id}`)
      }
      entry.blob = { id: id.data, size: parseEntrySize(blob.size, 'blob size') }
    }
  }
  return entry
}
