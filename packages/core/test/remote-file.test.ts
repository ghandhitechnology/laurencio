import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlobId, DeviceId, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { blobIdOf, open, sealText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import type { Manifest } from '../src/model'
import { createFileRemote } from '../src/remote/file'
import { parseManifest, RemoteError } from '../src/remote/types'

const storeId = StoreId.parse('00000000000000000000000001')
const deviceId = DeviceId.parse('00000000000000000000000002')
const revisionId = RevisionId.parse('00000000000000000000000003')
const surfaceId = SurfaceId.parse('claude.settings')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const context = { storeId, blobType: 'file' as const, protocolVersion: 1 }

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-remote-'))
}

function newRemote(dir: string) {
  return createFileRemote({
    dir,
    storeId,
    kdf: kdfParamsToWire(kdf, '2026-01-01T00:00:00.000Z'),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  })
}

describe('FileRemote', () => {
  test('seeds and reopens a store with stable kdf params and store id', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    expect(remote.storeId).toBe(storeId)
    expect(await remote.getKdfParams()).toEqual(kdf)
    const reopened = createFileRemote({ dir })
    expect(reopened.storeId).toBe(storeId)
    expect(await reopened.getKdfParams()).toEqual(kdf)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('stores blobs idempotently under their ciphertext hash and rejects mismatches', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const sealed = sealText(key, 'content', 'model = "gpt-5"\n', context)
    const ref = await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
    expect(ref.id).toBe(sealed.blobId)
    await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
    const stored = fs.readFileSync(path.join(dir, 'blobs', sealed.blobId))
    expect(blobIdOf(stored)).toBe(sealed.blobId)
    expect(stored.toString('utf8')).not.toContain('gpt-5')
    const bytes = await remote.getBlob(sealed.blobId)
    expect(new TextDecoder().decode(open(key, 'content', bytes, context))).toBe('model = "gpt-5"\n')

    const wrong = sealText(key, 'content', 'other', context)
    await expect(
      remote.putBlob({ blobId: sealed.blobId, bytes: wrong.bytes }),
    ).rejects.toBeInstanceOf(RemoteError)
    await expect(remote.getBlob(BlobId.parse('0'.repeat(64)))).rejects.toMatchObject({
      code: 'not-found',
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('commits idempotently and reports missing blobs without recording the revision', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const manifest: Manifest = {
      revisionId,
      deviceId,
      createdAt: '2026-01-02T00:00:00.000Z',
      entries: [],
    }
    const manifestBlob = sealText(key, 'manifest', JSON.stringify(manifest), {
      storeId,
      blobType: 'manifest',
      protocolVersion: 1,
    })
    await remote.putBlob({ blobId: manifestBlob.blobId, bytes: manifestBlob.bytes })
    const content = sealText(key, 'content', 'hello', context)
    const revision = {
      id: revisionId,
      storeId,
      deviceId,
      parents: [],
      manifest: { id: manifestBlob.blobId, size: manifestBlob.bytes.length },
      createdAt: '2026-01-02T00:00:00.000Z',
    }
    const rejected = await remote.commit({
      revision,
      blobs: [{ id: content.blobId, size: content.bytes.length }],
      digest: [],
    })
    expect(rejected.accepted).toBe(false)
    expect(rejected.missing).toEqual([content.blobId])

    await remote.putBlob({ blobId: content.blobId, bytes: content.bytes })
    const accepted = await remote.commit({
      revision,
      blobs: [{ id: content.blobId, size: content.bytes.length }],
      digest: [{ surfaceId, files: 1, bytes: 5 }],
    })
    expect(accepted.accepted).toBe(true)
    expect((await remote.commit({ revision, blobs: [], digest: [] })).accepted).toBe(true)

    const list = await remote.listRevisions()
    expect(list.head).toBe(revisionId)
    expect(list.revisions).toHaveLength(1)
    expect(list.revisions[0]?.digest).toEqual([{ surfaceId, files: 1, bytes: 5 }])
    const bytes = await remote.getManifest(revisionId)
    const parsed = parseManifest(
      JSON.parse(
        new TextDecoder().decode(
          open(key, 'manifest', bytes, { storeId, blobType: 'manifest', protocolVersion: 1 }),
        ),
      ),
    )
    expect(parsed.revisionId).toBe(revisionId)

    await remote.upsertDevice({
      id: deviceId,
      name: 'test device',
      platform: 'darwin',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    expect((await remote.listDevices())[0]?.name).toBe('test device')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a blob sealed for one store does not open in another', () => {
    const key = deriveMasterKey('pass', kdf)
    const sealed = sealText(key, 'content', 'secret', context)
    const otherStore = {
      storeId: StoreId.parse('00000000000000000000000009'),
      blobType: 'file' as const,
      protocolVersion: 1,
    }
    expect(() => open(key, 'content', sealed.bytes, otherStore)).toThrow('authentication failed')
  })
})
