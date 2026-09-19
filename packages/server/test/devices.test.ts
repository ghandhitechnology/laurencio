import { afterAll, describe, expect, test } from 'bun:test'
import { authHeaders, createClient, createTestServer, createUser } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('GET /v1/devices', () => {
  test('lists the account devices with their metadata', async () => {
    const user = await createUser(server, 'devices@example.com', 'primary-laptop')
    const body = await user.client.json<{
      protocolVersion: number
      devices: Array<{ id: string; name: string; platform: string; createdAt: string }>
    }>('/v1/devices', { headers: authHeaders(user.token) })
    expect(body.protocolVersion).toBe(1)
    expect(body.devices).toHaveLength(1)
    expect(body.devices[0]?.name).toBe('primary-laptop')
    expect(body.devices[0]?.platform).toBe('darwin')
    expect(new Date(body.devices[0]?.createdAt ?? '').getTime()).toBeGreaterThan(0)
  })

  test('does not leak another account device', async () => {
    const alice = await createUser(server, 'alice@example.com', 'alice-laptop')
    const bob = await createUser(server, 'bob@example.com', 'bob-laptop')
    const body = await bob.client.json<{ devices: Array<{ id: string }> }>('/v1/devices', {
      headers: authHeaders(bob.token),
    })
    expect(body.devices.map((device) => device.id)).not.toContain(alice.deviceId)
  })
})

describe('POST /v1/devices', () => {
  test('enrolls a device and returns a one-time token', async () => {
    const user = await createUser(server, 'enroll@example.com')
    const created = await user.client.json<{
      device: { id: string; name: string; platform: string }
      token: string
    }>('/v1/devices', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'new-machine', platform: 'linux' }),
    })
    expect(created.device.name).toBe('new-machine')
    expect(created.token.startsWith('lrn_')).toBe(true)
    // The new token works on its own.
    const me = await user.client.expectStatus('/v1/me', 200, {
      headers: authHeaders(created.token),
    })
    expect(me.status).toBe(200)
  })

  test('rejects a malformed body', async () => {
    const user = await createUser(server, 'bad-device@example.com')
    const response = await user.client.request('/v1/devices', {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: '', platform: 'darwin' }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  test('requires authentication', async () => {
    const client = createClient(server.app)
    const response = await client.request('/v1/devices', {
      method: 'POST',
      body: JSON.stringify({ name: 'sneaky', platform: 'darwin' }),
    })
    expect(response.status).toBe(401)
  })
})

describe('PATCH /v1/devices/:id', () => {
  test('renames the device', async () => {
    const user = await createUser(server, 'rename@example.com', 'old-name')
    const renamed = await user.client.json<{ device: { name: string } }>(
      `/v1/devices/${user.deviceId}`,
      {
        method: 'PATCH',
        headers: authHeaders(user.token),
        body: JSON.stringify({ name: 'new-name' }),
      },
    )
    expect(renamed.device.name).toBe('new-name')
    const list = await user.client.json<{ devices: Array<{ name: string }> }>('/v1/devices', {
      headers: authHeaders(user.token),
    })
    expect(list.devices[0]?.name).toBe('new-name')
  })

  test('refuses a long name and an unknown id', async () => {
    const user = await createUser(server, 'rename-bad@example.com')
    const long = await user.client.request(`/v1/devices/${user.deviceId}`, {
      method: 'PATCH',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'x'.repeat(200) }),
    })
    expect(long.status).toBe(400)

    const unknown = await user.client.request('/v1/devices/01M2WAAP09R3A8HWSTNF3F0Y40', {
      method: 'PATCH',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'ghost' }),
    })
    expect(unknown.status).toBe(404)
  })

  test("cannot rename another account's device", async () => {
    const alice = await createUser(server, 'alice-rename@example.com')
    const bob = await createUser(server, 'bob-rename@example.com')
    const response = await bob.client.request(`/v1/devices/${alice.deviceId}`, {
      method: 'PATCH',
      headers: authHeaders(bob.token),
      body: JSON.stringify({ name: 'stolen' }),
    })
    expect(response.status).toBe(404)
  })

  test('rejects an id that is not a laurencio id', async () => {
    const user = await createUser(server, 'rename-invalid@example.com')
    const response = await user.client.request('/v1/devices/not-an-id', {
      method: 'PATCH',
      headers: authHeaders(user.token),
      body: JSON.stringify({ name: 'nope' }),
    })
    expect(response.status).toBe(400)
  })
})

describe('DELETE /v1/devices/:id', () => {
  test('revokes the device and every token it holds', async () => {
    const user = await createUser(server, 'revoke@example.com', 'to-revoke')
    const watcher = await user.client.json<{ device: { id: string }; token: string }>(
      '/v1/devices',
      {
        method: 'POST',
        headers: authHeaders(user.token),
        body: JSON.stringify({ name: 'watcher', platform: 'linux' }),
      },
    )

    const revoked = await user.client.json<{ device: { revokedAt?: string } }>(
      `/v1/devices/${user.deviceId}`,
      { method: 'DELETE', headers: authHeaders(watcher.token) },
    )
    expect(revoked.device.revokedAt).toBeDefined()

    const after = await user.client.request('/v1/me', { headers: authHeaders(user.token) })
    expect(after.status).toBe(401)

    const list = await user.client.json<{ devices: Array<{ id: string; revokedAt?: string }> }>(
      '/v1/devices',
      { headers: authHeaders(watcher.token) },
    )
    const listed = list.devices.find((device) => device.id === user.deviceId)
    expect(listed?.revokedAt).toBeDefined()
    expect(
      list.devices.find((device) => device.id === watcher.device.id)?.revokedAt,
    ).toBeUndefined()
  })

  test("cannot revoke another account's device", async () => {
    const alice = await createUser(server, 'alice-revoke@example.com')
    const bob = await createUser(server, 'bob-revoke@example.com')
    const response = await bob.client.request(`/v1/devices/${alice.deviceId}`, {
      method: 'DELETE',
      headers: authHeaders(bob.token),
    })
    expect(response.status).toBe(404)
    // Alice's device still works.
    await alice.client.expectStatus('/v1/me', 200, { headers: authHeaders(alice.token) })
  })
})
