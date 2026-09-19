import { describe, expect, test } from 'bun:test'
import { BlobId, DeviceId, RevisionId, StoreId } from '@laurencio/protocol'
import { sealText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import {
  createHttpRemote,
  DeviceAuthError,
  HttpRemoteError,
  ProtocolVersionError,
  QuotaExceededError,
} from '../src/remote/http'
import { RemoteError } from '../src/remote/types'

const baseUrl = 'http://server.test'
const storageUrl = 'http://storage.test'
const storeId = StoreId.parse('00000000000000000000000001')
const deviceId = DeviceId.parse('00000000000000000000000002')
const token = 'lrn_test-token'

const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const wireKdf = kdfParamsToWire(kdf, '2026-09-19T00:00:00.000Z')
const context = { storeId, blobType: 'file' as const, protocolVersion: 1 }
const key = deriveMasterKey('passphrase', kdf)

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string
}

interface MockServer {
  fetch: typeof fetch
  calls: Recorded[]
}

type Handler = (url: string, init: RequestInit, calls: Recorded[]) => Response | Promise<Response>

function makeFetch(routes: Record<string, Handler>): MockServer {
  const calls: Recorded[] = []
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    let body = ''
    if (typeof init?.body === 'string') body = init.body
    const recorded: Recorded = { url, method, headers, body }
    calls.push(recorded)
    const handler = routes[`${method} ${url}`] ?? routes[`${method} ${new URL(url).pathname}`]
    if (handler === undefined) return new Response('no route', { status: 404 })
    return handler(url, init ?? {}, calls)
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function errorBody(code: string, message: string, details?: Record<string, unknown>): Response {
  return json({ error: { code, message, ...(details ? { details } : {}) } }, 400)
}

function makeRemote(server: MockServer): ReturnType<typeof createHttpRemote> {
  return createHttpRemote({
    baseUrl,
    storeId,
    token,
    fetch: server.fetch,
  })
}

describe('HttpRemote', () => {
  test('sends the protocol and device token on /v1 and parses kdf params', async () => {
    const server = makeFetch({
      'GET /v1/stores/00000000000000000000000001/kdf-params': () =>
        json({ protocolVersion: 1, kdf: wireKdf }),
    })
    const remote = makeRemote(server)
    expect(await remote.getKdfParams()).toEqual(kdf)
    const call = server.calls[0]
    expect(call?.headers.get('authorization')).toBe(`Bearer ${token}`)
    expect(call?.headers.get('x-laurencio-protocol-version')).toBe('1')
  })

  test('returns null kdf before enrollment', async () => {
    const server = makeFetch({
      'GET /v1/stores/00000000000000000000000001/kdf-params': () =>
        json({ protocolVersion: 1, kdf: null }),
    })
    expect(await makeRemote(server).getKdfParams()).toBeNull()
  })

  test('lists revisions oldest first and fetches the manifest blob through the cache', async () => {
    const sealed = sealText(key, 'manifest', '{"revisionId":"r"}', {
      storeId,
      blobType: 'manifest',
      protocolVersion: 1,
    })
    const server = makeFetch({
      'GET /v1/stores/00000000000000000000000001/commits': () =>
        json({
          protocolVersion: 1,
          head: '00000000000000000000000009',
          revisions: [
            {
              id: '00000000000000000000000009',
              storeId,
              deviceId,
              parents: ['00000000000000000000000008'],
              manifest: { id: sealed.blobId, size: sealed.bytes.length },
              createdAt: '2026-09-19T00:00:02.000Z',
            },
            {
              id: '00000000000000000000000008',
              storeId,
              deviceId,
              parents: [],
              manifest: { id: sealed.blobId, size: sealed.bytes.length },
              createdAt: '2026-09-19T00:00:01.000Z',
            },
          ],
        }),
      [`GET /v1/stores/00000000000000000000000001/blobs/${sealed.blobId}`]: () =>
        json({
          protocolVersion: 1,
          blobId: sealed.blobId,
          size: sealed.bytes.length,
          url: `${storageUrl}/blob`,
          expiresAt: '2026-09-19T00:10:00.000Z',
        }),
      [`GET ${storageUrl}/blob`]: () => new Response(sealed.bytes),
    })
    const remote = makeRemote(server)
    const list = await remote.listRevisions()
    expect(String(list.head)).toBe('00000000000000000000000009')
    expect(list.revisions.map((revision) => String(revision.id))).toEqual([
      '00000000000000000000000008',
      '00000000000000000000000009',
    ])
    const manifest = await remote.getManifest(RevisionId.parse('00000000000000000000000009'))
    expect(manifest).toEqual(sealed.bytes)
  })

  test('presigns, uploads, and downloads blob ciphertext', async () => {
    const sealed = sealText(key, 'content', 'model = "gpt-5"\n', context)
    const uploadUrl = `${storageUrl}/upload/${sealed.blobId}`
    const downloadUrl = `${storageUrl}/download/${sealed.blobId}`
    const server = makeFetch({
      'POST /v1/stores/00000000000000000000000001/blobs/presign': () =>
        json({
          url: uploadUrl,
          method: 'PUT',
          expiresAt: '2026-09-19T00:10:00.000Z',
          headers: { 'content-type': 'application/octet-stream' },
          blobId: sealed.blobId,
        }),
      [`GET /v1/stores/00000000000000000000000001/blobs/${sealed.blobId}`]: () =>
        json({
          protocolVersion: 1,
          blobId: sealed.blobId,
          size: sealed.bytes.length,
          url: downloadUrl,
          expiresAt: '2026-09-19T00:10:00.000Z',
        }),
      [`PUT ${uploadUrl}`]: (_url, init) => {
        expect(Array.from(new Uint8Array(init.body as Uint8Array))).toEqual(
          Array.from(sealed.bytes),
        )
        return new Response(null, { status: 200 })
      },
      [`GET ${downloadUrl}`]: () => new Response(sealed.bytes),
    })
    const remote = makeRemote(server)
    const ref = await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
    expect(ref).toEqual({ id: sealed.blobId, size: sealed.bytes.length })
    const presign = server.calls.find((call) => call.url.includes('/blobs/presign'))
    expect(JSON.parse(presign?.body ?? '{}')).toEqual({
      blob: { id: sealed.blobId, size: sealed.bytes.length },
    })
    const put = server.calls.find((call) => call.method === 'PUT')
    expect(put?.headers.get('content-type')).toBe('application/octet-stream')
    expect(put?.headers.get('authorization')).toBeNull()
    expect(await remote.getBlob(sealed.blobId)).toEqual(sealed.bytes)
  })

  test('rejects a blob whose bytes do not match its id before uploading', async () => {
    const server = makeFetch({})
    const remote = makeRemote(server)
    const bytes = new Uint8Array([1, 2, 3])
    await expect(
      remote.putBlob({ blobId: BlobId.parse('0'.repeat(64)), bytes }),
    ).rejects.toMatchObject({ code: 'blob-mismatch' })
    expect(server.calls.length).toBe(0)
  })

  test('commits a revision and returns missing blobs without throwing', async () => {
    const missingId = BlobId.parse('b'.repeat(64))
    const server = makeFetch({
      'POST /v1/stores/00000000000000000000000001/commits': () =>
        json({ revisionId: '00000000000000000000000009', accepted: false, missing: [missingId] }),
    })
    const remote = makeRemote(server)
    const revisionId = RevisionId.parse('00000000000000000000000009')
    const result = await remote.commit({
      revision: {
        id: revisionId,
        storeId,
        deviceId,
        parents: [],
        manifest: { id: BlobId.parse('a'.repeat(64)), size: 10 },
        createdAt: '2026-09-19T00:00:00.000Z',
      },
      blobs: [],
      digest: [],
    })
    expect(result).toEqual({
      revisionId,
      accepted: false,
      missing: [missingId],
    })
    const call = server.calls[0]
    expect(call?.headers.get('x-laurencio-protocol-version')).toBe('1')
    expect(JSON.parse(call?.body ?? '{}').protocolVersion).toBe(1)
  })

  test('maps protocol errors onto typed classes', async () => {
    const unauthorized = makeRemote(
      makeFetch({
        'GET /v1/devices': () =>
          errorBody('unauthenticated', 'device token is unknown, revoked, or expired'),
      }),
    )
    await expect(unauthorized.listDevices()).rejects.toBeInstanceOf(DeviceAuthError)
    await expect(unauthorized.listDevices()).rejects.toMatchObject({
      code: 'unauthenticated',
      message: expect.stringContaining('laurencio login'),
    })

    const quota = makeRemote(
      makeFetch({
        'GET /v1/me': () =>
          json(
            {
              error: {
                code: 'quota_exceeded',
                message: 'store is over quota',
                details: { maxBytes: 100 },
              },
            },
            413,
          ),
      }),
    )
    try {
      await quota.getUsage()
      throw new Error('expected a quota failure')
    } catch (error) {
      expect(error).toBeInstanceOf(QuotaExceededError)
      expect((error as QuotaExceededError).details.maxBytes).toBe(100)
    }
  })

  test('surfaces a protocol mismatch with the upgrade message', async () => {
    const server = makeFetch({
      'GET /v1/stores/00000000000000000000000001/kdf-params': () =>
        errorBody(
          'protocol_mismatch',
          'server speaks protocol v2, this client speaks v1. Upgrade the client.',
        ),
    })
    const remote = createHttpRemote({
      baseUrl,
      storeId,
      token,
      fetch: server.fetch,
      protocolVersion: 2,
    })
    try {
      await remote.getKdfParams()
      throw new Error('expected a protocol mismatch')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolVersionError)
      expect((error as Error).message).toContain('Upgrade the client')
      expect((error as Error).message).toContain('protocol mismatch')
    }
  })

  test('retries 5xx with exponential backoff and stops after the attempt budget', async () => {
    let hits = 0
    const delays: number[] = []
    const server = makeFetch({
      'GET /v1/devices': () => {
        hits += 1
        if (hits < 3) return new Response('boom', { status: 503 })
        return json({ protocolVersion: 1, devices: [] })
      },
    })
    const remote = createHttpRemote({
      baseUrl,
      storeId,
      token,
      fetch: server.fetch,
      retry: { attempts: 3, baseDelayMs: 100, random: () => 1 },
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    expect(await remote.listDevices()).toEqual([])
    expect(hits).toBe(3)
    expect(delays).toEqual([100, 200])
  })

  test('honors Retry-After and the retryAfterSeconds detail on 429', async () => {
    let hits = 0
    const delays: number[] = []
    const server = makeFetch({
      'GET /v1/devices': () => {
        hits += 1
        if (hits === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'rate_limited',
                message: 'slow down',
                details: { retryAfterSeconds: 3 },
              },
            }),
            { status: 429, headers: { 'retry-after': '2' } },
          )
        }
        if (hits === 2) {
          return new Response(
            JSON.stringify({
              error: {
                code: 'rate_limited',
                message: 'slow down',
                details: { retryAfterSeconds: 4 },
              },
            }),
            { status: 429 },
          )
        }
        return json({ protocolVersion: 1, devices: [] })
      },
    })
    const remote = createHttpRemote({
      baseUrl,
      storeId,
      token,
      fetch: server.fetch,
      retry: { attempts: 3, baseDelayMs: 10, random: () => 1 },
      sleep: async (ms) => {
        delays.push(ms)
      },
    })
    await remote.listDevices()
    expect(delays).toEqual([2000, 4000])
  })

  test('reports an unreachable server as a retryable network error', async () => {
    let hits = 0
    const failing = (async () => {
      hits += 1
      throw new Error('Unable to connect')
    }) as unknown as typeof fetch
    const remote = createHttpRemote({
      baseUrl,
      storeId,
      token,
      fetch: failing,
      retry: { attempts: 2, baseDelayMs: 1, random: () => 1 },
      sleep: async () => {},
    })
    try {
      await remote.getKdfParams()
      throw new Error('expected an offline failure')
    } catch (error) {
      expect(error).toBeInstanceOf(HttpRemoteError)
      expect((error as HttpRemoteError).offline).toBe(true)
      expect((error as HttpRemoteError).retryable).toBe(true)
      expect(hits).toBe(2)
    }
  })

  test('does not retry a 400 or a missing revision', async () => {
    let hits = 0
    const server = makeFetch({
      'GET /v1/stores/00000000000000000000000001/kdf-params': () => {
        hits += 1
        return errorBody('invalid_request', 'bad request')
      },
    })
    const remote = makeRemote(server)
    await expect(remote.getKdfParams()).rejects.toBeInstanceOf(HttpRemoteError)
    expect(hits).toBe(1)

    const empty = makeRemote(
      makeFetch({
        'GET /v1/stores/00000000000000000000000001/commits': () =>
          json({ protocolVersion: 1, revisions: [], head: null }),
      }),
    )
    await expect(
      empty.getManifest(RevisionId.parse('00000000000000000000000009')),
    ).rejects.toBeInstanceOf(RemoteError)
  })
})
