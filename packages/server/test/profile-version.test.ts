import { afterAll, describe, expect, test } from 'bun:test'
import { newId, PROFILE_VERSION_HEADER, ProfileVersionResponse } from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { auditLog } from '../src/db/schema'
import {
  authHeaders,
  blobIdFor,
  bytesFor,
  createTestServer,
  createUser,
  readJson,
  type TestUser,
} from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

const params = {
  algo: 'argon2id',
  version: 1,
  salt: 'cHJvZmlsZS12ZXJzaW9uLXNhbHQ=',
  m: 65536,
  t: 3,
  p: 1,
  calibratedAt: '2026-09-20T00:00:00.000Z',
  generation: null,
}

describe('store profile versions', () => {
  test('allows v1 writes before an explicit v2 migration', async () => {
    const user = await createUser(server, 'profile-version-v1@example.com')
    const version = ProfileVersionResponse.parse(
      await user.client.json(`/v1/stores/${user.storeId}/profile-version`, {
        headers: authHeaders(user.token),
      }),
    )
    expect(version.profileVersion).toBe(1)

    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })

    const nextClientBlob = bytesFor('v2 client on v1 store')
    await user.client.expectStatus(`/v1/stores/${user.storeId}/blobs/presign`, 200, {
      method: 'POST',
      headers: { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' },
      body: JSON.stringify({
        blob: { id: blobIdFor(nextClientBlob), size: nextClientBlob.byteLength },
      }),
    })
  })

  test('migrates from v1 to v2 with CAS and records an audit event', async () => {
    const user = await createUser(server, 'profile-version-migrate@example.com')
    const response = await user.client.request(`/v1/stores/${user.storeId}/profile-version`, {
      method: 'PUT',
      headers: { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' },
      body: JSON.stringify({ expectedVersion: 1, profileVersion: 2 }),
    })
    expect(response.status).toBe(200)
    expect(ProfileVersionResponse.parse(await response.json()).profileVersion).toBe(2)

    const stale = await user.client.request(`/v1/stores/${user.storeId}/profile-version`, {
      method: 'PUT',
      headers: { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' },
      body: JSON.stringify({ expectedVersion: 1, profileVersion: 2 }),
    })
    expect(stale.status).toBe(409)

    const audit = await server.db
      .select({ action: auditLog.action, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.subject, user.storeId))
    expect(audit).toContainEqual({
      action: 'store.profile_version.update',
      meta: { from: 1, to: 2, clientProfileVersion: 2 },
    })
  })

  test('rejects v1 mutation routes after migration while retaining reads', async () => {
    const user = await createUser(server, 'profile-version-gate@example.com')
    await migrate(user)

    const blob = bytesFor('old client blob')
    const presign = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ blob: { id: blobIdFor(blob), size: blob.byteLength } }),
    })
    await expectProfileConflict(presign)

    const kdf = await user.client.request(`/v1/stores/${user.storeId}/kdf-params`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify(params),
    })
    await expectProfileConflict(kdf)

    const commit = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({}),
    })
    await expectProfileConflict(commit)

    await user.client.expectStatus(`/v1/stores/${user.storeId}/commits`, 200, {
      headers: authHeaders(user.token),
    })
    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      headers: authHeaders(user.token),
    })
  })

  test('allows a v2 client to write a migrated store', async () => {
    const user = await createUser(server, 'profile-version-v2@example.com')
    await migrate(user)
    const headers = { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' }
    const manifest = bytesFor('v2 manifest')
    const manifestId = blobIdFor(manifest)
    const presign = await user.client.json<{ url: string }>(
      `/v1/stores/${user.storeId}/blobs/presign`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ blob: { id: manifestId, size: manifest.byteLength } }),
      },
    )
    const uploadUrl = new URL(presign.url)
    await user.client.expectStatus(`${uploadUrl.pathname}${uploadUrl.search}`, 200, {
      method: 'PUT',
      body: manifest,
    })

    await user.client.expectStatus(`/v1/stores/${user.storeId}/kdf-params`, 200, {
      method: 'PUT',
      headers,
      body: JSON.stringify(params),
    })
    const commit = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        protocolVersion: 1,
        revision: {
          id: newId(),
          storeId: user.storeId,
          deviceId: user.deviceId,
          parents: [],
          manifest: { id: manifestId, size: manifest.byteLength },
          createdAt: '2026-09-20T00:00:00.000Z',
        },
        blobs: [],
      }),
    })
    expect(commit.status).toBe(201)
  })
})

async function migrate(user: TestUser): Promise<void> {
  await user.client.expectStatus(`/v1/stores/${user.storeId}/profile-version`, 200, {
    method: 'PUT',
    headers: { ...authHeaders(user.token), [PROFILE_VERSION_HEADER]: '2' },
    body: JSON.stringify({ expectedVersion: 1, profileVersion: 2 }),
  })
}

async function expectProfileConflict(response: Response): Promise<void> {
  expect(response.status).toBe(409)
  expect(await readJson<{ error: { details?: unknown } }>(response)).toMatchObject({
    error: {
      code: 'conflict',
      details: { storeProfileVersion: 2, clientProfileVersion: 1 },
    },
  })
}
