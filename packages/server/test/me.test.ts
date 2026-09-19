import { afterAll, describe, expect, test } from 'bun:test'
import { createClient, createTestServer, createUser } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

interface MeBody {
  protocolVersion: number
  userId: string
  storeId: string
  devices: Array<{ id: string; name: string; platform: string }>
  kdf: unknown
  quotas: { blobs: number; bytes: number; maxBytes: number }
}

describe('GET /v1/me', () => {
  test('requires authentication', async () => {
    const client = createClient(server.app)
    const response = await client.request('/v1/me')
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'unauthenticated' } })
  })

  test('describes the account, store, devices, and empty usage', async () => {
    const user = await createUser(server, 'me@example.com', 'me-laptop')
    const me = await user.client.json<MeBody>('/v1/me', {
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(me.protocolVersion).toBe(1)
    expect(me.userId).toBe(user.userId)
    expect(me.storeId).toBe(user.storeId)
    expect(me.kdf).toBeNull()
    expect(me.devices.map((device) => device.id)).toContain(user.deviceId)
    expect(me.quotas).toEqual({ blobs: 0, bytes: 0, maxBytes: 512 * 1024 * 1024 })
  })

  test('keeps one store per user across calls and devices', async () => {
    const user = await createUser(server, 'one-store@example.com')
    const second = await user.client.json<{ device: { id: string }; token: string }>(
      '/v1/devices',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${user.token}` },
        body: JSON.stringify({ name: 'second', platform: 'linux' }),
      },
    )
    const me = await user.client.json<MeBody>('/v1/me', {
      headers: { authorization: `Bearer ${second.token}` },
    })
    expect(me.storeId).toBe(user.storeId)
    expect(me.devices).toHaveLength(2)
  })

  test('accepts a session cookie as well as a device token', async () => {
    const user = await createUser(server, 'session-me@example.com')
    const me = await user.client.json<MeBody>('/v1/me')
    expect(me.storeId).toBe(user.storeId)
  })
})
