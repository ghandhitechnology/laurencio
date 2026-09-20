import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BlobId, RevisionId } from '@laurencio/protocol'
import { blobIdOf } from '../src/crypto/aead'
import { createCachedRemote } from '../src/remote/cache'
import type { Remote } from '../src/remote/types'

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-cache-'))
}

function stubRemote(blobs: Map<string, Uint8Array>) {
  let gets = 0
  const remote: Remote = {
    getKdfParams: async () => null,
    putKdfParams: async () => {
      throw new Error('unused')
    },
    listRevisions: async () => ({ revisions: [], head: null, heads: [] }),
    getManifest: async () => new Uint8Array(),
    putBlob: async (upload) => {
      blobs.set(upload.blobId, upload.bytes)
      return { id: upload.blobId, size: upload.bytes.length }
    },
    getBlob: async (blobId) => {
      gets += 1
      const bytes = blobs.get(blobId)
      if (bytes === undefined) throw new Error(`missing blob ${blobId}`)
      return bytes
    },
    commit: async () => ({
      revisionId: '0'.repeat(26) as RevisionId,
      accepted: true,
      missing: [],
    }),
    listDevices: async () => [],
  }
  return {
    remote,
    getCalls: () => gets,
  }
}

describe('createCachedRemote', () => {
  test('a second getBlob of the same id does not hit the inner remote', async () => {
    const dir = tempDir()
    const bytes = new TextEncoder().encode('ciphertext')
    const id = blobIdOf(bytes)
    const stub = stubRemote(new Map([[id, bytes]]))
    const cached = createCachedRemote(stub.remote, dir)

    expect(await cached.getBlob(id)).toEqual(bytes)
    expect(await cached.getBlob(id)).toEqual(bytes)
    expect(stub.getCalls()).toBe(1)
    expect(new Uint8Array(fs.readFileSync(path.join(dir, id)))).toEqual(bytes)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a corrupted cache entry is ignored and refetched', async () => {
    const dir = tempDir()
    const bytes = new TextEncoder().encode('ciphertext')
    const id = blobIdOf(bytes)
    const stub = stubRemote(new Map([[id, bytes]]))
    const cached = createCachedRemote(stub.remote, dir)

    await cached.getBlob(id)
    fs.writeFileSync(path.join(dir, id), 'corrupted')
    expect(await cached.getBlob(id)).toEqual(bytes)
    expect(stub.getCalls()).toBe(2)
    expect(new Uint8Array(fs.readFileSync(path.join(dir, id)))).toEqual(bytes)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('putBlob delegates and populates the cache', async () => {
    const dir = tempDir()
    const bytes = new TextEncoder().encode('uploaded')
    const id: BlobId = blobIdOf(bytes)
    const stub = stubRemote(new Map())
    const cached = createCachedRemote(stub.remote, dir)

    const ref = await cached.putBlob({ blobId: id, bytes })
    expect(ref.id).toBe(id)
    expect(new Uint8Array(fs.readFileSync(path.join(dir, id)))).toEqual(bytes)
    expect(await cached.getBlob(id)).toEqual(bytes)
    expect(stub.getCalls()).toBe(0)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
