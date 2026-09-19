import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asBlobId, asStoreId } from '../src/ids'
import { FsBlobStore } from '../src/storage/fs'
import { blobKey } from '../src/storage/types'
import { bytesFor } from './helpers'

const dir = await mkdtemp(join(tmpdir(), 'laurencio-fs-store-'))
const store = new FsBlobStore({ dir, secret: 'unit-secret', baseUrl: 'http://localhost:8787' })
const key = 'u/store-one/b/abc'

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
  test('a put link carries the key, declared size, and an expiry', async () => {
    const upload = await store.presignPut({ key, size: 5, expiresInSeconds: 60 })
    const url = new URL(upload.url)
    expect(upload.method).toBe('PUT')
    expect(upload.headers['content-type']).toBe('application/octet-stream')
    expect(url.pathname).toBe('/local-blob/put')
    expect(url.searchParams.get('key')).toBe(key)
    expect(url.searchParams.get('size')).toBe('5')
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now())
    const verdict = store.verify(
      'put',
      key,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('sig') ?? '',
    )
    expect(verdict.ok).toBe(true)
  })

  test('a get link does not verify as a put link', async () => {
    const download = await store.presignGet({ key, expiresInSeconds: 60 })
    const url = new URL(download.url)
    const verdict = store.verify(
      'put',
      key,
      Number(url.searchParams.get('expires')),
      url.searchParams.get('sig') ?? '',
    )
    expect(verdict).toEqual({ ok: false, reason: 'bad signature' })
  })

  test('rejects tampered signatures, keys, and expired links', async () => {
    const upload = await store.presignPut({ key, size: 1, expiresInSeconds: 60 })
    const url = new URL(upload.url)
    const expires = Number(url.searchParams.get('expires'))
    expect(store.verify('put', key, expires, 'nonsense')).toEqual({
      ok: false,
      reason: 'bad signature',
    })
    expect(store.verify('put', `${key}-moved`, expires, url.searchParams.get('sig') ?? '')).toEqual(
      {
        ok: false,
        reason: 'bad signature',
      },
    )
    expect(store.verify('put', key, Date.now() - 1000, url.searchParams.get('sig') ?? '')).toEqual({
      ok: false,
      reason: 'link expired',
    })
  })
})

describe('object lifecycle', () => {
  test('put, head, get, and delete round trip', async () => {
    const bytes = bytesFor('object bytes')
    expect(await store.head(key)).toBeNull()
    await store.localPut(key, bytes)
    expect(await store.head(key)).toEqual({ size: bytes.byteLength })
    expect(Array.from((await store.localGet(key)) ?? [])).toEqual(Array.from(bytes))
    await store.delete(key)
    expect(await store.head(key)).toBeNull()
    expect(await store.localGet(key)).toBeNull()
    // Deleting a missing object is not an error.
    await store.delete(key)
  })

  test('refuses keys that escape the storage root', async () => {
    expect(await store.head('../outside')).toBeNull()
    expect(await store.localGet('../../etc/passwd')).toBeNull()
    await expect(store.localPut('../escape', bytesFor('nope'))).rejects.toThrow(
      'refusing to write outside the storage root',
    )
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
