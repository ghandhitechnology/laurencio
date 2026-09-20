import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, StoreId } from '@laurencio/protocol'
import { deriveMasterKey, type KdfParams } from '../src/crypto/kdf'
import type { CredentialStore } from '../src/crypto/keyring'
import { openKeyCache } from '../src/crypto/keyring'
import { DeviceAuthError } from '../src/remote/http'
import {
  CredentialsError,
  clearCredentials,
  loadCredentials,
  loginWithDeviceCode,
  openTokenStore,
  refreshCredentials,
  storeCredentials,
} from '../src/sync/credentials'

const storeId = StoreId.parse('00000000000000000000000001')
const deviceId = DeviceId.parse('00000000000000000000000002')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}

interface MemoryStore extends CredentialStore {
  readonly entries: Map<string, Uint8Array>
}

function memoryStore(): MemoryStore {
  const entries = new Map<string, Uint8Array>()
  const key = (service: string, account: string): string => `${service}\u0000${account}`
  return {
    backend: 'keychain',
    entries,
    get: async (service, account) => entries.get(key(service, account))?.slice() ?? null,
    set: async (service, account, secret) => {
      entries.set(key(service, account), secret.slice())
    },
    delete: async (service, account) => {
      entries.delete(key(service, account))
    },
  }
}

function tempHome(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-credentials-'))
}

function identity() {
  return {
    version: 1 as const,
    deviceId,
    storeId,
    name: 'test-laptop',
    platform: 'darwin' as const,
    createdAt: '2026-09-19T00:00:00.000Z',
  }
}

interface Route {
  status?: number
  body: unknown
}

function mockFetch(routes: Record<string, Route | Route[]>): typeof fetch {
  const remaining = new Map<string, Route[]>()
  for (const [key, value] of Object.entries(routes)) {
    remaining.set(key, Array.isArray(value) ? [...value] : [value])
  }
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? 'GET'
    const pathname = new URL(url).pathname
    const queue = remaining.get(`${method} ${url}`) ?? remaining.get(`${method} ${pathname}`)
    const route = queue?.shift()
    if (route === undefined) return new Response('no route', { status: 404 })
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return impl as unknown as typeof fetch
}

const baseUrl = 'http://server.test'
const codeResponse = {
  device_code: 'device-code-1',
  user_code: 'ABCD-EFGH',
  verification_uri: `${baseUrl}/device`,
  verification_uri_complete: `${baseUrl}/device?user_code=ABCD-EFGH`,
  expires_in: 600,
  interval: 0,
}

describe('sync credentials', () => {
  test('stores and loads the identity, token, and cached key', async () => {
    const home = tempHome()
    const store = memoryStore()
    const token = 'lrn_secret-token-value'
    const backend = await storeCredentials(
      { home, keychain: store },
      { identity: identity(), token },
    )
    expect(backend).toBe('keychain')
    const key = deriveMasterKey('passphrase', kdf)
    const cache = await openKeyCache({ home, keychain: store })
    expect(await cache.save(storeId, key)).toBe('keychain')

    const credentials = await loadCredentials({ home, keychain: store })
    expect(credentials.deviceId).toBe(deviceId)
    expect(credentials.storeId).toBe(storeId)
    expect(credentials.token).toBe(token)
    expect(credentials.key.borrow()).toEqual(key.borrow())
    expect(credentials.backend).toBe('keychain')

    const deviceFile = fs.readFileSync(path.join(home, '.laurencio', 'device.json'), 'utf8')
    expect(deviceFile).not.toContain(token)
  })

  test('fails with distinct codes for a missing device, token, or key', async () => {
    const home = tempHome()
    const store = memoryStore()
    try {
      await loadCredentials({ home, keychain: store })
      throw new Error('expected not-enrolled')
    } catch (error) {
      expect(error).toBeInstanceOf(CredentialsError)
      expect((error as CredentialsError).code).toBe('not-enrolled')
    }

    await storeCredentials({ home, keychain: store }, { identity: identity(), token: 'lrn_x' })
    try {
      await loadCredentials({ home, keychain: store })
      throw new Error('expected missing-key')
    } catch (error) {
      expect((error as CredentialsError).code).toBe('missing-key')
    }

    const keyStore = memoryStore()
    const emptyHome = tempHome()
    await storeCredentials(
      { home: emptyHome, keychain: keyStore },
      { identity: identity(), token: 'lrn_x' },
    )
    const cache = await openKeyCache({ home: emptyHome, keychain: keyStore })
    await cache.save(storeId, deriveMasterKey('passphrase', kdf))
    keyStore.entries.clear()
    try {
      await loadCredentials({ home: emptyHome, keychain: keyStore })
      throw new Error('expected missing-token')
    } catch (error) {
      expect((error as CredentialsError).code).toBe('missing-token')
    }
  })

  test('falls back to a 0600 token file when no keychain is available', async () => {
    const home = tempHome()
    const options = { home, keychain: null, allowFileFallback: true }
    const tokenStore = await openTokenStore(options)
    expect(tokenStore.backend).toBe('file')
    await storeCredentials(options, { identity: identity(), token: 'lrn_file-token' })

    const tokenFile = path.join(
      home,
      '.laurencio',
      'tokens',
      'device-token_00000000000000000000000002.token',
    )
    expect(fs.statSync(tokenFile).mode & 0o777).toBe(0o600)
    const cache = await openKeyCache({ home, keychain: null, allowFileFallback: true })
    await cache.save(storeId, deriveMasterKey('passphrase', kdf))
    const credentials = await loadCredentials(options)
    expect(credentials.token).toBe('lrn_file-token')
    expect(credentials.backend).toBe('file')

    await clearCredentials({ ...options, deviceId })
    await expect(loadCredentials(options)).rejects.toMatchObject({ code: 'not-enrolled' })
    expect(fs.existsSync(tokenFile)).toBe(false)
  })

  test('drives the device flow from code request to stored token', async () => {
    const home = tempHome()
    const store = memoryStore()
    const prompts: string[] = []
    const sleeps: number[] = []
    const routedFetch = mockFetch({
      'POST /api/auth/device/code': { body: codeResponse },
      'POST /api/auth/device/token': [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 400, body: { error: 'slow_down' } },
        { body: { access_token: 'session-token' } },
      ],
      'POST /v1/devices': {
        status: 201,
        body: {
          protocolVersion: 1,
          device: {
            id: deviceId,
            name: 'test-laptop',
            platform: 'darwin',
            createdAt: '2026-09-19T00:00:00.000Z',
          },
          token: 'lrn_minted-token',
        },
      },
      'GET /v1/me': {
        body: {
          protocolVersion: 1,
          userId: '00000000000000000000000003',
          storeId,
          devices: [],
          kdf: null,
          quotas: { blobs: 0, bytes: 0, maxBytes: 100 },
        },
      },
    })
    const requests: { url: string; body: unknown }[] = []
    const fetchImpl = (async (input, init) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      requests.push({
        url,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return routedFetch(input, init)
    }) as typeof fetch
    const result = await loginWithDeviceCode({
      baseUrl,
      home,
      deviceName: 'test-laptop',
      platform: 'darwin',
      keychain: store,
      fetch: fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms)
      },
      onPrompt: (prompt) => {
        prompts.push(prompt.userCode)
      },
    })
    expect(prompts).toEqual(['ABCD-EFGH'])
    expect(result.identity.storeId).toBe(storeId)
    expect(result.identity.deviceId).toBe(deviceId)
    expect(result.backend).toBe('keychain')
    expect(sleeps).toEqual([0, 5000])
    expect(requests[0]).toEqual({
      url: `${baseUrl}/api/auth/device/code`,
      body: {
        client_id: 'laurencio-cli',
        device_name: 'test-laptop',
        platform: 'darwin',
      },
    })

    const credentials = await Promise.resolve(
      (async () => {
        const cache = await openKeyCache({ home, keychain: store })
        await cache.save(storeId, deriveMasterKey('passphrase', kdf))
        return loadCredentials({ home, keychain: store })
      })(),
    )
    expect(credentials.token).toBe('lrn_minted-token')
  })

  test('surfaces a denied device code and an expired one', async () => {
    const denied = loginWithDeviceCode({
      baseUrl,
      home: tempHome(),
      deviceName: 'laptop',
      platform: 'darwin',
      keychain: memoryStore(),
      fetch: mockFetch({
        'POST /api/auth/device/code': { body: codeResponse },
        'POST /api/auth/device/token': { status: 400, body: { error: 'access_denied' } },
      }),
    })
    await expect(denied).rejects.toMatchObject({ code: 'login-denied' })

    const expired = loginWithDeviceCode({
      baseUrl,
      home: tempHome(),
      deviceName: 'laptop',
      platform: 'darwin',
      keychain: memoryStore(),
      fetch: mockFetch({
        'POST /api/auth/device/code': { body: codeResponse },
        'POST /api/auth/device/token': { status: 400, body: { error: 'expired_token' } },
      }),
    })
    await expect(expired).rejects.toMatchObject({ code: 'login-expired' })
  })

  test('refresh verifies the cached credentials and reports revocation', async () => {
    const home = tempHome()
    const store = memoryStore()
    await storeCredentials({ home, keychain: store }, { identity: identity(), token: 'lrn_live' })
    const cache = await openKeyCache({ home, keychain: store })
    await cache.save(storeId, deriveMasterKey('passphrase', kdf))

    const healthy = mockFetch({
      'GET /v1/me': {
        body: {
          protocolVersion: 1,
          userId: '00000000000000000000000003',
          storeId,
          devices: [],
          kdf: null,
          quotas: { blobs: 0, bytes: 0, maxBytes: 100 },
        },
      },
    })
    const refreshed = await refreshCredentials({ home, keychain: store, baseUrl, fetch: healthy })
    expect(refreshed.token).toBe('lrn_live')

    const revoked = mockFetch({
      'GET /v1/me': {
        status: 401,
        body: {
          error: {
            code: 'unauthenticated',
            message: 'device token is unknown, revoked, or expired',
          },
        },
      },
    })
    await expect(
      refreshCredentials({ home, keychain: store, baseUrl, fetch: revoked }),
    ).rejects.toBeInstanceOf(DeviceAuthError)
  })
})
