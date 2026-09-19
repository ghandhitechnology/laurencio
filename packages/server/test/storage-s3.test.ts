import { afterAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { createS3Client, S3BlobStore } from '../src/storage/s3'

const requests: Array<{ method: string; path: string }> = []
const checksumHex = 'ab'.repeat(32)

const fakeS3 = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    requests.push({ method: request.method, path: url.pathname })
    if (request.method === 'HEAD') {
      if (url.pathname.endsWith('/checksummed')) {
        return new Response(null, {
          status: 200,
          headers: {
            'content-length': '128',
            'x-amz-checksum-sha256': Buffer.from(checksumHex, 'hex').toString('base64'),
          },
        })
      }
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
      sha256: checksumHex,
      expiresInSeconds: 600,
    })
    const url = new URL(upload.url)
    expect(upload.method).toBe('PUT')
    expect(upload.headers['content-type']).toBe('application/octet-stream')
    // The checksum is verified at commit by hashing the stored object, so the
    // upload carries no checksum header that a storage could reject.
    expect(upload.headers['x-amz-checksum-sha256']).toBeUndefined()
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

  test('head reports the stored checksum metadata as hex', async () => {
    expect(await store.head('u/store-one/b/checksummed')).toEqual({
      size: 128,
      sha256: checksumHex,
    })
  })

  test('head hashes a small object when the storage reports no checksum', async () => {
    const body = Buffer.from('abcd')
    const expected = createHash('sha256').update(body).digest('hex')
    const plain = Bun.serve({
      port: 0,
      fetch: (request) =>
        new URL(request.url).pathname.includes('/b/plain')
          ? request.method === 'HEAD'
            ? new Response(null, { status: 200, headers: { 'content-length': String(body.length) } })
            : new Response(body, { status: 200 })
          : new Response(null, { status: 404 }),
    })
    try {
      const configWithPlain = { ...config, endpoint: `http://127.0.0.1:${plain.port}` }
      const plainStore = new S3BlobStore(configWithPlain, createS3Client(configWithPlain))
      expect(await plainStore.head('u/store-one/b/plain')).toEqual({
        size: body.length,
        sha256: expected,
      })
    } finally {
      plain.stop(true)
    }
  })

  test('delete treats a missing object as success', async () => {
    await store.delete('u/store-one/b/blob-one')
    expect(requests.at(-1)).toEqual({
      method: 'DELETE',
      path: '/laurencio-test/u/store-one/b/blob-one',
    })
  })
})
