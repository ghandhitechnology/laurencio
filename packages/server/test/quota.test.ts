import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { stores } from '../src/db/schema'
import {
  authHeaders,
  blobIdFor,
  bytesFor,
  createTestServer,
  createUser,
  readJson,
  type TestClient,
  type TestUser,
  uploadBlob,
} from './helpers'

const server = await createTestServer({ QUOTA_MAX_BYTES: '100', QUOTA_MAX_BLOBS: '2' })
afterAll(() => server.close())

interface BlobSpec {
  id: string
  size: number
}

function blobsFor(label: string, size?: number) {
  // Fill bytes from the label's last character so sibling labels stay distinct.
  const bytes =
    size === undefined
      ? bytesFor(label)
      : new Uint8Array(size).fill(label.charCodeAt(label.length - 1))
  return { bytes, ref: { id: blobIdFor(bytes), size: bytes.byteLength } }
}

async function presign(client: TestClient, token: string, storeId: string, ref: BlobSpec) {
  return client.request(`/v1/stores/${storeId}/blobs/presign`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ blob: ref }),
  })
}

async function commit(user: TestUser, manifest: BlobSpec, blobs: BlobSpec[] = []) {
  return user.client.request(`/v1/stores/${user.storeId}/commits`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({
      protocolVersion: 1,
      revision: {
        id: newId(),
        storeId: user.storeId,
        deviceId: user.deviceId,
        parents: [],
        manifest,
        createdAt: new Date().toISOString(),
      },
      blobs,
    }),
  })
}

describe('quota enforcement', () => {
  test('presign checks committed usage and rejects a would-be overage', async () => {
    const user = await createUser(server, 'quota-bytes@example.com')
    const first = blobsFor('quota-a', 60)
    await uploadBlob(user.client, user.token, user.storeId, first.bytes, first.ref.id)
    expect((await commit(user, first.ref)).status).toBe(201)

    const second = blobsFor('quota-b', 50)
    const response = await presign(user.client, user.token, user.storeId, second.ref)
    expect(response.status).toBe(413)
    const body = await readJson<{ error: { code: string; details: Record<string, unknown> } }>(
      response,
    )
    expect(body.error.code).toBe('quota_exceeded')
    expect(body.error.details).toMatchObject({
      limit: 'bytes',
      maxBytes: 100,
      usedBytes: 60,
      incomingBytes: 50,
    })
  })

  test('rejects a presign that would exceed the object limit', async () => {
    const user = await createUser(server, 'quota-blobs@example.com')
    const manifest = blobsFor('count-manifest')
    const content = blobsFor('count-content')
    await uploadBlob(user.client, user.token, user.storeId, manifest.bytes, manifest.ref.id)
    await uploadBlob(user.client, user.token, user.storeId, content.bytes, content.ref.id)
    expect((await commit(user, manifest.ref, [content.ref])).status).toBe(201)

    const third = blobsFor('count-c', 10)
    const response = await presign(user.client, user.token, user.storeId, third.ref)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { code: 'quota_exceeded', details: { limit: 'blobs', maxBlobs: 2, usedBlobs: 2 } },
    })
  })

  test('a repeated presign for an existing blob does not count twice', async () => {
    const user = await createUser(server, 'quota-repeat@example.com')
    const blob = blobsFor('repeat', 90)
    expect((await presign(user.client, user.token, user.storeId, blob.ref)).status).toBe(200)
    await uploadBlob(user.client, user.token, user.storeId, blob.bytes, blob.ref.id)
    expect((await commit(user, blob.ref)).status).toBe(201)

    // Same blob id and size: no new object, no new bytes.
    expect((await presign(user.client, user.token, user.storeId, blob.ref)).status).toBe(200)
    const me = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(me.quotas).toMatchObject({ blobs: 1, bytes: 90 })
  })

  test('abandoned presigns do not consume quota and commit still enforces it', async () => {
    const user = await createUser(server, 'quota-abandoned@example.com')
    const a = blobsFor('abandoned-a', 40)
    const b = blobsFor('abandoned-b', 40)
    const c = blobsFor('abandoned-c', 40)

    // Three 40-byte presigns exceed the 100-byte limit on paper, but nothing
    // counts until a commit references the bytes.
    expect((await presign(user.client, user.token, user.storeId, a.ref)).status).toBe(200)
    expect((await presign(user.client, user.token, user.storeId, b.ref)).status).toBe(200)
    expect((await presign(user.client, user.token, user.storeId, c.ref)).status).toBe(200)
    const before = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(before.quotas).toMatchObject({ blobs: 0, bytes: 0 })

    await uploadBlob(user.client, user.token, user.storeId, a.bytes, a.ref.id)
    await uploadBlob(user.client, user.token, user.storeId, b.bytes, b.ref.id)
    await uploadBlob(user.client, user.token, user.storeId, c.bytes, c.ref.id)
    expect((await commit(user, a.ref)).status).toBe(201)
    const after = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(after.quotas).toMatchObject({ blobs: 1, bytes: 40 })

    // Committing b and c together would blow past the object limit.
    const third = await commit(user, b.ref, [c.ref])
    expect(third.status).toBe(413)
    expect(await third.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })

  test('per-store limits override the environment defaults', async () => {
    const user = await createUser(server, 'quota-store@example.com')
    await server.db.update(stores).set({ maxBytes: 10 }).where(eq(stores.id, user.storeId))
    const oversized = blobsFor('store-limit', 20)
    const response = await presign(user.client, user.token, user.storeId, oversized.ref)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { details: { maxBytes: 10, incomingBytes: 20 } },
    })
  })

  test('rejects a commit when the store is already over its limit', async () => {
    const user = await createUser(server, 'quota-commit@example.com')
    const blob = blobsFor('over limit blob')
    await uploadBlob(user.client, user.token, user.storeId, blob.bytes, blob.ref.id)
    await server.db.update(stores).set({ maxBytes: 0 }).where(eq(stores.id, user.storeId))
    const response = await commit(user, blob.ref)
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })
})
