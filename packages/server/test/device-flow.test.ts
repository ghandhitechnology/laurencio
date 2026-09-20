import { afterAll, describe, expect, test } from 'bun:test'
import { eq, sql } from 'drizzle-orm'
import { deviceTokens } from '../src/db/schema'
import { hashToken, TOKEN_TTL_MS } from '../src/devices'
import {
  authHeaders,
  claimDeviceCode,
  createClient,
  createTestServer,
  enrollDevice,
  signInDev,
} from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('RFC 8628 device authorization', () => {
  test('issues a code, waits for approval, and exchanges it for a token', async () => {
    const client = createClient(server.app)
    const code = await client.json<{
      device_code: string
      user_code: string
      verification_uri: string
      expires_in: number
      interval: number
    }>('/api/auth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'laurencio-cli', scope: 'sync' }),
    })
    expect(code.user_code).toMatch(/^[A-Z2-9]{8}$/)
    expect(code.verification_uri).toBe('http://localhost:8787/device')
    expect(code.device_code.length).toBeGreaterThan(20)

    // Polling before approval is pending, not an error.
    const pending = await client.request('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'laurencio-cli',
      }),
    })
    expect(pending.status).toBe(400)
    expect(await pending.json()).toMatchObject({ error: 'authorization_pending' })

    // The user has to be signed in to claim and approve the code.
    const anonymous = await client.request('/api/auth/device/approve', {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    expect(anonymous.status).toBe(401)

    await signInDev(client, 'owner@example.com')
    // Approving without claiming the code first is refused.
    const unclaimed = await client.request('/api/auth/device/approve', {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    expect(unclaimed.status).toBe(400)

    await claimDeviceCode(client, code.user_code)
    const approved = await client.expectStatus('/api/auth/device/approve', 200, {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    expect(await approved.json()).toEqual({ success: true })

    const token = await client.json<{ access_token: string; token_type: string }>(
      '/api/auth/device/token',
      {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: 'laurencio-cli',
        }),
      },
    )
    expect(token.token_type).toBe('Bearer')
    expect(token.access_token.length).toBeGreaterThan(20)

    // The device code is one-time use.
    const reused = await client.request('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: 'laurencio-cli',
      }),
    })
    expect(reused.status).toBe(400)

    // The session token from the flow enrolls a device and mints its token.
    const enrolled = await client.json<{ device: { id: string; name: string }; token: string }>(
      '/v1/devices',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token.access_token}` },
        body: JSON.stringify({ name: 'studio', platform: 'darwin' }),
      },
    )
    expect(enrolled.token.startsWith('lrn_')).toBe(true)
    expect(enrolled.device.name).toBe('studio')

    const me = await client.json<{ userId: string; devices: unknown[] }>('/v1/me', {
      headers: { authorization: `Bearer ${enrolled.token}` },
    })
    expect(me.devices).toHaveLength(1)
  })

  test('rejects an unregistered client id', async () => {
    const client = createClient(server.app)
    const response = await client.request('/api/auth/device/code', {
      method: 'POST',
      body: JSON.stringify({ client_id: 'somebody-else' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'invalid_client' })
  })

  test('denying a code fails the poll with access_denied', async () => {
    const client = createClient(server.app)
    const code = await client.json<{ device_code: string; user_code: string }>(
      '/api/auth/device/code',
      { method: 'POST', body: JSON.stringify({ client_id: 'laurencio-cli' }) },
    )
    await signInDev(client, 'denier@example.com')
    await claimDeviceCode(client, code.user_code)
    await client.expectStatus('/api/auth/device/approve', 200, {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    const denied = await client.request('/api/auth/device/deny', {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    // Already approved, so denying is rejected as already processed.
    expect(denied.status).toBe(400)

    const other = await client.json<{ device_code: string; user_code: string }>(
      '/api/auth/device/code',
      { method: 'POST', body: JSON.stringify({ client_id: 'laurencio-cli' }) },
    )
    await claimDeviceCode(client, other.user_code)
    await client.expectStatus('/api/auth/device/deny', 200, {
      method: 'POST',
      body: JSON.stringify({ userCode: other.user_code }),
    })
    const polled = await client.request('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: other.device_code,
        client_id: 'laurencio-cli',
      }),
    })
    expect(polled.status).toBe(400)
    expect(await polled.json()).toMatchObject({ error: 'access_denied' })
  })

  test('expired codes are rejected', async () => {
    const expired = await createTestServer()
    try {
      const client = createClient(expired.app)
      const code = await client.json<{ device_code: string; user_code: string }>(
        '/api/auth/device/code',
        { method: 'POST', body: JSON.stringify({ client_id: 'laurencio-cli' }) },
      )
      await signInDev(client, 'slow@example.com')
      await claimDeviceCode(client, code.user_code)
      // Move the stored code into the past.
      await expired.db.execute(
        sql`update device_codes set expires_at = now() - interval '1 minute'`,
      )
      const verify = await client.request(
        `/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
      )
      expect(verify.status).toBe(400)
      const polled = await client.request('/api/auth/device/token', {
        method: 'POST',
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: 'laurencio-cli',
        }),
      })
      expect(polled.status).toBe(400)
      expect(await polled.json()).toMatchObject({ error: 'expired_token' })
    } finally {
      await expired.close()
    }
  })
})

describe('revoked device tokens', () => {
  test('a revoked device token fails the next call', async () => {
    const client = createClient(server.app)
    const device = await enrollDevice(client, { name: 'doomed' })

    const before = await client.expectStatus('/v1/me', 200, {
      headers: { authorization: `Bearer ${device.token}` },
    })
    expect(before.status).toBe(200)

    await client.expectStatus(`/v1/devices/${device.deviceId}`, 200, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${device.token}` },
    })

    const after = await client.request('/v1/me', {
      headers: { authorization: `Bearer ${device.token}` },
    })
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  test('unknown tokens are rejected', async () => {
    const client = createClient(server.app)
    const response = await client.request('/v1/me', {
      headers: { authorization: 'Bearer lrn_not-a-real-token' },
    })
    expect(response.status).toBe(401)
  })
})

describe('device token lifetime', () => {
  test('active devices renew a nearly expired token without changing its secret', async () => {
    const client = createClient(server.app)
    const device = await enrollDevice(client, { name: 'still-syncing' })
    await server.db
      .update(deviceTokens)
      .set({
        expiresAt: new Date(Date.now() + 60_000),
        lastUsedAt: new Date(Date.now() - 120_000),
      })
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))
    await client.expectStatus('/v1/me', 200, { headers: authHeaders(device.token) })
    const [renewed] = await server.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))
    expect((renewed?.expiresAt?.getTime() ?? 0) - Date.now()).toBeGreaterThan(TOKEN_TTL_MS - 60_000)
    await client.expectStatus('/v1/me', 200, { headers: authHeaders(device.token) })
    const [throttled] = await server.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))
    expect(throttled?.expiresAt).toEqual(renewed?.expiresAt)
  })

  test('mints a 90-day token and records last use', async () => {
    const client = createClient(server.app)
    const device = await enrollDevice(client, { name: 'expiring' })
    const rows = await server.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))
    expect(rows).toHaveLength(1)
    const expiresAt = rows[0]?.expiresAt
    const remaining = (expiresAt?.getTime() ?? 0) - Date.now()
    expect(remaining).toBeGreaterThan(TOKEN_TTL_MS - 60_000)
    expect(remaining).toBeLessThanOrEqual(TOKEN_TTL_MS)
    // Enrollment ends with a /v1/me call, which touches the token.
    expect(rows[0]?.lastUsedAt).not.toBeNull()
  })

  test('an expired token fails with the expired error, not a crash', async () => {
    const client = createClient(server.app)
    const device = await enrollDevice(client, { name: 'expired' })
    await server.db
      .update(deviceTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))

    const response = await client.request('/v1/me', { headers: authHeaders(device.token) })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({
      error: { code: 'unauthenticated', details: { reason: 'token_expired' } },
    })
    const [expired] = await server.db
      .select()
      .from(deviceTokens)
      .where(eq(deviceTokens.tokenHash, hashToken(device.token)))
    expect(expired?.expiresAt?.getTime()).toBeLessThan(Date.now())
  })
})
