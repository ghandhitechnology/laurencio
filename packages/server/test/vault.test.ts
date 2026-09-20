import { afterAll, describe, expect, test } from 'bun:test'
import {
  BlobId,
  type BlobRef,
  PROFILE_VERSION_HEADER,
  VaultHeadResponse,
  type VaultHeadWriteRequest,
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

describe('encrypted vault heads', () => {
  test('stores the initial opaque head and returns it to authenticated readers', async () => {
    const user = await v2User('vault-initial@example.com')
    const blob = await registerBlob(user, 'encrypted vault v1')
    const empty = VaultHeadResponse.parse(
      await user.client.json(`/v1/stores/${user.storeId}/vault`, {
        headers: authHeaders(user.token),
      }),
    )
    expect(empty.head).toBeNull()

    const response = await putHead(user, { blob, expectedGeneration: null })
    expect(response.status).toBe(200)
    const written = VaultHeadResponse.parse(await response.json())
    expect(written.head).toMatchObject({ blob, generation: 1 })
    expect(Object.keys(written.head ?? {}).sort()).toEqual(['blob', 'generation', 'updatedAt'])

    // The signed-in browser session can read, but no plaintext record metadata exists in the body.
    const read = VaultHeadResponse.parse(await user.client.json(`/v1/stores/${user.storeId}/vault`))
    expect(read).toEqual(written)

    const gc = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(user.storeId),
      graceSeconds: 0,
      now: new Date(Date.now() + 1000),
    })
    expect(gc).toMatchObject({ scanned: 1, deleted: 0, kept: 1 })
  })

  test('rotates monotonically and rejects a stale compare-and-set', async () => {
    const user = await v2User('vault-rotate@example.com')
    const first = await registerBlob(user, 'encrypted vault first')
    const second = await registerBlob(user, 'encrypted vault second')
    const stale = await registerBlob(user, 'encrypted vault stale')
    await putHead(user, { blob: first, expectedGeneration: null })
    const rotatedResponse = await putHead(user, { blob: second, expectedGeneration: 1 })
    const rotated = VaultHeadResponse.parse(await rotatedResponse.json())
    expect(rotated.head).toMatchObject({ blob: second, generation: 2 })

    const staleResponse = await putHead(user, { blob: stale, expectedGeneration: 1 })
    expect(staleResponse.status).toBe(409)
    expect(await readJson<{ error: { details?: unknown } }>(staleResponse)).toMatchObject({
      error: { code: 'conflict', details: { expectedGeneration: 1, generation: 2 } },
    })
    const read = VaultHeadResponse.parse(await user.client.json(`/v1/stores/${user.storeId}/vault`))
    expect(read.head).toMatchObject({ blob: second, generation: 2 })

    const audit = await server.db
      .select({ action: auditLog.action, meta: auditLog.meta })
      .from(auditLog)
      .where(eq(auditLog.subject, user.storeId))
    expect(audit.filter((entry) => entry.action === 'vault.rotate')).toEqual([
      { action: 'vault.rotate', meta: { generation: 1 } },
      { action: 'vault.rotate', meta: { generation: 2 } },
    ])
  })

  test('rejects missing and cross-store blob references', async () => {
    const alice = await v2User('vault-alice@example.com')
    const bob = await v2User('vault-bob@example.com')
    const bobBlob = await registerBlob(bob, 'bob encrypted vault')

    const crossStore = await putHead(alice, { blob: bobBlob, expectedGeneration: null })
    expect(crossStore.status).toBe(400)
    expect(await crossStore.json()).toMatchObject({ error: { code: 'invalid_request' } })

    const missing = await putHead(alice, {
      blob: { id: BlobId.parse('f'.repeat(64)), size: 99 },
      expectedGeneration: null,
    })
    expect(missing.status).toBe(400)
  })

  test('rejects a registered blob whose upload never reached storage', async () => {
    const user = await v2User('vault-missing-object@example.com')
    const blob = await registerBlob(user, 'vault upload that never landed', true, false)
    const response = await putHead(user, { blob, expectedGeneration: null })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { blobId: blob.id } },
    })
  })

  test('requires a device token, a v2 store, and a v2 client', async () => {
    const v1 = await createUser(server, 'vault-v1@example.com')
    const v1Blob = await registerBlob(v1, 'registered before migration', false)
    const storeMismatch = await putHead(v1, { blob: v1Blob, expectedGeneration: null })
    expect(storeMismatch.status).toBe(409)

    const user = await v2User('vault-auth@example.com')
    const blob = await registerBlob(user, 'encrypted auth vault')
    const oldClient = await user.client.request(`/v1/stores/${user.storeId}/vault`, {
      method: 'PUT',
      headers: authHeaders(user.token),
      body: JSON.stringify({ blob, expectedGeneration: null }),
    })
    expect(oldClient.status).toBe(409)

    const browserSession = await user.client.request(`/v1/stores/${user.storeId}/vault`, {
      method: 'PUT',
      headers: { [PROFILE_VERSION_HEADER]: '2' },
      body: JSON.stringify({ blob, expectedGeneration: null }),
    })
    expect(browserSession.status).toBe(403)
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

function putHead(user: TestUser, body: VaultHeadWriteRequest): Promise<Response> {
  return user.client.request(`/v1/stores/${user.storeId}/vault`, {
    method: 'PUT',
    headers: profileHeaders(user.token),
    body: JSON.stringify(body),
  })
}
