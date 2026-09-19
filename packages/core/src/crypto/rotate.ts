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

import type { BlobId, DeviceId, StoreId } from '@laurencio/protocol'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import type { SealedBlob } from './aead'
import { open, seal } from './aead'
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
