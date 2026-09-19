import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { RevisionId } from '@laurencio/protocol'
import { BlobId, DeviceId, StoreId } from '@laurencio/protocol'
import { sealText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams } from '../src/crypto/kdf'
import { HttpRemoteError } from '../src/remote/http'
import type { BlobUpload, Remote, RemoteCommit } from '../src/remote/types'
import { RemoteError } from '../src/remote/types'
import { type PendingOp, SyncState } from '../src/state'
import {
  clearSyncMarkers,
  drainQueue,
  enqueueCommit,
  enqueueSync,
  enqueueUpload,
  listQueue,
  parseQueueEntry,
} from '../src/sync/queue'

const storeId = StoreId.parse('00000000000000000000000001')
const deviceId = DeviceId.parse('00000000000000000000000002')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const key = deriveMasterKey('passphrase', kdf)
const context = { storeId, blobType: 'file' as const, protocolVersion: 1 }

function tempState(): { state: SyncState; dir: string } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-queue-'))
  return { state: SyncState.open({ path: path.join(dir, 'state.db') }), dir }
}

function firstPending(state: SyncState): PendingOp {
  const op = state.listPendingOps()[0]
  if (op === undefined) throw new Error('expected a pending op')
  return op
}

interface StubRemote extends Remote {
  readonly uploads: BlobUpload[]
  readonly commits: RemoteCommit[]
}

function stubRemote(overrides: Partial<Remote> = {}): StubRemote {
  const uploads: BlobUpload[] = []
  const commits: RemoteCommit[] = []
  return {
    uploads,
    commits,
    getKdfParams: async () => null,
    listRevisions: async () => ({ revisions: [], head: null }),
    getManifest: async () => {
      throw new RemoteError('not-found', 'no manifest')
    },
    putBlob: async (upload) => {
      uploads.push(upload)
      return { id: upload.blobId, size: upload.bytes.length }
    },
    getBlob: async () => {
      throw new RemoteError('not-found', 'no blob')
    },
    commit: async (commit) => {
      commits.push(commit)
      return { revisionId: commit.revision.id, accepted: true, missing: [] }
    },
    listDevices: async () => [],
    ...overrides,
  }
}

function commitFor(revision: RevisionId): RemoteCommit {
  return {
    revision: {
      id: revision,
      storeId,
      deviceId,
      parents: [],
      manifest: { id: BlobId.parse('a'.repeat(64)), size: 12 },
      createdAt: '2026-09-19T00:00:00.000Z',
    },
    blobs: [{ id: BlobId.parse('b'.repeat(64)), size: 4 }],
    digest: [],
  }
}

describe('offline queue', () => {
  test('persists an upload and replays it idempotently after reconnect', async () => {
    const { state, dir } = tempState()
    const sealed = sealText(key, 'content', 'model = "gpt-5"\n', context)
    const remote = stubRemote()
    enqueueUpload(state, { id: sealed.blobId, size: sealed.bytes.length }, sealed.bytes, {
      createdAt: '2026-09-19T00:00:00.000Z',
    })
    const first = await drainQueue({ state, remote })
    expect(first.replayed).toHaveLength(1)
    expect(first.pending).toBe(0)
    expect(remote.uploads[0]?.blobId).toBe(sealed.blobId)

    // Replaying the same content-addressed bytes after a crash is a remote no-op.
    enqueueUpload(state, { id: sealed.blobId, size: sealed.bytes.length }, sealed.bytes)
    await drainQueue({ state, remote })
    expect(remote.uploads).toHaveLength(2)
    expect(remote.uploads[1]?.blobId).toBe(sealed.blobId)
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('keeps ops while the server is unreachable and drains them in order afterwards', async () => {
    const { state, dir } = tempState()
    const sealed = sealText(key, 'content', 'one\n', context)
    const second = sealText(key, 'content', 'two\n', context)
    enqueueUpload(state, { id: sealed.blobId, size: sealed.bytes.length }, sealed.bytes, {
      createdAt: '2026-09-19T00:00:00.000Z',
    })
    enqueueUpload(state, { id: second.blobId, size: second.bytes.length }, second.bytes, {
      createdAt: '2026-09-19T00:00:01.000Z',
    })

    let offline = true
    const uploads: BlobUpload[] = []
    const remote = stubRemote({
      putBlob: async (upload) => {
        if (offline) throw new HttpRemoteError('network', 'unreachable')
        uploads.push(upload)
        return { id: upload.blobId, size: upload.bytes.length }
      },
    })
    const blocked = await drainQueue({ state, remote })
    expect(blocked.offline).toBe(true)
    expect(blocked.pending).toBe(2)

    offline = false
    const drained = await drainQueue({ state, remote })
    expect(drained.offline).toBe(false)
    expect(drained.pending).toBe(0)
    expect(uploads.map((upload) => upload.blobId)).toEqual([sealed.blobId, second.blobId])
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('replays commits and drops ones the server cannot accept', async () => {
    const { state, dir } = tempState()
    const revision = '00000000000000000000000009' as RevisionId
    enqueueCommit(state, commitFor(revision))
    const accepted = stubRemote()
    const first = await drainQueue({ state, remote: accepted })
    expect(first.replayed).toHaveLength(1)
    expect(accepted.commits[0]?.revision.id).toBe(revision)

    const secondRevision = '00000000000000000000000010' as RevisionId
    enqueueCommit(state, commitFor(secondRevision))
    const refusing = stubRemote({
      commit: async (commit) => ({
        revisionId: commit.revision.id,
        accepted: false,
        missing: [BlobId.parse('c'.repeat(64))],
      }),
    })
    const second = await drainQueue({ state, remote: refusing })
    expect(second.replayed).toHaveLength(0)
    expect(second.failed).toHaveLength(1)
    expect(second.failed[0]?.reason).toContain('missing blobs')
    expect(second.pending).toBe(0)
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('keeps sync and retry markers until a successful pass clears them', async () => {
    const { state, dir } = tempState()
    enqueueSync(state, 'server unreachable', { createdAt: '2026-09-19T00:00:00.000Z' })
    state.enqueueOp({
      kind: 'retry',
      payload: JSON.stringify({ storePath: '$HOME/.claude/CLAUDE.md', reason: 'recently written' }),
      createdAt: '2026-09-19T00:00:01.000Z',
    })
    const entries = listQueue(state)
    expect(entries.map((entry) => entry.kind)).toEqual(['sync', 'retry'])
    const retry = entries[1]
    expect(retry !== undefined && retry.kind === 'retry' ? retry.storePath : null).toBe(
      '$HOME/.claude/CLAUDE.md',
    )

    const drained = await drainQueue({ state, remote: stubRemote() })
    expect(drained.pending).toBe(2)
    expect(clearSyncMarkers(state)).toBe(2)
    expect(state.listPendingOps()).toHaveLength(0)
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('keeps rows it cannot parse instead of dropping unknown work', async () => {
    const { state, dir } = tempState()
    state.enqueueOp({
      kind: 'future-op',
      payload: '{"anything":true}',
      createdAt: '2026-09-19T00:00:00.000Z',
    })
    expect(parseQueueEntry(firstPending(state)).kind).toBe('unknown')
    const result = await drainQueue({ state, remote: stubRemote() })
    expect(result.pending).toBe(1)
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('treats a malformed upload payload as unknown instead of replaying it', async () => {
    const { state, dir } = tempState()
    state.enqueueOp({
      kind: 'upload',
      payload: JSON.stringify({ blobId: 'not-a-blob', size: 4, base64: 'AAAA' }),
      createdAt: '2026-09-19T00:00:00.000Z',
    })
    expect(parseQueueEntry(firstPending(state)).kind).toBe('unknown')
    const result = await drainQueue({ state, remote: stubRemote() })
    expect(result.pending).toBe(1)
    state.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})
