/**
 * On-disk cache of ciphertext blobs in front of another remote. Blob ids are
 * the hash of the ciphertext, so a cached file can be verified on read and a
 * corrupted entry is simply refetched. Writes go through on every upload.
 */

import fs from 'node:fs'
import path from 'node:path'
import { BlobId } from '@laurencio/protocol'
import { blobIdOf } from '../crypto/aead'
import { type Remote, supportsProfile, supportsVault } from './types'

export function createCachedRemote(remote: Remote, dir: string): Remote {
  const read = (id: string): Uint8Array | null => {
    if (!BlobId.safeParse(id).success) return null
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(path.join(dir, id))
    } catch {
      return null
    }
    return blobIdOf(bytes) === id ? bytes : null
  }
  const write = (id: string, bytes: Uint8Array): void => {
    if (!BlobId.safeParse(id).success) return
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const temp = path.join(dir, `.${id}.${process.pid}.tmp`)
      fs.writeFileSync(temp, bytes, { mode: 0o600 })
      fs.renameSync(temp, path.join(dir, id))
    } catch {
      // A cache write failure must not fail the transfer itself.
    }
  }
  const cached: Remote = {
    getKdfParams: (options) => remote.getKdfParams(options),
    putKdfParams: (input) => remote.putKdfParams(input),
    listRevisions: (options) => remote.listRevisions(options),
    getManifest: (revisionId) => remote.getManifest(revisionId),
    putBlob: async (upload) => {
      const ref = await remote.putBlob(upload)
      write(ref.id, upload.bytes)
      return ref
    },
    getBlob: async (blobId) => {
      const hit = read(blobId)
      if (hit !== null) return hit
      const bytes = await remote.getBlob(blobId)
      write(blobId, bytes)
      return bytes
    },
    commit: (commit) => remote.commit(commit),
    listDevices: () => remote.listDevices(),
  }
  if (supportsProfile(remote)) {
    Object.assign(cached, {
      getProfileHead: () => remote.getProfileHead(),
      putProfileHead: (input: Parameters<typeof remote.putProfileHead>[0]) =>
        remote.putProfileHead(input),
    })
  }
  if (supportsVault(remote)) {
    Object.assign(cached, {
      getVaultHead: () => remote.getVaultHead(),
      putVaultHead: (input: Parameters<typeof remote.putVaultHead>[0]) =>
        remote.putVaultHead(input),
    })
  }
  return cached
}
