import { afterAll, describe, expect, test } from 'bun:test'
import {
  BlobId,
  type BlobRef,
  PROFILE_VERSION_HEADER,
  ProfileHeadResponse,
  type ProfileHeadWriteRequest,
} from '@laurencio/protocol'
import { eq } from 'drizzle-orm'
import { auditLog } from '../src/db/schema'
import { collectOrphans } from '../src/gc'
import { asStoreId } from '../src/ids'
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

const profileHeaders = (token: string) => ({
  ...authHeaders(token),
  [PROFILE_VERSION_HEADER]: '2',
})

describe('encrypted profile heads', () => {
  test('stores and reads the first opaque account profile', async () => {
    const user = await v2User('profile-head-initial@example.com')
    const blob = await registerBlob(user, 'encrypted account profile v1')
    const empty = ProfileHeadResponse.parse(
      await user.client.json(`/v1/stores/${user.storeId}/profile`),
    )
    expect(empty.head).toBeNull()

    const response = await putHead(user, { blob, expectedGeneration: null })
    expect(response.status).toBe(200)
    const written = ProfileHeadResponse.parse(await response.json())
    expect(written.head).toMatchObject({ blob, generation: 1 })
    expect(Object.keys(written.head ?? {}).sort()).toEqual(['blob', 'generation', 'updatedAt'])
    expect(
      ProfileHeadResponse.parse(await user.client.json(`/v1/stores/${user.storeId}/profile`)),
    ).toEqual(written)

    const gc = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(user.storeId),
      graceSeconds: 0,
      now: new Date(Date.now() + 1000),
    })
    expect(gc).toMatchObject({ scanned: 1, deleted: 0, kept: 1 })
  })

  test('rotates monotonically, audits success, and rejects stale CAS', async () => {
    const user = await v2User('profile-head-rotate@example.com')
    const first = await registerBlob(user, 'encrypted profile first')
    const second = await registerBlob(user, 'encrypted profile second')
    await putHead(user, { blob: first, expectedGeneration: null })
    const rotated = ProfileHeadResponse.parse(
      await (await putHead(user, { blob: second, expectedGeneration: 1 })).json(),
    )
    expect(rotated.head).toMatchObject({ blob: second, generation: 2 })

    const stale = await putHead(user, { blob: first, expectedGeneration: 1 })
    expect(stale.status).toBe(409)
    expect(await readJson<{ error: { details?: unknown } }>(stale)).toMatchObject({
      error: { code: 'conflict', details: { expectedGeneration: 1, generation: 2 } },
    })

    const audit = await server.db
      .select({ action: auditLog.action, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.subject, user.storeId))
    expect(audit.filter((entry) => entry.action === 'profile.rotate')).toEqual([
      { action: 'profile.rotate', meta: { generation: 1 } },
      { action: 'profile.rotate', meta: { generation: 2 } },
    ])
  })

  test('rejects unregistered and cross-store blobs', async () => {
    const alice = await v2User('profile-head-alice@example.com')
    const bob = await v2User('profile-head-bob@example.com')
    const bobBlob = await registerBlob(bob, 'bob encrypted profile')
    expect((await putHead(alice, { blob: bobBlob, expectedGeneration: null })).status).toBe(400)
    expect(
      (
        await putHead(alice, {
          blob: { id: BlobId.parse('e'.repeat(64)), size: 50 },
          expectedGeneration: null,
        })
      ).status,
    ).toBe(400)
  })

  test('rejects a registered blob whose upload never reached storage', async () => {
    const user = await v2User('profile-head-missing-object@example.com')
    const blob = await registerBlob(user, 'profile upload that never landed', true, false)
    const response = await putHead(user, { blob, expectedGeneration: null })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { blobId: blob.id } },
    })
  })

  test('requires a device token and profile-v2 store/client', async () => {
    const v1 = await createUser(server, 'profile-head-v1@example.com')
    const v1Blob = await registerBlob(v1, 'v1 profile blob', false)
    expect((await putHead(v1, { blob: v1Blob, expectedGeneration: null })).status).toBe(409)

    const user = await v2User('profile-head-auth@example.com')
    const blob = await registerBlob(user, 'encrypted authenticated profile')
    const oldClient = await user.client.request(`/v1/stores/${user.storeId}/profile`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ blob, expectedGeneration: null }),
    })
    expect(oldClient.status).toBe(409)

    const browser = await user.client.request(`/v1/stores/${user.storeId}/profile`, {
      method: 'PUT',
      headers: { [PROFILE_VERSION_HEADER]: '2' },
      body: JSON.stringify({ blob, expectedGeneration: null }),
    })
    expect(browser.status).toBe(403)
  })
})

async function v2User(email: string): Promise<TestUser> {
  const user = await createUser(server, email)
  await user.client.expectStatus(`/v1/stores/${user.storeId}/profile-version`, 200, {
    method: 'PUT',
    headers: profileHeaders(user.token),
    body: JSON.stringify({ expectedVersion: 1, profileVersion: 2 }),
  })
  return user
}

async function registerBlob(
  user: TestUser,
  ciphertext: string,
  v2 = true,
  upload = true,
): Promise<BlobRef> {
  const bytes = bytesFor(ciphertext)
  const blob = { id: BlobId.parse(blobIdFor(bytes)), size: bytes.byteLength }
  const presign = await user.client.json<{ url: string }>(
    `/v1/stores/${user.storeId}/blobs/presign`,
    {
      method: 'POST',
      headers: v2 ? profileHeaders(user.token) : authHeaders(user.token),
      body: JSON.stringify({ blob }),
    },
  )
  if (!upload) return blob
  const url = new URL(presign.url)
  await user.client.expectStatus(`${url.pathname}${url.search}`, 200, {
    method: 'PUT',
    body: bytes,
  })
  return blob
}

function putHead(user: TestUser, body: ProfileHeadWriteRequest): Promise<Response> {
  return user.client.request(`/v1/stores/${user.storeId}/profile`, {
    method: 'PUT',
    headers: profileHeaders(user.token),
    body: JSON.stringify(body),
  })
}
