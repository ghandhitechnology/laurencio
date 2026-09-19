import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlobId, DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { hashContent } from '../src/apply'
import type { LocalBlock } from '../src/markers'
import type { ManifestEntry } from '../src/model'
import {
  acquireLock,
  clearStaleLock,
  LockHeldError,
  lockFilePath,
  releaseLock,
  SyncState,
  stateDbPath,
} from '../src/state'

const deviceId = DeviceId.parse('00000000000000000000000001')
const revisionId = RevisionId.parse('00000000000000000000000002')
const revisionId2 = RevisionId.parse('00000000000000000000000003')
const surfaceId = SurfaceId.parse('claude.settings')

function tempHome(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-state-'))
}

function openState(home: string): SyncState {
  return SyncState.open({ path: stateDbPath(home) })
}

const blob = { id: BlobId.parse('a'.repeat(64)), size: 12 }

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    surfaceId,
    path: '$HOME/.claude/settings.json',
    kind: 'file',
    policy: 'sync',
    hash: 'h1',
    size: 10,
    mode: 0o644,
    blob,
    ...overrides,
  }
}

describe('SyncState', () => {
  test('round-trips revisions, manifests, layouts, markers, and pending ops', () => {
    const home = tempHome()
    const state = openState(home)
    state.saveManifest(
      {
        id: revisionId,
        deviceId,
        parents: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        manifest: blob,
        digest: [{ surfaceId, files: 1, bytes: 10 }],
        role: 'base',
      },
      [entry()],
    )
    state.setBaseRevision(revisionId)
    expect(state.getBaseRevision()).toBe(revisionId)
    const manifest = state.getManifest(revisionId)
    expect(manifest?.entries).toEqual([entry()])
    expect(state.getRevision(revisionId)?.digest).toEqual([{ surfaceId, files: 1, bytes: 10 }])

    state.saveLayout({
      deviceId,
      entries: [
        { path: '$HOME/.claude/skills', mode: 'symlink', linkTarget: '$HOME/.agents/skills' },
      ],
    })
    expect(state.getLayout(deviceId)?.entries[0]?.linkTarget).toBe('$HOME/.agents/skills')

    const blocks: LocalBlock[] = [
      {
        range: { path: '$HOME/.claude/CLAUDE.md', startLine: 1, endLine: 4, contentHash: 'x' },
        content: 'local note',
      },
    ]
    state.saveMarkers('$HOME/.claude/CLAUDE.md', blocks)
    expect(state.getMarkers('$HOME/.claude/CLAUDE.md')).toEqual(blocks)
    state.saveMarkers('$HOME/.claude/CLAUDE.md', [])
    expect(state.getMarkers('$HOME/.claude/CLAUDE.md')).toEqual([])

    const opId = state.enqueueOp({ kind: 'retry', payload: '{"a":1}', createdAt: 'now' })
    expect(state.listPendingOps().map((op) => op.opId)).toEqual([opId])
    state.removePendingOp(opId)
    expect(state.listPendingOps()).toEqual([])

    state.setMeta('conflict_ledger', '{"version":1,"records":[]}')
    expect(state.getMeta('conflict_ledger')).toBe('{"version":1,"records":[]}')
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('recordTombstone marks the base manifest without dropping other entries', () => {
    const home = tempHome()
    const state = openState(home)
    state.saveManifest(
      {
        id: revisionId,
        deviceId,
        parents: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        manifest: blob,
        digest: [],
        role: 'base',
      },
      [entry(), entry({ path: '$HOME/.claude/CLAUDE.md', hash: 'h2' })],
    )
    state.recordTombstone(revisionId, surfaceId, '$HOME/.claude/settings.json')
    const manifest = state.getManifest(revisionId)
    expect(manifest?.entries.map((item) => item.kind).sort()).toEqual(['file', 'tombstone'])
    expect(manifest?.entries.find((item) => item.kind === 'tombstone')?.path).toBe(
      '$HOME/.claude/settings.json',
    )
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('reconciliation adopts completed writes, rolls back temp files, and clears doubt', () => {
    const home = tempHome()
    const state = openState(home)
    const dir = path.join(home, '.claude')
    fs.mkdirSync(dir, { recursive: true })

    const adoptedPath = path.join(dir, 'adopted.txt')
    fs.writeFileSync(adoptedPath, 'new content')
    state.beginOp({
      opId: 'op-adopt',
      op: 'write',
      targetPath: adoptedPath,
      resultHash: hashContent('new content'),
      startedAt: 'now',
    })

    const rolledPath = path.join(dir, 'rolled.txt')
    const rolledTemp = path.join(dir, '.laurencio-op-roll.tmp')
    fs.writeFileSync(rolledTemp, 'half written')
    state.beginOp({
      opId: 'op-roll',
      op: 'write',
      targetPath: rolledPath,
      tempPath: rolledTemp,
      resultHash: hashContent('half written'),
      startedAt: 'now',
    })

    const clearedPath = path.join(dir, 'cleared.txt')
    fs.writeFileSync(clearedPath, 'something else')
    state.beginOp({ opId: 'op-clear', op: 'write', targetPath: clearedPath, startedAt: 'now' })

    const deletedPath = path.join(dir, 'gone.txt')
    state.beginOp({ opId: 'op-delete', op: 'delete', targetPath: deletedPath, startedAt: 'now' })

    const report = state.reconcile()
    expect(report.adopted.sort()).toEqual(['op-adopt', 'op-delete'])
    expect(report.rolledBack).toEqual(['op-roll'])
    expect(report.cleared).toEqual(['op-clear'])
    expect(state.listJournal()).toEqual([])
    expect(fs.existsSync(rolledTemp)).toBe(false)
    expect(fs.readFileSync(adoptedPath, 'utf8')).toBe('new content')
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('locks are exclusive and stale locks are cleared', () => {
    const home = tempHome()
    fs.mkdirSync(path.join(home, '.laurencio'), { recursive: true })
    const lockPath = lockFilePath(home)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 2, startedAt: 'then' }))

    expect(
      clearStaleLock(
        home,
        () => true,
        () => 'then',
      ),
    ).toBeNull()
    const removed = clearStaleLock(
      home,
      () => false,
      () => 'then',
    )
    expect(removed?.pid).toBe(2)
    expect(fs.existsSync(lockPath)).toBe(false)

    acquireLock(home, {
      pid: 42,
      isAlive: () => true,
      processStart: () => 'start-42',
      startedAt: 'start-42',
    })
    expect(() => acquireLock(home, { isAlive: () => true })).toThrow(LockHeldError)
    releaseLock(home, 7)
    expect(fs.existsSync(lockPath)).toBe(true)
    releaseLock(home, 42)
    expect(fs.existsSync(lockPath)).toBe(false)

    fs.writeFileSync(lockPath, JSON.stringify({ pid: 424242, startedAt: 'then' }))
    acquireLock(home, { pid: 43, isAlive: (pid) => pid === 43, processStart: () => 'start-43' })
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }
    expect(holder.pid).toBe(43)
    releaseLock(home, 43)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('draining pending ops consumes the previous run retries exactly once', () => {
    const home = tempHome()
    const state = openState(home)
    const first = state.enqueueOp({ kind: 'retry', payload: '{"storePath":"a"}', createdAt: 'now' })
    const second = state.enqueueOp({
      kind: 'retry',
      payload: '{"storePath":"b"}',
      createdAt: 'now',
    })
    state.enqueueOp({ kind: 'other', payload: '{}', createdAt: 'now' })

    const drained = state.drainPendingOps('retry')
    expect(drained.map((op) => op.opId).sort()).toEqual([first, second].sort())
    expect(state.listPendingOps().map((op) => op.kind)).toEqual(['other'])
    expect(state.drainPendingOps('retry')).toEqual([])
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a live PID with a different start time is a reused PID, so the lock is stale', () => {
    const home = tempHome()
    fs.mkdirSync(path.join(home, '.laurencio'), { recursive: true })
    const lockPath = lockFilePath(home)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 55, startedAt: 'the-old-process' }))

    acquireLock(home, {
      pid: 56,
      isAlive: (pid) => pid === 55 || pid === 56,
      processStart: (pid) => (pid === 55 ? 'a-different-process' : 'start-56'),
    })
    const holder = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { pid: number }
    expect(holder.pid).toBe(56)
    releaseLock(home, 56)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('base revision bookkeeping keeps one base role', () => {
    const home = tempHome()
    const state = openState(home)
    const record = {
      deviceId,
      parents: [] as RevisionId[],
      createdAt: '2026-01-01T00:00:00.000Z',
      manifest: blob,
      digest: [],
    }
    state.saveManifest({ id: revisionId, ...record, role: 'base' }, [entry()])
    state.setBaseRevision(revisionId)
    state.saveManifest({ id: revisionId2, ...record, role: 'local' }, [entry()])
    state.setBaseRevision(revisionId2)
    expect(state.getRevision(revisionId)?.role).not.toBe('base')
    expect(state.getRevision(revisionId2)?.role).toBe('base')
    expect(state.getBaseRevision()).toBe(revisionId2)
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
