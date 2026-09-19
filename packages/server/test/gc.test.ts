import { afterAll, describe, expect, test } from 'bun:test'
import { newId } from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import { blobs, revisions } from '../src/db/schema'
import { collectOrphans, deleteOrphans, selectOrphans } from '../src/gc'
import { asStoreId } from '../src/ids'
import {
  authHeaders,
  blobIdFor,
  bytesFor,
  createTestServer,
  createUser,
  type TestUser,
  uploadBlob,
} from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

function storageKey(storeId: string, blobId: string): string {
  return `u/${storeId}/b/${blobId}`
}

interface Fixture {
  user: TestUser
  storeId: string
  referenced: { id: string; size: number }
  orphan: { id: string; size: number }
}

async function seed(email: string): Promise<Fixture> {
  const user = await createUser(server, email)
  const referencedBytes = bytesFor(`${email} referenced ciphertext`)
  const orphanBytes = bytesFor(`${email} orphan ciphertext`)
  const referenced = { id: blobIdFor(referencedBytes), size: referencedBytes.byteLength }
  const orphan = { id: blobIdFor(orphanBytes), size: orphanBytes.byteLength }
  await uploadBlob(user.client, user.token, user.storeId, referencedBytes, referenced.id)
  await uploadBlob(user.client, user.token, user.storeId, orphanBytes, orphan.id)
  const response = await user.client.request(`/v1/stores/${user.storeId}/commits`, {
    method: 'POST',
    headers: authHeaders(user.token),
    body: JSON.stringify({
      protocolVersion: 1,
      revision: {
        id: newId(),
        storeId: user.storeId,
        deviceId: user.deviceId,
        parents: [],
        manifest: referenced,
        createdAt: new Date().toISOString(),
      },
      blobs: [],
    }),
  })
  if (response.status !== 201) throw new Error(`seed commit failed: ${await response.text()}`)
  return { user, storeId: user.storeId, referenced, orphan }
}

describe('orphan collection', () => {
  test('a dry run reports what would go and deletes nothing', async () => {
    const fixture = await seed('gc-dry@example.com')
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(fixture.storeId),
      graceSeconds: 0,
      dryRun: true,
    })
    expect(report).toEqual({
      scanned: 2,
      deleted: 1,
      bytesFreed: fixture.orphan.size,
      kept: 1,
    })
    expect(await server.storage.head(storageKey(fixture.storeId, fixture.orphan.id))).not.toBeNull()
    const rows = await server.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.storeId, fixture.storeId), eq(blobs.id, fixture.orphan.id)))
    expect(rows).toHaveLength(1)
  })

  test('a real run removes only unreferenced blobs', async () => {
    const fixture = await seed('gc-real@example.com')
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(fixture.storeId),
      graceSeconds: 0,
    })
    expect(report).toEqual({
      scanned: 2,
      deleted: 1,
      bytesFreed: fixture.orphan.size,
      kept: 1,
    })

    expect(await server.storage.head(storageKey(fixture.storeId, fixture.orphan.id))).toBeNull()
    expect(
      await server.storage.head(storageKey(fixture.storeId, fixture.referenced.id)),
    ).not.toBeNull()

    const orphanRows = await server.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.storeId, fixture.storeId), eq(blobs.id, fixture.orphan.id)))
    expect(orphanRows).toHaveLength(0)

    const revisionRows = await server.db
      .select()
      .from(revisions)
      .where(eq(revisions.storeId, fixture.storeId))
    expect(revisionRows).toHaveLength(1)
  })

  test('a commit between selection and deletion keeps its blobs', async () => {
    const fixture = await seed('gc-race@example.com')
    const options = {
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(fixture.storeId),
      graceSeconds: 0,
    }
    const selection = await selectOrphans(options)
    expect(selection.candidates.map((candidate) => candidate.id)).toContain(fixture.orphan.id)

    // The blob looked collectable at selection time; a commit references it
    // before the sweep gets to delete it.
    const response = await fixture.user.client.request(`/v1/stores/${fixture.storeId}/commits`, {
      method: 'POST',
      headers: authHeaders(fixture.user.token),
      body: JSON.stringify({
        protocolVersion: 1,
        revision: {
          id: newId(),
          storeId: fixture.storeId,
          deviceId: fixture.user.deviceId,
          parents: [],
          manifest: fixture.orphan,
          createdAt: new Date().toISOString(),
        },
        blobs: [],
      }),
    })
    expect(response.status).toBe(201)

    const report = await deleteOrphans(options, selection)
    expect(report.deleted).toBe(0)
    expect(await server.storage.head(storageKey(fixture.storeId, fixture.orphan.id))).not.toBeNull()
    const rows = await server.db
      .select()
      .from(blobs)
      .where(and(eq(blobs.storeId, fixture.storeId), eq(blobs.id, fixture.orphan.id)))
    expect(rows).toHaveLength(1)
  })

  test('respects the grace period', async () => {
    const fixture = await seed('gc-grace@example.com')
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(fixture.storeId),
      graceSeconds: 60 * 60,
    })
    expect(report).toEqual({
      scanned: 2,
      deleted: 0,
      bytesFreed: 0,
      kept: 2,
    })
  })

  test('only touches the requested store', async () => {
    const first = await seed('gc-scope-one@example.com')
    const second = await seed('gc-scope-two@example.com')
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(first.storeId),
      graceSeconds: 0,
    })
    expect(report.deleted).toBe(1)
    expect(await server.storage.head(storageKey(second.storeId, second.orphan.id))).not.toBeNull()
  })

  test('a blob becomes collectable when its revision is deleted', async () => {
    const fixture = await seed('gc-revision@example.com')
    await server.db.delete(revisions).where(eq(revisions.storeId, fixture.storeId))
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(fixture.storeId),
      graceSeconds: 0,
    })
    expect(report.deleted).toBe(2)
    expect(await server.storage.head(storageKey(fixture.storeId, fixture.referenced.id))).toBeNull()
  })

  test('an empty store reports nothing to do', async () => {
    const user = await createUser(server, 'gc-empty@example.com')
    const report = await collectOrphans({
      db: server.db,
      storage: server.storage,
      storeId: asStoreId(user.storeId),
      graceSeconds: 0,
    })
    expect(report).toEqual({ scanned: 0, deleted: 0, bytesFreed: 0, kept: 0 })
  })
})
