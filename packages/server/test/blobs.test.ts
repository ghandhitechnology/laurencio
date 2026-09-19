import { afterAll, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import {
  authHeaders,
  blobIdFor,
  bytesFor,
  createClient,
  createTestServer,
  createUser,
  type TestUser,
  uploadBlob,
} from './helpers'

const server = await createTestServer({ QUOTA_MAX_BLOB_BYTES: '4096' })
afterAll(() => server.close())

interface PresignBody {
  url: string
  method: 'PUT'
  expiresAt: string
  headers: Record<string, string>
  blobId: string
}

function pathOf(url: string): string {
  const parsed = new URL(url)
  return `${parsed.pathname}${parsed.search}`
}

async function presign(
  user: TestUser,
  blobId: string,
  size: number,
): Promise<{ response: Response; body: PresignBody }> {
  const response = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({ blob: { id: blobId, size } }),
  })
  const body = (await response.clone().json()) as PresignBody
  return { response, body }
}

async function upload(user: TestUser, bytes: Uint8Array): Promise<string> {
  const id = blobIdFor(bytes)
  await uploadBlob(user.client, user.token, user.storeId, bytes, id)
  return id
}

describe('POST /v1/stores/:id/blobs/presign', () => {
  test('returns a presigned upload with an expiry', async () => {
    const user = await createUser(server, 'blob-presign@example.com')
    const bytes = bytesFor('first ciphertext')
    const { response, body } = await presign(user, blobIdFor(bytes), bytes.byteLength)
    expect(response.status).toBe(200)
    expect(body.method).toBe('PUT')
    expect(body.blobId).toBe(blobIdFor(bytes))
    expect(body.url).toContain('/local-blob/put')
    expect(body.headers['content-type']).toBe('application/octet-stream')
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  test('is idempotent for the same blob id and size', async () => {
    const user = await createUser(server, 'blob-repeat@example.com')
    const bytes = bytesFor('repeated ciphertext')
    const id = blobIdFor(bytes)
    await uploadBlob(user.client, user.token, user.storeId, bytes, id)
    const first = await presign(user, id, bytes.byteLength)
    const second = await presign(user, id, bytes.byteLength)
    expect(first.response.status).toBe(200)
    expect(second.response.status).toBe(200)
    // An upload that never lands in a commit does not count yet.
    const me = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(me.quotas).toMatchObject({ blobs: 0, bytes: 0 })
  })

  test('refuses the same blob id with a different size', async () => {
    const user = await createUser(server, 'blob-size-conflict@example.com')
    const bytes = bytesFor('size matters')
    await uploadBlob(user.client, user.token, user.storeId, bytes, blobIdFor(bytes))
    const { response } = await presign(user, blobIdFor(bytes), bytes.byteLength + 1)
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } })
  })

  test('refuses a blob larger than the per-object limit', async () => {
    const user = await createUser(server, 'blob-too-big@example.com')
    const response = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ blob: { id: 'a'.repeat(64), size: 8192 } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { maxBlobBytes: 4096 } },
    })
  })

  test('requires authentication and a valid store', async () => {
    const user = await createUser(server, 'blob-auth@example.com')
    const anonymous = createClient(server.app)
    const unauthorized = await anonymous.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      body: JSON.stringify({ blob: { id: 'a'.repeat(64), size: 1 } }),
    })
    expect(unauthorized.status).toBe(401)

    const unknown = await user.client.request(
      '/v1/stores/01M2WAAP09R3A8HWSTNF3F0Y40/blobs/presign',
      {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ blob: { id: 'a'.repeat(64), size: 1 } }),
      },
    )
    expect(unknown.status).toBe(404)
  })
})

describe('uploading through the presigned URL', () => {
  test('accepts exact bytes and rejects a different length', async () => {
    const user = await createUser(server, 'blob-upload@example.com')
    const bytes = bytesFor('exact bytes here')
    const { body } = await presign(user, blobIdFor(bytes), bytes.byteLength)
    const wrong = await user.client.request(pathOf(body.url), {
      method: 'PUT',
      body: bytesFor('wrong'),
    })
    expect(wrong.status).toBe(400)
    expect(await wrong.json()).toMatchObject({ error: { details: { declared: bytes.byteLength } } })

    const right = await user.client.request(pathOf(body.url), { method: 'PUT', body: bytes })
    expect(right.status).toBe(200)
  })

  test('rejects bytes that do not match the presigned sha256', async () => {
    const user = await createUser(server, 'blob-checksum@example.com')
    const honest = bytesFor('checksum-one')
    const forged = bytesFor('checksum-two')
    expect(forged.byteLength).toBe(honest.byteLength)
    const { body } = await presign(user, blobIdFor(honest), honest.byteLength)
    const response = await user.client.request(pathOf(body.url), { method: 'PUT', body: forged })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { reason: 'blob_checksum_mismatch' } },
    })

    // The object was never written, so a download for the row 404s.
    const meta = await user.client.json<{ url: string }>(
      `/v1/stores/${user.storeId}/blobs/${blobIdFor(honest)}`,
      { headers: authHeaders(user.token) },
    )
    const download = await user.client.request(pathOf(meta.url))
    expect(download.status).toBe(404)
  })

  test('rejects a tampered signature or key', async () => {
    const user = await createUser(server, 'blob-tamper@example.com')
    const bytes = bytesFor('signed bytes')
    const { body } = await presign(user, blobIdFor(bytes), bytes.byteLength)
    const tampered = new URL(body.url)
    tampered.searchParams.set('sig', `${tampered.searchParams.get('sig')}x`)
    const response = await user.client.request(pathOf(tampered.toString()), {
      method: 'PUT',
      body: bytes,
    })
    expect(response.status).toBe(400)

    const wrongKey = new URL(body.url)
    wrongKey.searchParams.set('key', `u/${user.storeId}/b/${'0'.repeat(64)}`)
    const moved = await user.client.request(pathOf(wrongKey.toString()), {
      method: 'PUT',
      body: bytes,
    })
    expect(moved.status).toBe(400)
  })

  test('rejects an expired link', async () => {
    const user = await createUser(server, 'blob-expired@example.com')
    if (server.env.storage.kind !== 'fs') throw new Error('tests use the filesystem store')
    const bytes = bytesFor('too late')
    const id = blobIdFor(bytes)
    await presign(user, id, bytes.byteLength)
    const key = `u/${user.storeId}/b/${id}`
    const expires = Date.now() - 1000
    const signature = createHmac('sha256', server.env.storage.secret)
      .update(`put:${key}:${expires}:${id}`)
      .digest('base64url')
    const response = await user.client.request(
      `/local-blob/put?key=${encodeURIComponent(key)}&expires=${expires}&sha256=${id}&sig=${signature}&size=${bytes.byteLength}`,
      { method: 'PUT', body: bytes },
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('link expired')
  })
})

describe('GET /v1/stores/:id/blobs/:blobId', () => {
  test('returns a download URL whose bytes match the upload', async () => {
    const user = await createUser(server, 'blob-download@example.com')
    const bytes = bytesFor('download me exactly')
    const id = await upload(user, bytes)
    const body = await user.client.json<{ url: string; size: number; blobId: string }>(
      `/v1/stores/${user.storeId}/blobs/${id}`,
      { headers: authHeaders(user.token) },
    )
    expect(body.size).toBe(bytes.byteLength)
    const download = await user.client.request(pathOf(body.url))
    expect(download.status).toBe(200)
    expect(Array.from(new Uint8Array(await download.arrayBuffer()))).toEqual(Array.from(bytes))
  })

  test('404s when the row exists but the object was never uploaded', async () => {
    const user = await createUser(server, 'blob-ghost@example.com')
    const bytes = bytesFor('never uploaded')
    const id = blobIdFor(bytes)
    await presign(user, id, bytes.byteLength)
    const meta = await user.client.json<{ url: string }>(`/v1/stores/${user.storeId}/blobs/${id}`, {
      headers: authHeaders(user.token),
    })
    const download = await user.client.request(pathOf(meta.url))
    expect(download.status).toBe(404)
  })

  test('does not serve blobs across stores or accounts', async () => {
    const alice = await createUser(server, 'blob-alice@example.com')
    const bob = await createUser(server, 'blob-bob@example.com')
    const bytes = bytesFor('alice only')
    const id = await upload(alice, bytes)

    const bobInAliceStore = await bob.client.request(`/v1/stores/${alice.storeId}/blobs/${id}`, {
      headers: authHeaders(bob.token),
    })
    expect(bobInAliceStore.status).toBe(403)

    const aliceBlobInBobStore = await bob.client.request(`/v1/stores/${bob.storeId}/blobs/${id}`, {
      headers: authHeaders(bob.token),
    })
    expect(aliceBlobInBobStore.status).toBe(404)
  })

  test('404s for an unknown blob id in the caller own store', async () => {
    const user = await createUser(server, 'blob-unknown@example.com')
    const response = await user.client.request(
      `/v1/stores/${user.storeId}/blobs/${'f'.repeat(64)}`,
      { headers: authHeaders(user.token) },
    )
    expect(response.status).toBe(404)
  })
})
