import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { computeSyncPlan } from '../src/engine'
import type { Manifest, ManifestEntry } from '../src/model'

const deviceId = DeviceId.parse('00000000000000000000000001')
const revisionId = RevisionId.parse('00000000000000000000000002')
const surfaceId = SurfaceId.parse('claude.instructions')

function manifest(paths: Record<string, string>, kind: 'file' | 'tombstone' = 'file'): Manifest {
  const entries: ManifestEntry[] = Object.entries(paths).map(([path, hash]) => ({
    surfaceId,
    path,
    kind,
    policy: 'sync',
    hash,
    size: 1,
    mode: 0o644,
  }))
  return { revisionId, deviceId, createdAt: '2026-01-01T00:00:00.000Z', entries }
}

function local(paths: Record<string, string>): Manifest {
  const entries: ManifestEntry[] = Object.entries(paths).map(([path, hash]) => ({
    surfaceId,
    path,
    kind: 'file',
    policy: 'sync',
    hash,
    size: 1,
    mode: 0o644,
  }))
  return { revisionId, deviceId, createdAt: '2026-01-01T00:00:00.000Z', entries }
}

function resolution(
  base: Manifest | null,
  remote: Manifest | null,
  paths: Record<string, string>,
  key = Object.keys(paths)[0],
) {
  const plan = computeSyncPlan({ base, local: local(paths), remote })
  return plan.files.find((file) => file.storePath === key)?.resolution
}

describe('computeSyncPlan', () => {
  test('local-only files upload, remote-only files download', () => {
    expect(resolution(null, null, { a: 'h1' })).toBe('upload')
    expect(resolution(null, manifest({ a: 'h1' }), {}, 'a')).toBe('download')
  })

  test('one-sided edits resolve to upload or download against the base', () => {
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h1' }), { a: 'h2' })).toBe('upload')
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h2' }), { a: 'h1' })).toBe('download')
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h2' }), { a: 'h3' })).toBe('merge')
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h1' }), { a: 'h1' })).toBe('unchanged')
  })

  test('remote tombstones delete unchanged local files but yield to local edits', () => {
    const tombstone = manifest({ a: 'h1' }, 'tombstone')
    expect(resolution(manifest({ a: 'h1' }), tombstone, { a: 'h1' })).toBe('delete-local')
    expect(resolution(manifest({ a: 'h1' }), tombstone, { a: 'h2' })).toBe('upload')
  })

  test('local deletions become tombstones unless the remote changed the file', () => {
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h1' }), {}, 'a')).toBe('delete-remote')
    expect(resolution(manifest({ a: 'h1' }), manifest({ a: 'h2' }), {}, 'a')).toBe('download')
    expect(resolution(manifest({ a: 'h1' }), null, {}, 'a')).toBe('unchanged')
  })

  test('remote deletions win over untouched local files and lose to local edits', () => {
    expect(resolution(manifest({ a: 'h1' }), null, { a: 'h1' })).toBe('delete-local')
    expect(resolution(manifest({ a: 'h1' }), null, { a: 'h2' })).toBe('upload')
  })

  test('excluded paths never enter the plan', () => {
    const plan = computeSyncPlan({
      base: null,
      local: local({ a: 'h1', b: 'h2' }),
      remote: null,
      exclude: (path) => path === 'a',
    })
    expect(plan.files.map((file) => file.storePath)).toEqual(['b'])
  })

  test('ops are ordered read, download, merge, write, delete, upload, link', () => {
    const base = manifest({ changed: 'h1', gone: 'h1', killed: 'h1', victim: 'h1' })
    base.entries = base.entries.map((entry) =>
      entry.path === 'victim' ? { ...entry, kind: 'file' } : entry,
    )
    const remote = manifest({ changed: 'h3', gone: 'h1', victim: 'h1' }, 'file')
    remote.entries = remote.entries.map((entry) =>
      entry.path === 'victim' ? { ...entry, kind: 'tombstone' } : entry,
    )
    const plan = computeSyncPlan({
      base,
      local: local({ changed: 'h2', killed: 'h2', fresh: 'h9', victim: 'h1' }),
      remote,
    })
    const kinds = plan.ops.map((op) => op.kind)
    const ranks = kinds.map((kind) =>
      ['read', 'download', 'merge', 'write', 'delete', 'upload', 'link'].indexOf(kind),
    )
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    expect(kinds).toContain('merge')
    expect(kinds).toContain('delete')
    expect(kinds).toContain('upload')
    expect(plan.files.find((file) => file.storePath === 'gone')?.resolution).toBe('delete-remote')
    expect(plan.files.find((file) => file.storePath === 'victim')?.resolution).toBe('delete-local')
  })
})
