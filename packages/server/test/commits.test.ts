import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@laurencio/protocol'
import { and, count, eq } from 'drizzle-orm'
import { auditLog, revisionBlobs, revisions } from '../src/db/schema'
import {
  authHeaders,
  blobIdFor,
  bytesFor,
  createTestServer,
  createUser,
  readJson,
  type TestServer,
  type TestUser,
  uploadBlob,
} from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

interface BlobSpec {
  id: string
  size: number
}

interface CommitOptions {
  revisionId?: string
  parents?: string[]
  manifest: BlobSpec
  blobs?: BlobSpec[]
  note?: string
  protocolVersion?: number
}

function commitPayload(user: TestUser, options: CommitOptions) {
  return {
    protocolVersion: options.protocolVersion ?? 1,
    revision: {
      id: options.revisionId ?? newId(),
      storeId: user.storeId,
      deviceId: user.deviceId,
      parents: options.parents ?? [],
      manifest: options.manifest,
      createdAt: new Date().toISOString(),
    },
    blobs: options.blobs ?? [],
    ...(options.note ? { note: options.note } : {}),
  }
}

async function postCommit(
  user: TestUser,
  options: CommitOptions,
): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const body = commitPayload(user, options)
  const response = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify(body),
  })
  return { response, payload: body as unknown as Record<string, unknown> }
}

async function countRows(
  server: TestServer,
  storeId: string,
  table: 'revisions' | 'revision_blobs' | 'audit_log',
) {
  if (table === 'revisions') {
    const rows = await server.db
      .select({ value: count() })
      .from(revisions)
      .where(eq(revisions.storeId, storeId))
    return Number(rows[0]?.value ?? 0)
  }
  if (table === 'revision_blobs') {
    const rows = await server.db
      .select({ value: count() })
      .from(revisionBlobs)
      .where(eq(revisionBlobs.storeId, storeId))
    return Number(rows[0]?.value ?? 0)
  }
  const rows = await server.db.select({ value: count() }).from(auditLog)
  return Number(rows[0]?.value ?? 0)
}

describe('POST /v1/stores/:id/commits', () => {
  test('accepts a revision whose blobs are uploaded', async () => {
    const user = await createUser(server, 'commit-happy@example.com')
    const manifestBytes = bytesFor('manifest ciphertext')
    const contentBytes = bytesFor('file ciphertext')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    const content = { id: blobIdFor(contentBytes), size: contentBytes.byteLength }
    await uploadBlob(user.client, user.token, user.storeId, manifestBytes, manifest.id)
    await uploadBlob(user.client, user.token, user.storeId, contentBytes, content.id)

    const { response, payload } = await postCommit(user, {
      manifest,
      blobs: [content],
      note: 'first sync',
    })
    expect(response.status).toBe(201)
    const body = await readJson<{ revisionId: string; accepted: boolean; missing: string[] }>(
      response,
    )
    expect(body.accepted).toBe(true)
    expect(body.missing).toEqual([])
    expect(body.revisionId).toBe((payload.revision as { id: string }).id)

    const list = await user.client.json<{
      protocolVersion: number
      head: string
      revisions: Array<{
        id: string
        storeId: string
        deviceId: string
        parents: string[]
        manifest: BlobSpec
      }>
    }>(`/v1/stores/${user.storeId}/commits`, { headers: authHeaders(user.token) })
    expect(list.protocolVersion).toBe(1)
    expect(list.head).toBe(body.revisionId)
    expect(list.revisions).toHaveLength(1)
    expect(list.revisions[0]?.storeId).toBe(user.storeId)
    expect(list.revisions[0]?.deviceId).toBe(user.deviceId)
    expect(list.revisions[0]?.parents).toEqual([])
    expect(list.revisions[0]?.manifest).toEqual(manifest)

    const me = await user.client.json<{ quotas: { blobs: number; bytes: number } }>('/v1/me', {
      headers: authHeaders(user.token),
    })
    expect(me.quotas).toMatchObject({
      blobs: 2,
      bytes: manifest.size + content.size,
    })
  })

  test('a repeated commit with the same revision id is a no-op', async () => {
    const user = await createUser(server, 'commit-idempotent@example.com')
    const manifestBytes = bytesFor('manifest one')
    const contentBytes = bytesFor('content one')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    const content = { id: blobIdFor(contentBytes), size: contentBytes.byteLength }
    await uploadBlob(user.client, user.token, user.storeId, manifestBytes, manifest.id)
    await uploadBlob(user.client, user.token, user.storeId, contentBytes, content.id)
    const revisionId = newId()

    const first = await postCommit(user, { revisionId, manifest, blobs: [content] })
    expect(first.response.status).toBe(201)
    const auditAfterFirst = await countRows(server, user.storeId, 'audit_log')

    const second = await postCommit(user, { revisionId, manifest, blobs: [content] })
    expect(second.response.status).toBe(200)
    expect(await second.response.json()).toEqual({
      revisionId,
      accepted: true,
      missing: [],
    })

    expect(await countRows(server, user.storeId, 'revisions')).toBe(1)
    expect(await countRows(server, user.storeId, 'revision_blobs')).toBe(2)
    expect(await countRows(server, user.storeId, 'audit_log')).toBe(auditAfterFirst)
  })

  test('concurrent duplicate commits store one revision', async () => {
    const user = await createUser(server, 'commit-race@example.com')
    const manifestBytes = bytesFor('manifest race')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    await uploadBlob(user.client, user.token, user.storeId, manifestBytes, manifest.id)
    const revisionId = newId()

    const [first, second] = await Promise.all([
      postCommit(user, { revisionId, manifest }),
      postCommit(user, { revisionId, manifest }),
    ])
    expect(first.response.status).toBeLessThan(300)
    expect(second.response.status).toBeLessThan(300)
    const bodies = [await first.response.json(), await second.response.json()]
    for (const body of bodies) expect(body).toMatchObject({ revisionId, accepted: true })
    expect(await countRows(server, user.storeId, 'revisions')).toBe(1)
  })

  test('a revision id owned by another store conflicts', async () => {
    const alice = await createUser(server, 'commit-conflict-alice@example.com')
    const bob = await createUser(server, 'commit-conflict-bob@example.com')
    const manifestBytes = bytesFor('shared revision id')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    await uploadBlob(alice.client, alice.token, alice.storeId, manifestBytes, manifest.id)
    await uploadBlob(bob.client, bob.token, bob.storeId, manifestBytes, manifest.id)
    const revisionId = newId()
    await alice.client.expectStatus(`/v1/stores/${alice.storeId}/commits`, 201, {
      method: 'POST',
      headers: authHeaders(alice.token),
      body: JSON.stringify(commitPayload(alice, { revisionId, manifest })),
    })
    const { response } = await postCommit(bob, { revisionId, manifest })
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'conflict' } })
  })

  test('reports missing blobs without storing the revision', async () => {
    const user = await createUser(server, 'commit-missing@example.com')
    const uploaded = bytesFor('uploaded content')
    const content = { id: blobIdFor(uploaded), size: uploaded.byteLength }
    await uploadBlob(user.client, user.token, user.storeId, uploaded, content.id)
    const neverUploaded = { id: blobIdFor(bytesFor('never uploaded')), size: 14 }

    const { response } = await postCommit(user, {
      manifest: neverUploaded,
      blobs: [content],
    })
    expect(response.status).toBe(200)
    const body = await readJson<{ accepted: boolean; missing: string[] }>(response)
    expect(body.accepted).toBe(false)
    // The manifest is unknown and the uploaded content blob is present but
    // unreferenced until a commit lands, so only the manifest is reported.
    expect(body.missing).toEqual([neverUploaded.id])
    expect(await countRows(server, user.storeId, 'revisions')).toBe(0)
  })

  test('reports a registered blob whose object is absent', async () => {
    const user = await createUser(server, 'commit-ghost@example.com')
    const manifestBytes = bytesFor('registered but absent')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    // Presign only: the row exists, the object does not.
    await user.client.expectStatus(`/v1/stores/${user.storeId}/blobs/presign`, 200, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: JSON.stringify({ blob: manifest }),
    })
    const { response } = await postCommit(user, { manifest })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: false, missing: [manifest.id] })
    expect(await countRows(server, user.storeId, 'revisions')).toBe(0)
  })

  test('rejects a declared size that disagrees with the blob row', async () => {
    const user = await createUser(server, 'commit-size@example.com')
    const bytes = bytesFor('sized blob')
    const id = blobIdFor(bytes)
    await uploadBlob(user.client, user.token, user.storeId, bytes, id)
    const { response } = await postCommit(user, {
      manifest: { id, size: bytes.byteLength + 5 },
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', details: { storedSize: bytes.byteLength } },
    })
  })

  test('rejects unknown parents, including parents from another store', async () => {
    const alice = await createUser(server, 'commit-parents-alice@example.com')
    const bob = await createUser(server, 'commit-parents-bob@example.com')
    const aliceManifestBytes = bytesFor('alice manifest for parent')
    const aliceManifest = {
      id: blobIdFor(aliceManifestBytes),
      size: aliceManifestBytes.byteLength,
    }
    await uploadBlob(alice.client, alice.token, alice.storeId, aliceManifestBytes, aliceManifest.id)
    const aliceRevision = await alice.client.json<{ revisionId: string }>(
      `/v1/stores/${alice.storeId}/commits`,
      {
        method: 'POST',
        headers: authHeaders(alice.token),
        body: JSON.stringify(commitPayload(alice, { manifest: aliceManifest })),
      },
    )

    const bobBytes = bytesFor('bob manifest')
    const bobManifest = { id: blobIdFor(bobBytes), size: bobBytes.byteLength }
    await uploadBlob(bob.client, bob.token, bob.storeId, bobBytes, bobManifest.id)

    const unknown = await postCommit(bob, {
      manifest: bobManifest,
      parents: ['01M2WAAP09R3A8HWSTNF3F0Y40'],
    })
    expect(unknown.response.status).toBe(400)
    expect(await unknown.response.json()).toMatchObject({
      error: {
        code: 'invalid_request',
        details: { missingParents: ['01M2WAAP09R3A8HWSTNF3F0Y40'] },
      },
    })

    const foreign = await postCommit(bob, {
      manifest: bobManifest,
      parents: [aliceRevision.revisionId],
    })
    expect(foreign.response.status).toBe(400)
  })

  test('links a parent chain and lists only newer revisions', async () => {
    const user = await createUser(server, 'commit-chain@example.com')
    const firstBytes = bytesFor('chain manifest one')
    const secondBytes = bytesFor('chain manifest two')
    const thirdBytes = bytesFor('chain manifest three')
    const manifests = [firstBytes, secondBytes, thirdBytes].map((bytes) => ({
      id: blobIdFor(bytes),
      size: bytes.byteLength,
    }))
    for (const [index, manifest] of manifests.entries()) {
      const bytes = [firstBytes, secondBytes, thirdBytes][index]
      if (bytes) await uploadBlob(user.client, user.token, user.storeId, bytes, manifest.id)
    }

    const first = await postCommit(user, { manifest: manifests[0] as BlobSpec })
    const firstId = (await readJson<{ revisionId: string }>(first.response)).revisionId
    const second = await postCommit(user, {
      manifest: manifests[1] as BlobSpec,
      parents: [firstId],
    })
    const secondId = (await readJson<{ revisionId: string }>(second.response)).revisionId
    await postCommit(user, { manifest: manifests[2] as BlobSpec, parents: [secondId] })

    const all = await user.client.json<{ revisions: Array<{ id: string }>; head: string }>(
      `/v1/stores/${user.storeId}/commits`,
      { headers: authHeaders(user.token) },
    )
    expect(all.revisions).toHaveLength(3)
    expect(all.head).toBe(all.revisions[0]?.id ?? '')
    expect(all.revisions[1]?.id).toBe(secondId as string | undefined)

    const limited = await user.client.json<{ revisions: Array<{ id: string }> }>(
      `/v1/stores/${user.storeId}/commits?limit=2`,
      { headers: authHeaders(user.token) },
    )
    expect(limited.revisions).toHaveLength(2)

    const since = await user.client.json<{ revisions: Array<{ id: string }>; head: string }>(
      `/v1/stores/${user.storeId}/commits?since=${firstId}`,
      { headers: authHeaders(user.token) },
    )
    expect(since.revisions.map((revision) => revision.id)).not.toContain(firstId)
    expect(since.revisions).toHaveLength(2)
    expect(since.head).toBe(all.head)
  })

  test('rejects a bad limit and a bad since value', async () => {
    const user = await createUser(server, 'commit-limit@example.com')
    const badLimit = await user.client.request(`/v1/stores/${user.storeId}/commits?limit=zero`, {
      headers: authHeaders(user.token),
    })
    expect(badLimit.status).toBe(400)
    const badSince = await user.client.request(
      `/v1/stores/${user.storeId}/commits?since=not-a-revision`,
      { headers: authHeaders(user.token) },
    )
    expect(badSince.status).toBe(400)
  })

  test('requires a device token rather than a browser session', async () => {
    const user = await createUser(server, 'commit-session@example.com')
    const bytes = bytesFor('session commit')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    const response = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
      method: 'POST',
      body: JSON.stringify(commitPayload(user, { manifest })),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: { code: 'forbidden' } })
  })

  test('refuses commits into another account store', async () => {
    const alice = await createUser(server, 'commit-alice@example.com')
    const bob = await createUser(server, 'commit-bob@example.com')
    const bytes = bytesFor('cross store commit')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    const response = await bob.client.request(`/v1/stores/${alice.storeId}/commits`, {
      method: 'POST',
      headers: authHeaders(bob.token),
      body: JSON.stringify(commitPayload(bob, { manifest })),
    })
    expect(response.status).toBe(403)
  })

  test('does not see blobs from another store as present', async () => {
    const alice = await createUser(server, 'commit-blob-alice@example.com')
    const bob = await createUser(server, 'commit-blob-bob@example.com')
    const bytes = bytesFor('alice blob only')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    await uploadBlob(alice.client, alice.token, alice.storeId, bytes, manifest.id)
    const { response } = await postCommit(bob, { manifest })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ accepted: false, missing: [manifest.id] })
  })

  test('rejects a mismatched protocol version in the body', async () => {
    const user = await createUser(server, 'commit-protocol@example.com')
    const bytes = bytesFor('protocol mismatch')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    const { response } = await postCommit(user, { manifest, protocolVersion: 2 })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'protocol_mismatch' } })
  })

  test('rejects more than four parents', async () => {
    const user = await createUser(server, 'commit-parents-many@example.com')
    const bytes = bytesFor('too many parents')
    const manifest = { id: blobIdFor(bytes), size: bytes.byteLength }
    const { response } = await postCommit(user, {
      manifest,
      parents: [newId(), newId(), newId(), newId(), newId()],
    })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
  })
})

describe('revision bookkeeping', () => {
  test('fan-out rows reference every blob once', async () => {
    const user = await createUser(server, 'commit-fanout@example.com')
    const manifestBytes = bytesFor('fanout manifest')
    const contentBytes = bytesFor('fanout content')
    const manifest = { id: blobIdFor(manifestBytes), size: manifestBytes.byteLength }
    const content = { id: blobIdFor(contentBytes), size: contentBytes.byteLength }
    await uploadBlob(user.client, user.token, user.storeId, manifestBytes, manifest.id)
    await uploadBlob(user.client, user.token, user.storeId, contentBytes, content.id)
    await postCommit(user, { manifest, blobs: [content] })
    const rows = await server.db
      .select({ blobId: revisionBlobs.blobId, size: revisionBlobs.size })
      .from(revisionBlobs)
      .where(and(eq(revisionBlobs.storeId, user.storeId)))
    expect(rows.map((row) => row.blobId).sort()).toEqual([manifest.id, content.id].sort())
    expect(rows.map((row) => row.size).sort()).toEqual([manifest.size, content.size].sort())
  })
})
