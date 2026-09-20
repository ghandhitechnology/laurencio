import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlobId, DeviceId, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { blobIdOf, open, sealText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import type { Manifest } from '../src/model'
import { createFileRemote } from '../src/remote/file'
import {
  KdfGenerationConflictError,
  parseManifest,
  RemoteError,
  supportsProfile,
} from '../src/remote/types'

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
    expect(supportsProfile(remote)).toBe(true)
    expect(
      supportsProfile({ ...remote, getProfileHead: undefined } as unknown as Parameters<
        typeof supportsProfile
      >[0]),
    ).toBe(false)
    expect(remote.storeId).toBe(storeId)
    expect(await remote.getKdfParams()).toEqual({ kdf, generation: 1 })
    const reopened = createFileRemote({ dir })
    expect(reopened.storeId).toBe(storeId)
    expect(await reopened.getKdfParams()).toEqual({ kdf, generation: 1 })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('publishes KDF rotations with compare-and-set and keeps the old generation', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const rotated: KdfParams = { ...kdf, salt: 'ab'.repeat(16) }
    const first = await remote.putKdfParams({
      params: kdf,
      calibratedAt: '2026-01-02T00:00:00.000Z',
    })
    expect(first).toEqual({ kdf, generation: 1 })

    const second = await remote.putKdfParams({ params: rotated, expectedGeneration: 1 })
    expect(second.generation).toBe(2)
    expect(second.kdf.salt).toBe(rotated.salt)
    expect((await remote.getKdfParams())?.generation).toBe(2)
    expect(await remote.getKdfParams({ version: 1 })).toEqual({ kdf, generation: 1 })
    await expect(remote.getKdfParams({ version: 9 })).rejects.toMatchObject({ code: 'not-found' })

    // A repeat write of the same parameters is a no-op, not a new generation.
    expect((await remote.putKdfParams({ params: rotated })).generation).toBe(2)

    await expect(
      remote.putKdfParams({ params: { ...rotated, salt: 'cd'.repeat(16) }, expectedGeneration: 1 }),
    ).rejects.toBeInstanceOf(KdfGenerationConflictError)
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

  test('stores and rotates an opaque vault head with compare-and-swap', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const first = sealText(key, 'vault', '{"version":1,"entries":[]}', {
      storeId,
      blobType: 'vault',
      protocolVersion: 1,
    })
    const second = sealText(key, 'vault', '{"version":1,"entries":[] }', {
      storeId,
      blobType: 'vault',
      protocolVersion: 1,
    })
    const firstRef = await remote.putBlob({ blobId: first.blobId, bytes: first.bytes })
    const secondRef = await remote.putBlob({ blobId: second.blobId, bytes: second.bytes })

    expect(await remote.getVaultHead()).toBeNull()
    expect(await remote.putVaultHead({ blob: firstRef, expectedGeneration: null })).toMatchObject({
      blob: firstRef,
      generation: 1,
    })
    expect(await remote.putVaultHead({ blob: secondRef, expectedGeneration: 1 })).toMatchObject({
      blob: secondRef,
      generation: 2,
    })
    await expect(
      remote.putVaultHead({ blob: firstRef, expectedGeneration: 1 }),
    ).rejects.toMatchObject({ name: 'VaultGenerationConflictError', expected: 1, actual: 2 })
    expect((await remote.getVaultHead())?.blob).toEqual(secondRef)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('stores and rotates an opaque profile head with compare-and-swap', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const first = sealText(key, 'profile', '{"schemaVersion":2}', {
      storeId,
      blobType: 'profile',
      protocolVersion: 1,
    })
    const second = sealText(key, 'profile', '{"schemaVersion":2,"id":"default"}', {
      storeId,
      blobType: 'profile',
      protocolVersion: 1,
    })
    const firstRef = await remote.putBlob({ blobId: first.blobId, bytes: first.bytes })
    const secondRef = await remote.putBlob({ blobId: second.blobId, bytes: second.bytes })

    expect(await remote.getProfileHead()).toBeNull()
    expect(await remote.putProfileHead({ blob: firstRef, expectedGeneration: null })).toMatchObject(
      {
        blob: firstRef,
        generation: 1,
      },
    )
    expect(await remote.putProfileHead({ blob: secondRef, expectedGeneration: 1 })).toMatchObject({
      blob: secondRef,
      generation: 2,
    })
    await expect(
      remote.putProfileHead({ blob: firstRef, expectedGeneration: 1 }),
    ).rejects.toMatchObject({ name: 'ProfileGenerationConflictError', expected: 1, actual: 2 })
    expect((await remote.getProfileHead())?.blob).toEqual(secondRef)
    key.zeroize()
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

  test('parent-graph heads ignore skewed clocks and stale parents are refused', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const context = { storeId, blobType: 'manifest' as const, protocolVersion: 1 }
    const first = RevisionId.parse('00000000000000000000000021')
    const second = RevisionId.parse('00000000000000000000000022')
    const third = RevisionId.parse('00000000000000000000000023')

    async function commitRevision(id: RevisionId, parents: RevisionId[], at: string) {
      const manifest: Manifest = { revisionId: id, deviceId, createdAt: at, entries: [] }
      const sealed = sealText(key, 'manifest', JSON.stringify(manifest), context)
      await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
      return remote.commit({
        revision: {
          id,
          storeId,
          deviceId,
          parents,
          manifest: { id: sealed.blobId, size: sealed.bytes.length },
          createdAt: at,
        },
        blobs: [],
        digest: [],
      })
    }

    expect((await commitRevision(first, [], '2026-06-01T00:00:00.000Z')).accepted).toBe(true)
    // The child claims an earlier wall clock; the graph still makes it the head.
    expect((await commitRevision(second, [first], '2026-01-01T00:00:00.000Z')).accepted).toBe(true)
    const list = await remote.listRevisions()
    expect(list.heads).toEqual([second])
    expect(list.head).toBe(second)

    const stale = await commitRevision(third, [first], '2026-07-01T00:00:00.000Z')
    expect(stale.accepted).toBe(false)
    expect(stale.reason).toBe('stale-parents')
    expect(stale.heads).toEqual([second])

    const accepted = await commitRevision(third, [second], '2026-07-01T00:00:00.000Z')
    expect(accepted.accepted).toBe(true)
    expect((await remote.listRevisions()).heads).toEqual([third])
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('a fork exposes both heads and a multi-parent merge commit covers them', async () => {
    const dir = tempDir()
    const remote = newRemote(dir)
    const key = deriveMasterKey('pass', kdf)
    const context = { storeId, blobType: 'manifest' as const, protocolVersion: 1 }
    const base = RevisionId.parse('00000000000000000000000030')
    const left = RevisionId.parse('00000000000000000000000031')
    const right = RevisionId.parse('00000000000000000000000032')
    const merge = RevisionId.parse('00000000000000000000000033')

    async function sealManifest(id: RevisionId): Promise<{ id: BlobId; size: number }> {
      const manifest: Manifest = {
        revisionId: id,
        deviceId,
        createdAt: '2026-01-01T00:00:00.000Z',
        entries: [],
      }
      const sealed = sealText(key, 'manifest', JSON.stringify(manifest), context)
      await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
      return { id: sealed.blobId, size: sealed.bytes.length }
    }

    // Fabricate the fork the way a pre-graph writer could leave one: two
    // children of the same parent, written straight into the store.
    async function writeForkRevision(id: RevisionId, parents: RevisionId[]): Promise<void> {
      fs.writeFileSync(
        path.join(dir, 'revisions', `${id}.json`),
        JSON.stringify({
          id,
          parents,
          deviceId,
          createdAt: '2026-01-01T00:00:00.000Z',
          manifest: await sealManifest(id),
          digest: [],
        }),
      )
    }
    await writeForkRevision(base, [])
    await writeForkRevision(left, [base])
    await writeForkRevision(right, [base])
    const forked = await remote.listRevisions()
    expect([...forked.heads].sort()).toEqual([left, right].sort())
    expect(forked.head).toBeNull()

    const partial = await remote.commit({
      revision: {
        id: merge,
        storeId,
        deviceId,
        parents: [left],
        manifest: await sealManifest(merge),
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      blobs: [],
      digest: [],
    })
    expect(partial.accepted).toBe(false)
    expect(partial.reason).toBe('stale-parents')
    expect([...(partial.heads ?? [])].sort()).toEqual([left, right].sort())

    const joined = await remote.commit({
      revision: {
        id: merge,
        storeId,
        deviceId,
        parents: [left, right],
        manifest: await sealManifest(merge),
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      blobs: [],
      digest: [],
    })
    expect(joined.accepted).toBe(true)
    const linear = await remote.listRevisions()
    expect(linear.heads).toEqual([merge])
    expect(linear.head).toBe(merge)
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
