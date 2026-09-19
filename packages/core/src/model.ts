import type { BlobId, DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import type { HarnessId, Platform } from './types'

/** A single tracked path inside a surface. `hash` is over the plaintext projection. */
export interface ManifestEntry {
  surfaceId: SurfaceId
  path: string
  kind: 'file' | 'tombstone'
  hash: string
  size: number
  mode: number
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
    cadence: { watch: true, intervalSeconds: 300 },
  }
}

export interface DeviceIdentity {
  id: DeviceId
  name: string
  platform: Platform
  createdAt: string
}
