import { describe, expect, test } from 'bun:test'
import {
  ConflictLedger,
  conflictCopyPath,
  conflictRecord,
  createConflictArtifact,
  isConflictCopyPath,
} from '../src/merge/conflict'

describe('conflict copies', () => {
  test('the copy sits beside the file and carries device and timestamp', () => {
    const path = conflictCopyPath(
      '/Users/me/.claude/settings.json',
      'mac-mini',
      '2026-09-19T16:39:12.000Z',
    )
    expect(path).toBe('/Users/me/.claude/settings.json.conflict-mac-mini-20260919T163912Z')
    expect(isConflictCopyPath(path)).toBe(true)
  })

  test('device names are made filename-safe', () => {
    const path = conflictCopyPath('/tmp/config.toml', 'Andy’s Laptop/2', '2026-01-02T03:04:05.000Z')
    expect(path).toBe('/tmp/config.toml.conflict-Andy-s-Laptop-2-20260102T030405Z')
    expect(isConflictCopyPath(path)).toBe(true)
  })

  test('an empty device name still yields a usable path', () => {
    expect(isConflictCopyPath(conflictCopyPath('/tmp/a.toml', '  ', '2026-01-02T03:04:05Z'))).toBe(
      true,
    )
  })

  test('an invalid timestamp is rejected', () => {
    expect(() => conflictCopyPath('/tmp/a.toml', 'dev', 'not-a-date')).toThrow(
      'invalid conflict timestamp',
    )
  })

  test('ordinary files are not mistaken for copies', () => {
    expect(isConflictCopyPath('/Users/me/.claude/settings.json')).toBe(false)
    expect(isConflictCopyPath('/tmp/notes.conflict-notes.txt')).toBe(false)
    expect(isConflictCopyPath('/tmp/notes.conflict-dev-20260919.txt')).toBe(false)
  })

  test('createConflictArtifact matches the model shape', () => {
    const artifact = createConflictArtifact({
      sourcePath: '/tmp/config.toml',
      content: 'model = "remote"\n',
      device: 'laptop',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
    expect(artifact).toEqual({
      path: '/tmp/config.toml.conflict-laptop-20260919T163912Z',
      content: 'model = "remote"\n',
      device: 'laptop',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
  })

  test('conflictRecord keeps the source path for the ledger', () => {
    const artifact = createConflictArtifact({
      sourcePath: '/tmp/config.toml',
      content: 'x',
      device: 'laptop',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
    expect(conflictRecord(artifact, '/tmp/config.toml')).toEqual({
      path: artifact.path,
      sourcePath: '/tmp/config.toml',
      device: 'laptop',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
  })
})

describe('conflict ledger', () => {
  test('excludes copies by pattern even when unrecorded', () => {
    const ledger = new ConflictLedger()
    expect(ledger.isExcluded('/tmp/a.toml.conflict-dev-20260919T163912Z')).toBe(true)
    expect(ledger.isExcluded('/tmp/a.toml')).toBe(false)
  })

  test('excludes recorded paths that predate the pattern', () => {
    const ledger = new ConflictLedger()
    ledger.add({
      path: '/tmp/a.toml.conflict',
      sourcePath: '/tmp/a.toml',
      device: 'dev',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
    expect(ledger.isExcluded('/tmp/a.toml.conflict')).toBe(true)
  })

  test('adding the same path twice records one entry', () => {
    const ledger = new ConflictLedger()
    const record = {
      path: '/tmp/a.toml.conflict-dev-20260919T163912Z',
      sourcePath: '/tmp/a.toml',
      device: 'dev',
      createdAt: '2026-09-19T16:39:12.000Z',
    }
    ledger.add(record)
    ledger.add(record)
    expect(ledger.records()).toHaveLength(1)
  })

  test('round-trips through JSON', () => {
    const ledger = new ConflictLedger()
    ledger.add({
      path: '/tmp/a.toml.conflict-dev-20260919T163912Z',
      sourcePath: '/tmp/a.toml',
      device: 'dev',
      createdAt: '2026-09-19T16:39:12.000Z',
    })
    const restored = ConflictLedger.fromJSON(ledger.toJSON())
    expect(restored.records()).toEqual(ledger.records())
    expect(restored.isExcluded('/tmp/a.toml.conflict-dev-20260919T163912Z')).toBe(true)
  })

  test('rejects a malformed ledger', () => {
    expect(() => ConflictLedger.fromJSON('{"records": [{"path": 1}]}')).toThrow('malformed')
    expect(() => ConflictLedger.fromJSON('null')).toThrow('malformed')
  })
})
