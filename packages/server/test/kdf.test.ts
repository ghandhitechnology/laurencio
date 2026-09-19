import { afterAll, describe, expect, test } from 'bun:test'
import { and, eq } from 'drizzle-orm'
import { kdfParamVersions } from '../src/db/schema'
import { authHeaders, createTestServer, createUser } from './helpers'

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
    const written = await user.client.json<{ kdf: typeof params; generation: number }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ ...params, generation: null }),
      },
    )
    expect(written.kdf).toEqual(params)
    expect(written.generation).toBe(1)

    const read = await user.client.json<{ kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(read.kdf).toEqual(params)
  })

  test('the first write requires a null generation', async () => {
    const user = await createUser(server, 'kdf-first-write@example.com')
    const premature = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: 1 }),
    })
    expect(premature.status).toBe(409)
    const body = (await premature.json()) as {
      error: { code: string; details?: { generation: number | null } }
    }
    expect(body.error.code).toBe('conflict')
    expect(body.error.details?.generation).toBeNull()
  })

  test('a stale generation is rejected with the current generation and changes nothing', async () => {
    const user = await createUser(server, 'kdf-stale@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: null }),
    })
    const rotated = { ...params, salt: 'b3RoZXItc2FsdC1vdGhlcg==' }
    const stale = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...rotated, generation: 2 }),
    })
    expect(stale.status).toBe(409)
    const conflictBody = (await stale.json()) as {
      error: { code: string; details?: { generation: number } }
    }
    expect(conflictBody.error.code).toBe('conflict')
    expect(conflictBody.error.details?.generation).toBe(1)

    // Null is stale too once a row exists.
    const nullStale = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...rotated, generation: null }),
    })
    expect(nullStale.status).toBe(409)

    const read = await user.client.json<{ kdf: typeof params; generation: number }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(read.kdf).toEqual(params)
    expect(read.generation).toBe(1)
    const versions = await server.db
      .select()
      .from(kdfParamVersions)
      .where(eq(kdfParamVersions.storeId, user.storeId))
    expect(versions).toHaveLength(0)
  })

  test('a repeat write with identical values is a no-op', async () => {
    const user = await createUser(server, 'kdf-idempotent@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: null }),
    })
    const repeat = await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: 1 }),
    })
    expect(await repeat.json()).toMatchObject({ kdf: params, generation: 1 })
    // A retried first write still carries null and must not conflict.
    const retried = await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: null }),
    })
    expect(await retried.json()).toMatchObject({ kdf: params, generation: 1 })
  })

  test('a changed parameter set publishes a new generation and keeps the old one', async () => {
    const user = await createUser(server, 'kdf-rotate@example.com')
    const rotated = { ...params, salt: 'b3RoZXItc2FsdC1vdGhlcg==' }
    const first = await user.client.json<{ generation: number; kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ ...params, generation: null }),
      },
    )
    expect(first.generation).toBe(1)

    const second = await user.client.json<{ generation: number; kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ ...rotated, generation: 1 }),
      },
    )
    expect(second.generation).toBe(2)
    expect(second.kdf).toEqual(rotated)

    const latest = await user.client.json<{ generation: number; kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      { headers: authHeaders(user.token) },
    )
    expect(latest.generation).toBe(2)
    expect(latest.kdf).toEqual(rotated)

    // The superseded generation still resolves so an enrolling device that was
    // handed the old parameters can finish.
    const historical = await user.client.json<{ generation: number; kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params?version=1`,
      { headers: authHeaders(user.token) },
    )
    expect(historical.generation).toBe(1)
    expect(historical.kdf).toEqual(params)

    const latestByVersion = await user.client.json<{ generation: number; kdf: typeof params }>(
      `/v1/stores/${user.storeId}/kdf-params?version=2`,
      { headers: authHeaders(user.token) },
    )
    expect(latestByVersion.kdf).toEqual(rotated)

    const missing = await user.client.request(`/v1/stores/${user.storeId}/kdf-params?version=9`, {
      headers: authHeaders(user.token),
    })
    expect(missing.status).toBe(404)

    const me = await user.client.json<{ kdf: typeof params; kdfGeneration: number }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(me.kdf).toEqual(rotated)
    expect(me.kdfGeneration).toBe(2)

    const auditRows = await server.db
      .select()
      .from(kdfParamVersions)
      .where(and(eq(kdfParamVersions.storeId, user.storeId), eq(kdfParamVersions.generation, 1)))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0]?.salt).toBe(params.salt)
  })

  test('rejects Argon2id parameters below the minimum and outside the maximum', async () => {
    const user = await createUser(server, 'kdf-bounds@example.com')
    const put = (patch: Record<string, unknown>) =>
      user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ ...params, generation: null, ...patch }),
      })
    expect((await put({ m: 19_455 })).status).toBe(400)
    expect((await put({ t: 1 })).status).toBe(400)
    expect((await put({ p: 0 })).status).toBe(400)
    expect((await put({ m: 4_000_001 })).status).toBe(400)
    expect((await put({ t: 101 })).status).toBe(400)
    expect((await put({ p: 65 })).status).toBe(400)
    // The minimum is accepted.
    const accepted = await user.client.json<{ generation: number }>(
      `/v1/stores/${user.storeId}/kdf-params`,
      {
        method: 'PUT',
        headers: authHeaders(user.token),
        body: JSON.stringify({ ...params, m: 19_456, t: 2, p: 1, generation: null }),
      },
    )
    expect(accepted.generation).toBe(1)
  })

  test('a second device of the same user sees the same parameters', async () => {
    const user = await createUser(server, 'kdf-devices@example.com')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, generation: null }),
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
      body: JSON.stringify({ ...params, salt: 'short', generation: null }),
    })
    expect(shortSalt.status).toBe(400)

    const absurd = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ ...params, m: 999_999_999, generation: null }),
    })
    expect(absurd.status).toBe(400)

    const missingGeneration = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    expect(missingGeneration.status).toBe(400)

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
      body: JSON.stringify({ ...params, generation: null }),
    })
    expect(write.status).toBe(403)

    const unknown = await bob.client.request('/v1/stores/01M2WAAP09R3A8HWSTNF3F0Y40/kdf-params', {
      headers: authHeaders(bob.token),
    })
    expect(unknown.status).toBe(404)
  })
})
