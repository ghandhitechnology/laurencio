import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asBlobId, asStoreId } from '../src/ids'
import { ChecksumMismatchError, FsBlobStore } from '../src/storage/fs'
import { blobKey, sha256Hex } from '../src/storage/types'
import { bytesFor } from './helpers'

const dir = await mkdtemp(join(tmpdir(), 'laurencio-fs-store-'))
const store = new FsBlobStore({ dir, secret: 'unit-secret', baseUrl: 'http://localhost:8787' })
const key = 'u/store-one/b/abc'
const digest = sha256Hex(bytesFor('five!'))

afterAll(async () => {
  const { rm } = await import('node:fs/promises')
  await rm(dir, { recursive: true, force: true })
})

describe('key scheme', () => {
  test('is derived from the store id and ciphertext hash only', () => {
    const value = blobKey(asStoreId('01M2WAAP09R3A8HWSTNF3F0Y40'), asBlobId('a'.repeat(64)))
    expect(value).toBe(`u/01M2WAAP09R3A8HWSTNF3F0Y40/b/${'a'.repeat(64)}`)
  })
})

describe('signed local URLs', () => {
  test('a put link carries the key, size, checksum, and an expiry', async () => {
    const upload = await store.presignPut({ key, size: 5, sha256: digest, expiresInSeconds: 60 })
    const url = new URL(upload.url)
    expect(upload.method).toBe('PUT')
    expect(upload.headers['content-type']).toBe('application/octet-stream')
    expect(url.pathname).toBe('/local-blob/put')
    expect(url.searchParams.get('key')).toBe(key)
    expect(url.searchParams.get('size')).toBe('5')
    expect(url.searchParams.get('sha256')).toBe(digest)
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const verdict = store.verifyPut({
      key,
      expires: Number(url.searchParams.get('expires')),
      sig: url.searchParams.get('sig') ?? '',
      sha256: digest,
    })
    expect(verdict.ok).toBe(true)
  })

  test('a get link does not verify as a put link', async () => {
    const download = await store.presignGet({ key, expiresInSeconds: 60 })
    const url = new URL(download.url)
    const expires = Number(url.searchParams.get('expires'))
    const sig = url.searchParams.get('sig') ?? ''
    expect(store.verifyPut({ key, expires, sig, sha256: digest })).toEqual({
      ok: false,
      reason: 'bad signature',
    })
    expect(store.verifyGet({ key, expires, sig }).ok).toBe(true)
  })

  test('rejects tampered signatures, keys, checksums, and expired links', async () => {
    const upload = await store.presignPut({ key, size: 1, sha256: digest, expiresInSeconds: 60 })
    const url = new URL(upload.url)
    const expires = Number(url.searchParams.get('expires'))
    const sig = url.searchParams.get('sig') ?? ''
    expect(store.verifyPut({ key, expires, sig, sha256: digest }).ok).toBe(true)
    expect(store.verifyPut({ key, expires, sig, sha256: 'b'.repeat(64) })).toEqual({
      ok: false,
      reason: 'bad signature',
    })
    expect(store.verifyPut({ key: `${key}-moved`, expires, sig, sha256: digest })).toEqual({
      ok: false,
      reason: 'bad signature',
    })
    expect(store.verifyPut({ key, expires: Date.now() - 1000, sig, sha256: digest })).toEqual({
      ok: false,
      reason: 'link expired',
    })
  })
})

describe('object lifecycle', () => {
  test('put, head, get, and delete round trip', async () => {
    const bytes = bytesFor('object bytes')
    expect(await store.head(key)).toBeNull()
    await store.localPut(key, bytes, sha256Hex(bytes))
    expect(await store.head(key)).toEqual({
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    })
    expect(Array.from((await store.localGet(key)) ?? [])).toEqual(Array.from(bytes))
    await store.delete(key)
    expect(await store.head(key)).toBeNull()
    expect(await store.localGet(key)).toBeNull()
    // Deleting a missing object is not an error.
    await store.delete(key)
  })

  test('refuses to write bytes that do not match the signed checksum', async () => {
    const bytes = bytesFor('honest bytes')
    await expect(store.localPut(key, bytes, 'c'.repeat(64))).rejects.toBeInstanceOf(
      ChecksumMismatchError,
    )
    expect(await store.head(key)).toBeNull()
  })

  test('refuses keys that escape the storage root', async () => {
    expect(await store.head('../outside')).toBeNull()
    expect(await store.localGet('../../etc/passwd')).toBeNull()
    await expect(
      store.localPut('../escape', bytesFor('nope'), sha256Hex(bytesFor('nope'))),
    ).rejects.toThrow('refusing to write outside the storage root')
    await store.delete('../escape')
  })

  test('nested keys are isolated per store', async () => {
    const first = 'u/store-a/b/blob-one'
    const second = 'u/store-b/b/blob-one'
    await store.localPut(first, bytesFor('first'))
    await store.localPut(second, bytesFor('second'))
    expect(Array.from((await store.localGet(first)) ?? [])).toEqual(Array.from(bytesFor('first')))
    expect(Array.from((await store.localGet(second)) ?? [])).toEqual(Array.from(bytesFor('second')))
  })
})
