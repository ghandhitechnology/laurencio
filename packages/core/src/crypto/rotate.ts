/**
 * Passphrase rotation.
 *
 * A passphrase change never reaches the server. Every blob is opened with the
 * old master key and re-sealed under a fresh Argon2id master key derived from
 * the new passphrase with a new salt, so blob ids all change. The new epoch and
 * the replaced blob ids are handed to the caller to commit as one revision;
 * the old blobs are unreferenced and become garbage for the server's GC.
 *
 * The epoch is deliberately not part of the envelope AAD: a blob must be
 * openable with the key alone, and the epoch is store metadata used to tell
 * generations apart.
 */

import type {
  BlobId,
  BlobRef,
  DeviceId,
  RevisionId,
  RevisionSummary,
  StoreId,
} from '@laurencio/protocol'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { Manifest, ManifestEntry, SurfaceDigest } from '../model'
import type { Remote } from '../remote/types'
import { StaleParentsError } from '../remote/types'
import type { SealedBlob } from './aead'
import { open, seal, sealText } from './aead'
import { createKdfParams, deriveMasterKey, type KdfParams, type KeyMaterial } from './kdf'

export interface KeyEpoch {
  /** Monotonic counter, starting at 1 for the enrollment key. */
  epoch: number
  kdf: KdfParams
  createdAt: string
}

export interface RotationInput {
  storeId: StoreId
  protocolVersion: number
  /** The key that sealed the current blobs. */
  master: KeyMaterial
  blobs: SealedBlob[]
  newPassphrase: string
  /** Epoch of the key being replaced. */
  epoch?: number
  /** Injectable calibration, for tests and for pinning parameters. */
  calibrate?: () => KdfParams
  now?: () => Date
}

export interface RotationStats {
  reEncrypted: number
  bytesBefore: number
  bytesAfter: number
}

export interface RotationResult {
  /** The new master key. The caller caches it and zeroizes it when done. */
  master: KeyMaterial
  epoch: KeyEpoch
  blobs: SealedBlob[]
  /** Blob ids that are no longer referenced after this rotation. */
  replaced: BlobId[]
  /** sha256 over the sorted new blob ids; the revision content digest. */
  digest: string
  stats: RotationStats
}

export function keyEpochFromParams(
  kdf: KdfParams,
  epoch = 1,
  now: () => Date = () => new Date(),
): KeyEpoch {
  return { epoch, kdf, createdAt: now().toISOString() }
}

export function rotationDigest(blobs: SealedBlob[]): string {
  const ids = blobs.map((blob) => blob.blobId).sort()
  return bytesToHex(sha256(utf8ToBytes(ids.join('\n'))))
}

export function rotatePassphrase(input: RotationInput): RotationResult {
  if (input.master.zeroized) throw new Error('cannot rotate with a zeroized master key')
  const now = input.now ?? (() => new Date())
  const kdf = (input.calibrate ?? (() => createKdfParams()))()
  const master = deriveMasterKey(input.newPassphrase, kdf)
  const context = {
    storeId: input.storeId,
    protocolVersion: input.protocolVersion,
  }
  const blobs: SealedBlob[] = []
  const replaced: BlobId[] = []
  let bytesBefore = 0
  let bytesAfter = 0
  try {
    for (const blob of input.blobs) {
      const plaintext = open(input.master, blob.namespace, blob.bytes, {
        ...context,
        blobType: blob.blobType,
      })
      try {
        const resealed = seal(master, blob.namespace, plaintext, {
          ...context,
          blobType: blob.blobType,
        })
        blobs.push(resealed)
        replaced.push(blob.blobId)
        bytesBefore += blob.bytes.length
        bytesAfter += resealed.bytes.length
      } finally {
        plaintext.fill(0)
      }
    }
  } catch (error) {
    master.zeroize()
    throw error
  }
  return {
    master,
    epoch: keyEpochFromParams(kdf, (input.epoch ?? 1) + 1, now),
    blobs,
    replaced,
    digest: rotationDigest(blobs),
    stats: { reEncrypted: blobs.length, bytesBefore, bytesAfter },
  }
}

/**
 * The revision metadata the caller commits after a rotation. Device id is not
 * needed to re-encrypt; it travels in the revision itself.
 */
export interface RotationCommitHint {
  deviceId: DeviceId
  parentEpoch: number
  replaced: BlobId[]
  digest: string
}

export function rotationCommitHint(result: RotationResult, deviceId: DeviceId): RotationCommitHint {
  return {
    deviceId,
    parentEpoch: result.epoch.epoch - 1,
    replaced: result.replaced,
    digest: result.digest,
  }
}

/** The head revision a store rotation starts from, already decrypted. */
export interface StoreHead {
  revisionId: RevisionId
  parents: RevisionId[]
  manifest: Manifest
}

export interface StoreRotationInput {
  remote: Remote
  storeId: StoreId
  protocolVersion: number
  deviceId: DeviceId
  /** The key that sealed the head revision. */
  master: KeyMaterial
  head: StoreHead
  newRevisionId: RevisionId
  newPassphrase: string
  createdAt: string
  /** Local epoch of the key being replaced; the new epoch is this plus one. */
  epoch?: number
  calibrate?: () => KdfParams
  now?: () => Date
}

export interface StoreRotationResult {
  /** The new master key. The caller caches it and zeroizes it when done. */
  master: KeyMaterial
  epoch: KeyEpoch
  revision: RevisionSummary
  /** Manifest entries with every blob swapped to its resealed id. */
  entries: ManifestEntry[]
  digest: SurfaceDigest[]
  /** Blob ids that are no longer referenced after this rotation. */
  replaced: BlobId[]
  stats: RotationStats
  hint: RotationCommitHint
}

function uniqueRefs(entries: readonly ManifestEntry[]): BlobRef[] {
  const byId = new Map<string, BlobRef>()
  for (const entry of entries) {
    if (entry.blob !== undefined) byId.set(entry.blob.id, entry.blob)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function surfaceDigest(entries: readonly ManifestEntry[]): SurfaceDigest[] {
  const bySurface = new Map<string, { files: number; bytes: number }>()
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const current = bySurface.get(entry.surfaceId) ?? { files: 0, bytes: 0 }
    current.files += 1
    current.bytes += entry.size
    bySurface.set(entry.surfaceId, current)
  }
  return [...bySurface.entries()]
    .map(([surfaceId, counts]) => ({
      surfaceId: surfaceId as SurfaceDigest['surfaceId'],
      files: counts.files,
      bytes: counts.bytes,
    }))
    .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
}

/**
 * Re-encrypts the head revision under a fresh key and commits the result as a
 * child of the head. Only the head's reachable blobs are resealed, so the new
 * revision stands alone while older revisions stay behind for audit. The new
 * key is handed back and the new KDF parameters are the caller's to publish
 * after the commit lands.
 */
export async function rotateStore(input: StoreRotationInput): Promise<StoreRotationResult> {
  const refs = uniqueRefs(input.head.manifest.entries)
  const sealedFiles: SealedBlob[] = []
  for (const ref of refs) {
    const bytes = await input.remote.getBlob(ref.id)
    if (bytes.length !== ref.size) {
      throw new Error(`blob ${ref.id} is ${bytes.length} bytes, the manifest declares ${ref.size}`)
    }
    sealedFiles.push({ blobId: ref.id, namespace: 'content', blobType: 'file', bytes })
  }

  const rotated = rotatePassphrase({
    storeId: input.storeId,
    protocolVersion: input.protocolVersion,
    master: input.master,
    blobs: sealedFiles,
    newPassphrase: input.newPassphrase,
    ...(input.epoch === undefined ? {} : { epoch: input.epoch }),
    ...(input.calibrate === undefined ? {} : { calibrate: input.calibrate }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })

  try {
    const swapped = new Map<string, BlobRef>()
    for (const [index, sealed] of sealedFiles.entries()) {
      const next = rotated.blobs[index]
      if (next === undefined) throw new Error('rotation dropped a blob')
      swapped.set(sealed.blobId, { id: next.blobId, size: next.bytes.length })
    }
    const entries = input.head.manifest.entries.map((entry) => {
      if (entry.blob === undefined) return entry
      const next = swapped.get(entry.blob.id)
      if (next === undefined) throw new Error(`rotation dropped blob ${entry.blob.id}`)
      return { ...entry, blob: next }
    })
    const manifest: Manifest = {
      revisionId: input.newRevisionId,
      deviceId: input.deviceId,
      createdAt: input.createdAt,
      entries,
    }
    const sealedManifest = sealText(rotated.master, 'manifest', JSON.stringify(manifest), {
      storeId: input.storeId,
      blobType: 'manifest',
      protocolVersion: input.protocolVersion,
    })
    for (const blob of rotated.blobs) {
      await input.remote.putBlob({ blobId: blob.blobId, bytes: blob.bytes })
    }
    await input.remote.putBlob({ blobId: sealedManifest.blobId, bytes: sealedManifest.bytes })

    const parents = [input.head.revisionId, ...input.head.parents]
      .filter((value, index, values) => values.indexOf(value) === index)
      .slice(0, 4)
    const revision: RevisionSummary = {
      id: input.newRevisionId,
      storeId: input.storeId,
      deviceId: input.deviceId,
      parents,
      manifest: { id: sealedManifest.blobId, size: sealedManifest.bytes.length },
      createdAt: input.createdAt,
    }
    const digest = surfaceDigest(entries)
    const committed = await input.remote.commit({
      revision,
      blobs: uniqueRefs(entries),
      digest,
    })
    if (!committed.accepted) {
      if (committed.reason === 'stale-parents') {
        throw new StaleParentsError(committed.heads ?? [])
      }
      throw new Error(
        `the remote rejected the rotation commit; missing blobs: ${committed.missing.join(', ')}`,
      )
    }
    return {
      master: rotated.master,
      epoch: rotated.epoch,
      revision,
      entries,
      digest,
      replaced: rotated.replaced,
      stats: rotated.stats,
      hint: rotationCommitHint(rotated, input.deviceId),
    }
  } catch (error) {
    rotated.master.zeroize()
    throw error
  }
}
