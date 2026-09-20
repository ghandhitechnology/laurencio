import { describe, expect, test } from 'bun:test'
import { DeviceId, StoreId, type WorkbenchSession, WorkbenchSessionId } from '@laurencio/protocol'
import { createWorkbenchClient } from '../src/workbench/client'

const session: WorkbenchSession = {
  id: WorkbenchSessionId.parse('00000000000000000000000001'),
  deviceId: DeviceId.parse('00000000000000000000000002'),
  name: 'temporary on find',
  platform: 'win32',
  createdAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-21T00:00:00.000Z',
}

describe('workbench HTTP client', () => {
  test('creates, lists, and closes expiring actors without retaining their token', async () => {
    const requests: { method: string; path: string; auth: string | null; body: unknown }[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string' ? input : input instanceof URL ? input : input.url,
      )
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        path: url.pathname,
        auth: new Headers(init?.headers).get('authorization'),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (method === 'POST') {
        return Response.json(
          { protocolVersion: 1, session, token: 'lrn_temporary-token-value' },
          { status: 201 },
        )
      }
      if (url.pathname === '/v1/me') {
        return Response.json({
          protocolVersion: 1,
          userId: '00000000000000000000000004',
          storeId: StoreId.parse('00000000000000000000000003'),
          devices: [],
          kdf: null,
          quotas: { blobs: 0, bytes: 0, maxBytes: 100 },
        })
      }
      if (method === 'DELETE') {
        return Response.json({
          protocolVersion: 1,
          session: { ...session, closedAt: '2026-09-20T01:00:00.000Z' },
        })
      }
      return Response.json({ protocolVersion: 1, sessions: [session] })
    }) as typeof fetch
    const client = createWorkbenchClient({
      baseUrl: 'https://laurencio.test',
      bearer: 'account-token',
      fetch: fetchImpl,
    })

    const created = await client.create({
      name: 'temporary on find',
      platform: 'win32',
      expiresInSeconds: 3600,
    })
    expect(created.session).toEqual(session)
    expect(created.token).toBe('lrn_temporary-token-value')
    client.setBearer(created.token)
    expect(String((await client.account()).storeId)).toBe('00000000000000000000000003')
    expect(await client.list()).toEqual([session])
    expect((await client.close(session.id)).closedAt).toBe('2026-09-20T01:00:00.000Z')
    expect(requests).toEqual([
      {
        method: 'POST',
        path: '/v1/workbench-sessions',
        auth: 'Bearer account-token',
        body: { name: 'temporary on find', platform: 'win32', expiresInSeconds: 3600 },
      },
      {
        method: 'GET',
        path: '/v1/me',
        auth: 'Bearer lrn_temporary-token-value',
        body: null,
      },
      {
        method: 'GET',
        path: '/v1/workbench-sessions',
        auth: 'Bearer lrn_temporary-token-value',
        body: null,
      },
      {
        method: 'DELETE',
        path: `/v1/workbench-sessions/${session.id}`,
        auth: 'Bearer lrn_temporary-token-value',
        body: null,
      },
    ])
    expect(JSON.stringify(client)).not.toContain('account-token')
    expect(JSON.stringify(client)).not.toContain('temporary-token-value')
  })
})
