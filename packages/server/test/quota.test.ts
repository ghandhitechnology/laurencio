import { afterAll, describe, expect, test } from 'bun:test'
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
} from './helpers'

const server = await createTestServer({ QUOTA_MAX_BYTES: '100', QUOTA_MAX_BLOBS: '2' })
afterAll(() => server.close())

async function presign(
  client: TestClient,
  token: string,
  storeId: string,
  size: number,
  label: string,
) {
  return client.request(`/v1/stores/${storeId}/blobs/presign`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ blob: { id: blobIdFor(bytesFor(label)), size } }),
  })
}

describe('quota enforcement', () => {
  test('rejects a presign that would exceed the byte limit', async () => {
    const user = await createUser(server, 'quota-bytes@example.com')
    const first = await presign(user.client, user.token, user.storeId, 60, 'quota-a')
    expect(first.status).toBe(200)

    const second = await presign(user.client, user.token, user.storeId, 50, 'quota-b')
    expect(second.status).toBe(413)
    const body = await readJson<{ error: { code: string; details: Record<string, unknown> } }>(
      second,
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
    expect((await presign(user.client, user.token, user.storeId, 10, 'count-a')).status).toBe(200)
    expect((await presign(user.client, user.token, user.storeId, 10, 'count-b')).status).toBe(200)
    const third = await presign(user.client, user.token, user.storeId, 10, 'count-c')
    expect(third.status).toBe(413)
    expect(await third.json()).toMatchObject({
      error: { code: 'quota_exceeded', details: { limit: 'blobs', maxBlobs: 2, usedBlobs: 2 } },
    })
  })

  test('a repeated presign for an existing blob does not count twice', async () => {
    const user = await createUser(server, 'quota-repeat@example.com')
    expect((await presign(user.client, user.token, user.storeId, 90, 'repeat')).status).toBe(200)
    // Same blob id and size: no new object, no new bytes.
    expect((await presign(user.client, user.token, user.storeId, 90, 'repeat')).status).toBe(200)
    const me = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(me.quotas).toMatchObject({ blobs: 1, bytes: 90 })
  })

  test('per-store limits override the environment defaults', async () => {
    const user = await createUser(server, 'quota-store@example.com')
    await server.db.update(stores).set({ maxBytes: 10 }).where(eq(stores.id, user.storeId))
    const response = await presign(user.client, user.token, user.storeId, 20, 'store-limit')
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({
      error: { details: { maxBytes: 10, incomingBytes: 20 } },
    })
  })

  test('rejects a commit when the store is already over its limit', async () => {
    const user = await createUser(server, 'quota-commit@example.com')
    const bytes = bytesFor('over limit blob')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    const presigned = await user.client.json<{ url: string }>(
      `/v1/stores/${user.storeId}/blobs/presign`,
      {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ blob: manifest }),
      },
    )
    const url = new URL(presigned.url)
    await user.client.expectStatus(`${url.pathname}${url.search}`, 200, {
      method: 'PUT',
      body: bytes,
    })
    await server.db.update(stores).set({ maxBytes: 0 }).where(eq(stores.id, user.storeId))
    const response = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({
        protocolVersion: 1,
        revision: {
          id: '01M2WAAP09R3A8HWSTNF3F0Y41',
          storeId: user.storeId,
          deviceId: user.deviceId,
          parents: [],
          manifest,
          createdAt: new Date().toISOString(),
        },
        blobs: [],
      }),
    })
    expect(response.status).toBe(413)
    expect(await response.json()).toMatchObject({ error: { code: 'quota_exceeded' } })
  })
})
