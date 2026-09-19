import { afterAll, describe, expect, test } from 'bun:test'
import { authHeaders, createTestServer, createUser, readJson } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

const params = {
  algo: 'argon2id',
  version: 1,
  salt: 'c2FsdHktc2FsdC1zYWx0eQ==',
  m: 65536,
  t: 3,
  p: 1,
  calibratedAt: '2026-09-19T00:00:00.000Z',
}

describe('KDF parameters', () => {
  test('are absent before the first write', async () => {
    const user = await createUser(server, 'kdf-empty@example.com')
    const body = await user.client.json<{ protocolVersion: number; kdf: unknown }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(body.protocolVersion).toBe(1)
    expect(body.kdf).toBeNull()
  })

  test('are written once and read back unchanged', async () => {
    const user = await createUser(server, 'kdf-write@example.com')
    const written = await user.client.json<{ kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { method: 'PUT', headers: authHeaders(user.token), body: JSON.stringify(params) },
    )
    expect(written.kdf).toEqual(params)

    const read = await user.client.json<{ kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(read.kdf).toEqual(params)
  })

  test('a repeat write with identical values is a no-op', async () => {
    const user = await createUser(server, 'kdf-idempotent@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    const repeat = await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    expect(await repeat.json()).toMatchObject({ kdf: params })
  })

  test('a different parameter set conflicts and the stored values survive', async () => {
    const user = await createUser(server, 'kdf-immutable@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    const changed = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, salt: 'b3RoZXItc2FsdC1vdGhlcg==' }),
    })
    expect(changed.status).toBe(409)
    const body = await readJson<{ error: { code: string; details?: { setAt?: string } } }>(changed)
    expect(body.error.code).toBe('conflict')
    expect(typeof body.error.details?.setAt).toBe('string')

    const read = await user.client.json<{ kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(read.kdf?.salt).toBe(params.salt)
  })

  test('a second device of the same user sees the same parameters', async () => {
    const user = await createUser(server, 'kdf-devices@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    const second = await user.client.json<{ token: string }>('/v1/devices', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'other', platform: 'linux' }),
    })
    const read = await user.client.json<{ kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(second.token) },
    )
    expect(read.kdf).toEqual(params)
  })

  test('rejects malformed parameters', async () => {
    const user = await createUser(server, 'kdf-invalid@example.com')
    const shortSalt = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, salt: 'short' }),
    })
    expect(shortSalt.status).toBe(400)

    const absurd = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, m: 999_999_999 }),
    })
    expect(absurd.status).toBe(400)

    const missing = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ algo: 'scrypt' }),
    })
    expect(missing.status).toBe(400)
  })

  test('another account cannot read or write the store', async () => {
    const alice = await createUser(server, 'kdf-alice@example.com')
    const bob = await createUser(server, 'kdf-bob@example.com')
    const read = await bob.client.request(`/v1/stores/${alice.storeId}/kdf-params`, {
      headers: authHeaders(bob.token),
    })
    expect(read.status).toBe(403)
    const write = await bob.client.request(`/v1/stores/${alice.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(bob.token),
      body: JSON.stringify(params),
    })
    expect(write.status).toBe(403)

    const unknown = await bob.client.request('/v1/stores/01M2WAAP09R3A8HWSTNF3F0Y40/kdf-params', {
      headers: authHeaders(bob.token),
    })
    expect(unknown.status).toBe(404)
  })
})
