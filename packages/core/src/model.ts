import type { BlobId, BlobRef, DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import type { HarnessId, SyncPolicy } from './types'

/** Permission bits a synced file may carry; setuid, setgid, and sticky stay out of manifests. */
export const PERMISSION_MASK = 0o777
export const DEFAULT_FILE_MODE = 0o644
export const DEFAULT_DIRECTORY_MODE = 0o755

/** A single tracked path inside a surface. `hash` is over the plaintext projection. */
export interface ManifestEntry {
  surfaceId: SurfaceId
  path: string
  kind: 'file' | 'tombstone'
  /**
   * The effective per-file policy the scan applied, after tree `filePolicy` overrides.
   * The engine filters on this rather than the surface policy, so a sync override inside
   * a `never` tree (Codex profile files) still travels.
   */
  policy: SyncPolicy
  hash: string
  size: number
  mode: number
  /** Ciphertext blob holding the content. Absent on tombstones and unpushed entries. */
  blob?: BlobRef
}

export interface Manifest {
  revisionId: RevisionId
  deviceId: DeviceId
  createdAt: string
  entries: ManifestEntry[]
}

export interface SurfaceDigest {
  surfaceId: SurfaceId
  files: number
  bytes: number
}

export interface RevisionMeta {
  id: RevisionId
  parents: RevisionId[]
  deviceId: DeviceId
  createdAt: string
  manifest: { id: BlobId; size: number }
  digest: SurfaceDigest[]
}

/** How a device materializes a surface path: a real file, or a symlink to a target. */
export interface LayoutEntry {
  path: string
  mode: 'direct' | 'symlink'
  linkTarget?: string
}

export interface LocalLayout {
  deviceId: DeviceId
  entries: LayoutEntry[]
}

export interface MarkerRange {
  path: string
  startLine: number
  endLine: number
  contentHash: string
}

/** 1-based line ranges, end exclusive. An empty range is an insertion point. */
export interface ConflictRegion {
  baseRange: [number, number]
  localRange: [number, number]
  remoteRange: [number, number]
}

/**
 * How faithfully a merge kept the input's comments, key order, and whitespace.
 * `reserialized` means comments may be gone; callers that must not lose them
 * should treat the merge as conflicted and write a conflict copy instead.
 */
export interface FormatReport {
  preserved: boolean
  mode: 'verbatim' | 'patched' | 'reserialized'
  reason?: string
}

export interface MergeResult {
  /**
   * `unchanged` means the merged content equals the local working copy, so the
   * caller has nothing to write. `clean` means remote changes were applied.
   */
  status: 'clean' | 'conflicted' | 'unchanged'
  content: string
  conflicts: ConflictRegion[]
  format?: FormatReport
}

export interface ConflictArtifact {
  path: string
  content: string
  device: string
  createdAt: string
}

export interface SyncReport {
  revisionId: RevisionId | null
  changed: string[]
  conflicts: ConflictArtifact[]
  blocked: string[]
  deferred: string[]
  uploaded: number
  downloaded: number
}

export interface HarnessPolicy {
  enabled: boolean
  surfaces: Record<string, 'on' | 'off'>
}

export interface DevicePolicy {
  version: 1
  harnesses: Partial<Record<HarnessId, HarnessPolicy>>
  ignore: string[]
  /**
   * Commit a missing surface root, and an ignored path that is gone from this
   * device, as a deletion instead of carrying the entries forward. Off by
   * default so absence alone never erases another device's copy.
   */
  prune: boolean
  cadence: {
    watch: boolean
    intervalSeconds: number
  }
}

export function defaultPolicy(): DevicePolicy {
  return {
    version: 1,
    harnesses: {},
    ignore: [],
    prune: false,
    cadence: { watch: true, intervalSeconds: 300 },
  }
}
