import { afterAll, describe, expect, test } from 'bun:test'
import { createClient, createTestServer, createUser, readJson } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('protocol version negotiation', () => {
  test('a missing protocol version is rejected with an upgrade message', async () => {
    const client = createClient(server.app, { protocolHeader: false })
    const response = await client.request('/v1/me')
    expect(response.status).toBe(400)
    const body = await readJson<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe('protocol_mismatch')
    expect(body.error.message).toContain('x-laurencio-protocol-version')
    expect(body.error.message).toContain('protocol v1')
  })

  test('an empty protocol version is rejected', async () => {
    const client = createClient(server.app, { protocolHeader: false })
    const response = await client.request('/v1/me', {
      headers: { 'x-laurencio-protocol-version': '' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'protocol_mismatch' } })
  })

  test('a newer client version is told to upgrade the client', async () => {
    const user = await createUser(server, 'protocol@example.com')
    const response = await user.client.request('/v1/me', {
      headers: {
        authorization: `Bearer ${user.token}`,
        'x-laurencio-protocol-version': '2',
      },
    })
    expect(response.status).toBe(400)
    const body = await readJson<{ error: { code: string; message: string } }>(response)
    expect(body.error.code).toBe('protocol_mismatch')
    expect(body.error.message).toContain('Upgrade the client')
  })

  test('an older client version is told to upgrade the server', async () => {
    const user = await createUser(server, 'protocol-old@example.com')
    const response = await user.client.request('/v1/me', {
      headers: {
        authorization: `Bearer ${user.token}`,
        'x-laurencio-protocol-version': '0',
      },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'protocol_mismatch', message: expect.stringContaining('Upgrade the server') },
    })
  })

  test('non-numeric versions are rejected', async () => {
    const user = await createUser(server, 'protocol-nan@example.com')
    const response = await user.client.request('/v1/me', {
      headers: { authorization: `Bearer ${user.token}`, 'x-laurencio-protocol-version': 'one' },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'protocol_mismatch' } })
  })

  test('unknown routes answer with the protocol error shape', async () => {
    const client = createClient(server.app)
    const plain = await client.request('/nope')
    expect(plain.status).toBe(404)
    expect(await plain.json()).toMatchObject({ error: { code: 'not_found' } })

    const user = await createUser(server, 'protocol-404@example.com')
    const api = await user.client.request('/v1/nope', {
      headers: { authorization: `Bearer ${user.token}` },
    })
    expect(api.status).toBe(404)
    expect(await api.json()).toMatchObject({ error: { code: 'not_found' } })
  })

  test('invalid bodies answer with the protocol error shape', async () => {
    const user = await createUser(server, 'protocol-body@example.com')
    const response = await user.client.request('/v1/stores/not-a-store/blobs/presign', {
      method: 'POST',
      body: JSON.stringify({ blob: { id: 'not-a-hash', size: 1 } }),
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })

  test('paginated validation failures list issues', async () => {
    const user = await createUser(server, 'protocol-issues@example.com')
    const response = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      body: JSON.stringify({ blob: { id: 'x', size: -3 } }),
    })
    expect(response.status).toBe(400)
    const body = await readJson<{ error: { code: string; details?: { issues?: unknown[] } } }>(
      response,
    )
    expect(body.error.code).toBe('invalid_request')
    expect(Array.isArray(body.error.details?.issues)).toBe(true)
  })
})
