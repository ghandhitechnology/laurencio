import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { EnvelopeError, openText, type SealedBlob, sealText } from '../../src/crypto/aead'
import {
  ARGON2_VERSION,
  deriveMasterKey,
  type KdfParams,
  type KeyMaterial,
  kdfParamsToWire,
} from '../../src/crypto/kdf'
import {
  keyEpochFromParams,
  rotatePassphrase,
  rotateStore,
  rotationDigest,
} from '../../src/crypto/rotate'
import type { Manifest } from '../../src/model'
import { createFileRemote } from '../../src/remote/file'
import { parseManifest } from '../../src/remote/types'

const storeId = StoreId.parse('0123456789ABCDEFGHJKMNPQRS')
const protocolVersion = 1
const deviceId = DeviceId.parse('0123456789ABCDEFGHJKMNPQRT')
const headRevisionId = RevisionId.parse('0123456789ABCDEFGHJKMNPQRV')
const rotatedRevisionId = RevisionId.parse('0123456789ABCDEFGHJKMNPQRW')
const surfaceId = SurfaceId.parse('claude.settings')
const ROTATED_PASSPHRASE = 'the new passphrase'
const oldParams: KdfParams = {
  algo: 'argon2id',
  salt: 'ab'.repeat(16),
  m: 8,
  t: 1,
  p: 1,
  version: ARGON2_VERSION,
}
const newParams: KdfParams = {
  algo: 'argon2id',
  salt: 'cd'.repeat(16),
  m: 8,
  t: 1,
  p: 1,
  version: ARGON2_VERSION,
  calibrationMs: 12,
}

function oldKey(): KeyMaterial {
  return deriveMasterKey('the old passphrase', oldParams)
}

function newKey(): KeyMaterial {
  return deriveMasterKey('the new passphrase', newParams)
}

function corpus(key: KeyMaterial): SealedBlob[] {
  return [
    sealText(key, 'content', 'claude/settings.json body', {
      storeId,
      blobType: 'file',
      protocolVersion,
    }),
    sealText(key, 'manifest', '{"entries":[]}', { storeId, blobType: 'manifest', protocolVersion }),
    sealText(key, 'metadata', '{"device":"mac"}', {
      storeId,
      blobType: 'metadata',
      protocolVersion,
    }),
  ]
}

describe('passphrase rotation', () => {
  test('re-encrypts every blob under the new key and new epoch', () => {
    const before = oldKey()
    const blobs = corpus(before)
    const result = rotatePassphrase({
      storeId,
      protocolVersion,
      master: before,
      blobs,
      newPassphrase: 'the new passphrase',
      calibrate: () => newParams,
      epoch: 1,
      now: () => new Date('2026-09-19T00:00:00.000Z'),
    })

    expect(result.epoch.epoch).toBe(2)
    expect(result.epoch.kdf.salt).toBe(newParams.salt)
    expect(result.epoch.createdAt).toBe('2026-09-19T00:00:00.000Z')
    expect(result.stats.reEncrypted).toBe(blobs.length)
    expect(result.replaced).toEqual(blobs.map((blob) => blob.blobId))
    expect(result.digest).toBe(rotationDigest(result.blobs))
    expect(result.digest).toMatch(/^[0-9a-f]{64}$/)

    // Every blob decrypts under the new key and every id changed.
    for (const [index, blob] of result.blobs.entries()) {
      const original = blobs[index]
      expect(original).toBeDefined()
      expect(blob.blobId).not.toBe(original?.blobId)
      const plaintext = openText(result.master, blob.namespace, blob.bytes, {
        storeId,
        blobType: blob.blobType,
        protocolVersion,
      })
      expect(plaintext.length).toBeGreaterThan(0)
    }

    before.zeroize()
    result.master.zeroize()
  })

  test('the old key cannot open a rotated blob', () => {
    const before = oldKey()
    const blobs = corpus(before)
    const result = rotatePassphrase({
      storeId,
      protocolVersion,
      master: before,
      blobs,
      newPassphrase: 'the new passphrase',
      calibrate: () => newParams,
    })
    const rotated = result.blobs[0]
    expect(rotated).toBeDefined()
    expect(() =>
      openText(before, rotated?.namespace ?? 'content', rotated?.bytes ?? new Uint8Array(), {
        storeId,
        blobType: rotated?.blobType ?? 'file',
        protocolVersion,
      }),
    ).toThrow(EnvelopeError)
    before.zeroize()
    result.master.zeroize()
  })

  test('a wrong passphrase produces a key that cannot open the new blobs', () => {
    const before = oldKey()
    const blobs = corpus(before)
    const result = rotatePassphrase({
      storeId,
      protocolVersion,
      master: before,
      blobs,
      newPassphrase: 'the new passphrase',
      calibrate: () => newParams,
    })
    const wrong = deriveMasterKey('not the new passphrase', newParams)
    const rotated = result.blobs[0]
    expect(() =>
      openText(wrong, rotated?.namespace ?? 'content', rotated?.bytes ?? new Uint8Array(), {
        storeId,
        blobType: rotated?.blobType ?? 'file',
        protocolVersion,
      }),
    ).toThrow('authentication failed')
    before.zeroize()
    wrong.zeroize()
    result.master.zeroize()
  })

  test('the rotated set is identical to sealing the same plaintext under the new key', () => {
    const before = oldKey()
    const blobs = corpus(before)
    const result = rotatePassphrase({
      storeId,
      protocolVersion,
      master: before,
      blobs,
      newPassphrase: 'the new passphrase',
      calibrate: () => newParams,
    })
    const direct = sealText(newKey(), 'content', 'claude/settings.json body', {
      storeId,
      blobType: 'file',
      protocolVersion,
    })
    const rotatedContent = result.blobs[0]
    expect(rotatedContent?.blobId).not.toBe(direct.blobId) // fresh nonce per seal
    expect(
      openText(newKey(), 'content', rotatedContent?.bytes ?? new Uint8Array(), {
        storeId,
        blobType: 'file',
        protocolVersion,
      }),
    ).toBe('claude/settings.json body')
    before.zeroize()
    result.master.zeroize()
  })

  test('rotation fails closed on a tampered blob and does not leak the new key', () => {
    const before = oldKey()
    const blobs = corpus(before)
    const tampered = blobs.slice()
    const target = tampered[1]
    if (target === undefined) throw new Error('missing fixture blob')
    const bytes = target.bytes.slice()
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01
    tampered[1] = { ...target, bytes }
    expect(() =>
      rotatePassphrase({
        storeId,
        protocolVersion,
        master: before,
        blobs: tampered,
        newPassphrase: 'the new passphrase',
        calibrate: () => newParams,
      }),
    ).toThrow('authentication failed')
    before.zeroize()
  })

  test('a zeroized master refuses to rotate', () => {
    const before = oldKey()
    before.zeroize()
    expect(() =>
      rotatePassphrase({
        storeId,
        protocolVersion,
        master: before,
        blobs: [],
        newPassphrase: 'x',
        calibrate: () => newParams,
      }),
    ).toThrow('zeroized')
  })
})

describe('key epochs', () => {
  test('epoch records the kdf parameters and time', () => {
    const epoch = keyEpochFromParams(oldParams, 3, () => new Date('2026-09-19T12:00:00.000Z'))
    expect(epoch).toEqual({
      epoch: 3,
      kdf: oldParams,
      createdAt: '2026-09-19T12:00:00.000Z',
    })
  })
})

describe('store rotation', () => {
  test('rotates a FileRemote store: publish, re-derive, and decrypt the newest revision', async () => {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-rotate-'))
    const remote = createFileRemote({
      dir,
      storeId,
      kdf: kdfParamsToWire(oldParams, '2026-09-19T00:00:00.000Z'),
    })
    const before = oldKey()
    const content = sealText(before, 'content', '{"theme":"dark"}', {
      storeId,
      blobType: 'file',
      protocolVersion,
    })
    await remote.putBlob({ blobId: content.blobId, bytes: content.bytes })
    const manifest: Manifest = {
      revisionId: headRevisionId,
      deviceId,
      createdAt: '2026-09-19T00:00:00.000Z',
      entries: [
        {
          surfaceId,
          path: 'settings.json',
          kind: 'file',
          policy: 'sync',
          hash: 'hash-one',
          size: content.bytes.length,
          mode: 0o644,
          blob: { id: content.blobId, size: content.bytes.length },
        },
      ],
    }
    const sealedManifest = sealText(before, 'manifest', JSON.stringify(manifest), {
      storeId,
      blobType: 'manifest',
      protocolVersion,
    })
    await remote.putBlob({ blobId: sealedManifest.blobId, bytes: sealedManifest.bytes })
    const committed = await remote.commit({
      revision: {
        id: headRevisionId,
        storeId,
        deviceId,
        parents: [],
        manifest: { id: sealedManifest.blobId, size: sealedManifest.bytes.length },
        createdAt: manifest.createdAt,
      },
      blobs: [{ id: content.blobId, size: content.bytes.length }],
      digest: [],
    })
    expect(committed.accepted).toBe(true)

    const rotation = await rotateStore({
      remote,
      storeId,
      protocolVersion,
      deviceId,
      master: before,
      head: { revisionId: headRevisionId, parents: [], manifest },
      newRevisionId: rotatedRevisionId,
      newPassphrase: ROTATED_PASSPHRASE,
      createdAt: '2026-09-19T01:00:00.000Z',
      epoch: 1,
      calibrate: () => newParams,
      now: () => new Date('2026-09-19T01:00:00.000Z'),
    })
    const published = await remote.putKdfParams({
      params: rotation.epoch.kdf,
      calibratedAt: rotation.epoch.createdAt,
      expectedGeneration: 1,
    })
    rotation.master.zeroize()
    before.zeroize()

    expect(published.generation).toBe(2)
    expect(rotation.epoch.epoch).toBe(2)
    expect(rotation.stats.reEncrypted).toBe(1)

    // A fresh device derives from the published parameters and reads the head.
    const derived = await remote.getKdfParams()
    expect(derived?.generation).toBe(2)
    const after = deriveMasterKey(ROTATED_PASSPHRASE, derived?.kdf ?? newParams)
    const newest = await remote.listRevisions()
    expect(newest.head).toBe(rotatedRevisionId)
    const manifestBytes = await remote.getManifest(rotatedRevisionId)
    const rotatedManifest = parseManifest(
      JSON.parse(
        openText(after, 'manifest', manifestBytes, {
          storeId,
          blobType: 'manifest',
          protocolVersion,
        }),
      ),
    )
    const entry = rotatedManifest.entries[0]
    if (entry?.blob === undefined) throw new Error('rotated manifest lost its blob')
    const contentBytes = await remote.getBlob(entry.blob.id)
    expect(
      openText(after, 'content', contentBytes, { storeId, blobType: 'file', protocolVersion }),
    ).toBe('{"theme":"dark"}')

    // The old generation still resolves for audit, and the old key is locked out.
    expect(await remote.getKdfParams({ version: 1 })).toEqual({ kdf: oldParams, generation: 1 })
    const staleKey = deriveMasterKey('the old passphrase', oldParams)
    expect(() =>
      openText(staleKey, 'manifest', manifestBytes, {
        storeId,
        blobType: 'manifest',
        protocolVersion,
      }),
    ).toThrow(EnvelopeError)
    staleKey.zeroize()
    after.zeroize()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
