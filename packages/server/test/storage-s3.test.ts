import { afterAll, describe, expect, test } from 'bun:test'
import { createS3Client, S3BlobStore } from '../src/storage/s3'

const requests: Array<{ method: string; path: string }> = []

const fakeS3 = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    requests.push({ method: request.method, path: url.pathname })
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 404,
        headers: { 'content-type': 'application/xml' },
      })
    }
    if (request.method === 'DELETE') return new Response(null, { status: 204 })
    return new Response(null, { status: 500 })
  },
})

const config = {
  kind: 's3' as const,
  bucket: 'laurencio-test',
  region: 'auto',
  endpoint: `http://127.0.0.1:${fakeS3.port}`,
  accessKeyId: 'test-key-id',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
}

const store = new S3BlobStore(config, createS3Client(config))

afterAll(() => {
  fakeS3.stop(true)
})

describe('s3 presigning', () => {
  test('a put URL signs the key, size, and expiry', async () => {
    const upload = await store.presignPut({
      key: 'u/store-one/b/blob-one',
      size: 128,
      expiresInSeconds: 600,
    })
    const url = new URL(upload.url)
    expect(upload.method).toBe('PUT')
    expect(upload.headers['content-type']).toBe('application/octet-stream')
    expect(upload.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(url.pathname).toBe('/laurencio-test/u/store-one/b/blob-one')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600')
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('content-length')
  })

  test('a get URL signs the key and expiry without a body', async () => {
    const download = await store.presignGet({ key: 'u/store-one/b/blob-two', expiresInSeconds: 60 })
    const url = new URL(download.url)
    expect(url.pathname).toBe('/laurencio-test/u/store-one/b/blob-two')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toContain('host')
  })
})

describe('s3 object operations', () => {
  test('head reports absence instead of throwing', async () => {
    expect(await store.head('u/store-one/b/missing')).toBeNull()
    expect(requests.at(-1)?.method).toBe('HEAD')
  })

  test('delete treats a missing object as success', async () => {
    await store.delete('u/store-one/b/blob-one')
    expect(requests.at(-1)).toEqual({
      method: 'DELETE',
      path: '/laurencio-test/u/store-one/b/blob-one',
    })
  })
})
