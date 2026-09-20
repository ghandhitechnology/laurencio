import { afterAll, describe, expect, test } from 'bun:test'
import {
  newId,
  PROFILE_VERSION_HEADER,
  WorkbenchSessionCreateResponse,
  WorkbenchSessionListResponse,
} from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { auditLog } from '../src/db/schema'
import { authHeaders, blobIdFor, bytesFor, createTestServer, createUser, readJson } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('workbench sessions', () => {
  test('creates a temporary actor and lists the session without leaking its token', async () => {
    const user = await createUser(server, 'workbench-create@example.com')
    const before = Date.now()
    const response = await user.client.request('/v1/workbench-sessions', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'review sandbox', platform: 'linux' }),
    })
    expect(response.status).toBe(201)
    const created = WorkbenchSessionCreateResponse.parse(await response.json())
    expect(created.session.name).toBe('review sandbox')
    expect(created.session.deviceId).not.toBe(created.session.id)
    expect(created.token.startsWith('lrn_')).toBe(true)
    expect(new Date(created.session.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * 60 * 1000,
    )

    await user.client.expectStatus('/v1/me', 200, { headers: authHeaders(created.token) })

    const listed = WorkbenchSessionListResponse.parse(
      await user.client.json('/v1/workbench-sessions', { headers: authHeaders(user.token) }),
    )
    expect(listed.sessions.map((session) => session.id)).toContain(created.session.id)
    expect(JSON.stringify(listed)).not.toContain(created.token)

    const devices = await user.client.json<{ devices: Array<{ id: string }> }>('/v1/devices', {
      headers: authHeaders(user.token),
    })
    expect(devices.devices.map((device) => device.id)).not.toContain(created.session.deviceId)
  })

  test('clamps the requested lifetime to the supported range', async () => {
    const user = await createUser(server, 'workbench-ttl@example.com')
    const before = Date.now()
    const short = await user.client.request('/v1/workbench-sessions', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'too short', platform: 'linux', expiresInSeconds: 60 }),
    })
    expect(short.status).toBe(201)
    const shortBody = WorkbenchSessionCreateResponse.parse(await short.json())
    expect(new Date(shortBody.session.expiresAt).getTime()).toBeGreaterThanOrEqual(
      before + 60 * 60 * 1000,
    )

    const long = WorkbenchSessionCreateResponse.parse(
      await user.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          name: 'too long',
          platform: 'linux',
          expiresInSeconds: 30 * 24 * 60 * 60,
        }),
      }),
    )
    expect(new Date(long.session.expiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + 7 * 24 * 60 * 60 * 1000,
    )
  })

  test('closes idempotently and immediately rejects the temporary token', async () => {
    const user = await createUser(server, 'workbench-close@example.com')
    const created = WorkbenchSessionCreateResponse.parse(
      await user.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({
          name: 'throwaway shell',
          platform: 'linux',
          expiresInSeconds: 3600,
        }),
      }),
    )
    const first = await user.client.json<{ session: { closedAt?: string } }>(
      `/v1/workbench-sessions/${created.session.id}`,
      { method: 'DELETE', headers: authHeaders(created.token) },
    )
    expect(first.session.closedAt).toBeDefined()
    const second = await user.client.json<{ session: { closedAt?: string } }>(
      `/v1/workbench-sessions/${created.session.id}`,
      { method: 'DELETE', headers: authHeaders(user.token) },
    )
    expect(second.session.closedAt).toBe(first.session.closedAt)

    const after = await user.client.request('/v1/me', { headers: authHeaders(created.token) })
    expect(after.status).toBe(401)
  })

  test("cannot close another account's session", async () => {
    const alice = await createUser(server, 'workbench-alice@example.com')
    const bob = await createUser(server, 'workbench-bob@example.com')
    const created = WorkbenchSessionCreateResponse.parse(
      await alice.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify({ name: 'alice sandbox', platform: 'linux' }),
      }),
    )
    const response = await bob.client.request(`/v1/workbench-sessions/${created.session.id}`, {
      method: 'DELETE',
      headers: authHeaders(bob.token),
    })
    expect(response.status).toBe(404)
    await alice.client.expectStatus('/v1/me', 200, { headers: authHeaders(created.token) })
  })

  test('rejects a temporary token after its session expires', async () => {
    let current = new Date('2026-09-20T00:00:00.000Z')
    const expiringServer = await createTestServer({}, { now: () => current })
    try {
      const user = await createUser(expiringServer, 'workbench-expired@example.com')
      const created = WorkbenchSessionCreateResponse.parse(
        await user.client.json('/v1/workbench-sessions', {
          method: 'POST',
          headers: authHeaders(user.token),
          body: JSON.stringify({
            name: 'short sandbox',
            platform: 'linux',
            expiresInSeconds: 3600,
          }),
        }),
      )
      current = new Date('2026-09-20T01:00:00.001Z')
      const response = await user.client.request('/v1/me', {
        headers: authHeaders(created.token),
      })
      expect(response.status).toBe(401)
      expect(await readJson<{ error: { details?: { reason?: string } } }>(response)).toMatchObject({
        error: { details: { reason: 'token_expired' } },
      })
    } finally {
      await expiringServer.close()
    }
  })

  test('audits session creation and the first close', async () => {
    const user = await createUser(server, 'workbench-audit@example.com')
    const created = WorkbenchSessionCreateResponse.parse(
      await user.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ name: 'audited sandbox', platform: 'linux' }),
      }),
    )
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await user.client.expectStatus(`/v1/workbench-sessions/${created.session.id}`, 200, {
        method: 'DELETE',
        headers: authHeaders(user.token),
      })
    }
    const entries = await server.db
      .select({ action: auditLog.action, deviceId: auditLog.deviceId })
      .from(auditLog)
      .where(eq(auditLog.subject, created.session.id))
    expect(entries).toEqual([
      { action: 'workbench_session.create', deviceId: created.session.deviceId },
      { action: 'workbench_session.close', deviceId: created.session.deviceId },
    ])
  })

  test('limits temporary actors to materialization, selective save, and closing themselves', async () => {
    const user = await createUser(server, 'workbench-capabilities@example.com')
    const fullHeaders = { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' }
    await user.client.expectStatus(`/v1/stores/${user.storeId}/profile-version`, 200, {
      method: 'PUT',
      headers: fullHeaders,
      body: JSON.stringify({ expectedVersion: 1, profileVersion: 2 }),
    })
    const created = WorkbenchSessionCreateResponse.parse(
      await user.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ name: 'bounded sandbox', platform: 'darwin' }),
      }),
    )
    const sibling = WorkbenchSessionCreateResponse.parse(
      await user.client.json('/v1/workbench-sessions', {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ name: 'sibling sandbox', platform: 'darwin' }),
      }),
    )
    const temporaryHeaders = {
      ...authHeaders(created.token),
      [PROFILE_VERSION_HEADER]: '2',
    }

    for (const [path, method, body] of [
      ['/v1/devices', 'POST', { name: 'escaped device', platform: 'darwin' }],
      [`/v1/devices/${user.deviceId}`, 'PATCH', { name: 'renamed by sandbox' }],
      [`/v1/stores/${user.storeId}/kdf-params`, 'PUT', {}],
      [
        `/v1/stores/${user.storeId}/profile-version`,
        'PUT',
        { expectedVersion: 1, profileVersion: 2 },
      ],
      [`/v1/stores/${user.storeId}/profile`, 'PUT', {}],
      ['/v1/workbench-sessions', 'POST', { name: 'nested sandbox', platform: 'darwin' }],
    ] as const) {
      await user.client.expectStatus(path, 403, {
        method,
        headers: temporaryHeaders,
        body: JSON.stringify(body),
      })
    }
    await user.client.expectStatus('/v1/devices', 403, { headers: temporaryHeaders })
    await user.client.expectStatus('/v1/workbench-sessions', 403, {
      headers: temporaryHeaders,
    })
    await user.client.expectStatus(`/v1/workbench-sessions/${sibling.session.id}`, 404, {
      method: 'DELETE',
      headers: temporaryHeaders,
    })
    await user.client.expectStatus('/v1/me', 200, { headers: authHeaders(sibling.token) })

    for (const path of [
      '/v1/me',
      `/v1/stores/${user.storeId}/kdf-params`,
      `/v1/stores/${user.storeId}/profile-version`,
      `/v1/stores/${user.storeId}/profile`,
      `/v1/stores/${user.storeId}/vault`,
      `/v1/stores/${user.storeId}/commits`,
    ]) {
      await user.client.expectStatus(path, 200, { headers: temporaryHeaders })
    }

    const ciphertext = bytesFor('temporary actor opaque save')
    const blobId = blobIdFor(ciphertext)
    const presign = await user.client.json<{ url: string }>(
      `/v1/stores/${user.storeId}/blobs/presign`,
      {
        method: 'POST',
        headers: temporaryHeaders,
        body: JSON.stringify({ blob: { id: blobId, size: ciphertext.byteLength } }),
      },
    )
    const uploadUrl = new URL(presign.url)
    await user.client.expectStatus(`${uploadUrl.pathname}${uploadUrl.search}`, 200, {
      method: 'PUT',
      body: ciphertext,
    })
    await user.client.expectStatus(`/v1/stores/${user.storeId}/vault`, 200, {
      method: 'PUT',
      headers: temporaryHeaders,
      body: JSON.stringify({
        blob: { id: blobId, size: ciphertext.byteLength },
        expectedGeneration: null,
      }),
    })
    await user.client.expectStatus(`/v1/stores/${user.storeId}/commits`, 201, {
      method: 'POST',
      headers: temporaryHeaders,
      body: JSON.stringify({
        protocolVersion: 1,
        revision: {
          id: newId(),
          storeId: user.storeId,
          deviceId: created.session.deviceId,
          parents: [],
          manifest: { id: blobId, size: ciphertext.byteLength },
          createdAt: '2026-09-20T00:00:00.000Z',
        },
        blobs: [],
      }),
    })
  })
})
