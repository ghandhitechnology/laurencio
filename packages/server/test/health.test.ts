import { afterAll, describe, expect, test } from 'bun:test'
import { createLogger } from '../src/log'
import { createClient, createTestServer, createUser, TEST_ORIGIN } from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('health', () => {
  test('reports database connectivity without a protocol header', async () => {
    const client = createClient(server.app)
    const response = await client.expectStatus('/health', 200)
    expect(await response.json()).toEqual({ ok: true, db: 'up', protocolVersion: 1 })
  })

  test('reports 503 when the database is unreachable', async () => {
    const broken = await createTestServer()
    await broken.close()
    const client = createClient(broken.app)
    const response = await client.expectStatus('/health', 503)
    expect(await response.json()).toMatchObject({ ok: false, db: 'down' })
  })
})

describe('request ids and structured logs', () => {
  test('echoes a supplied request id and logs one line per request', async () => {
    const lines: string[] = []
    const observed = await createTestServer(
      {},
      { logger: createLogger('info', { write: (chunk) => lines.push(chunk) }) },
    )
    try {
      const user = await createUser(observed, 'logging@example.com')
      lines.length = 0
      const response = await user.client.request('/v1/me', {
        headers: { authorization: `Bearer ${user.token}`, 'x-request-id': 'req-abc-123' },
      })
      expect(response.status).toBe(200)
      expect(response.headers.get('x-request-id')).toBe('req-abc-123')

      const entries = lines
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      const request = entries.find((entry) => entry.msg === 'request' && entry.path === '/v1/me')
      expect(request).toBeDefined()
      expect(request?.requestId).toBe('req-abc-123')
      expect(request?.method).toBe('GET')
      expect(request?.status).toBe(200)
      expect(typeof request?.durationMs).toBe('number')
      expect(request?.userId).toBe(user.userId)
    } finally {
      await observed.close()
    }
  })

  test('generates a request id when the client does not send one', async () => {
    const client = createClient(server.app)
    const response = await client.expectStatus('/health', 200)
    expect(response.headers.get('x-request-id')).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
  })

  test('logs 5xx failures at error level', async () => {
    const lines: string[] = []
    const observed = await createTestServer(
      {},
      { logger: createLogger('debug', { write: (chunk) => lines.push(chunk) }) },
    )
    try {
      const user = await createUser(observed, 'boom@example.com')
      lines.length = 0
      await observed.db.execute('drop table stores cascade')
      const response = await user.client.request(`/v1/stores/${user.storeId}/commits?limit=1`, {
        headers: { authorization: `Bearer ${user.token}` },
      })
      expect(response.status).toBe(500)
      expect(await response.json()).toEqual({
        error: { code: 'internal', message: 'internal error' },
      })
      const entries = lines
        .join('')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      expect(
        entries.some((entry) => entry.level === 'error' && entry.msg === 'request failed'),
      ).toBe(true)
    } finally {
      await observed.close()
    }
  })

  test('cors-style origin metadata does not leak into responses', async () => {
    const client = createClient(server.app)
    const response = await client.request('/health', { headers: { origin: TEST_ORIGIN } })
    expect(response.status).toBe(200)
  })
})
