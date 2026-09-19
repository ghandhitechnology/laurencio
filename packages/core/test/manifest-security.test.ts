import { describe, expect, test } from 'bun:test'
import { DEFAULT_FILE_MODE } from '../src/model'
import {
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ENTRIES,
  MAX_MANIFEST_ENTRY_BYTES,
  MAX_STORE_PATH_LENGTH,
  ManifestError,
  parseManifest,
} from '../src/remote/types'

const revisionId = '00000000000000000000000001'
const deviceId = '00000000000000000000000002'

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    surfaceId: 'claude.instructions',
    path: '$HOME/.claude/CLAUDE.md',
    kind: 'file',
    policy: 'sync',
    hash: 'a'.repeat(64),
    size: 12,
    mode: 0o644,
    ...overrides,
  }
}

function manifest(entries: unknown[]): unknown {
  return { revisionId, deviceId, createdAt: '2026-01-01T00:00:00.000Z', entries }
}

function expectCode(value: unknown, code: ManifestError['code'], byteLength?: number): void {
  try {
    parseManifest(value, byteLength)
    throw new Error('expected the manifest to be refused')
  } catch (error) {
    expect(error).toBeInstanceOf(ManifestError)
    expect((error as ManifestError).code).toBe(code)
  }
}

describe('manifest path validation', () => {
  const hostile = [
    '',
    '/etc/passwd',
    'C:/Windows/System32/config',
    'C:\\Windows',
    '$HOME/.claude/../../.ssh/authorized_keys',
    '$HOME/.claude/..',
    '$HOME/.claude/./CLAUDE.md',
    '..',
    '$HOME/.claude//CLAUDE.md',
    '$HOME/.claude/CLAUDE.md/',
    '$HOME/.claude/CLAUDE\u0000.md',
    '$HOME\\.claude\\CLAUDE.md',
  ]

  for (const path of hostile) {
    test(`refuses ${JSON.stringify(path)}`, () => {
      expectCode(manifest([entry({ path })]), 'invalid-path')
    })
  }

  test('refuses a path longer than the bound', () => {
    const path = `$HOME/.claude/${'a'.repeat(MAX_STORE_PATH_LENGTH)}`
    expectCode(manifest([entry({ path })]), 'invalid-path')
  })

  test('accepts tokenized store paths', () => {
    const parsed = parseManifest(
      manifest([entry(), entry({ path: '$HOME/.agents/skills/foo/SKILL.md', mode: 0o755 })]),
    )
    expect(parsed.entries.map((item) => item.path)).toEqual([
      '$HOME/.claude/CLAUDE.md',
      '$HOME/.agents/skills/foo/SKILL.md',
    ])
  })
})

describe('manifest mode validation', () => {
  test('masks to 0o777 and defaults files to 0o644', () => {
    const parsed = parseManifest(
      manifest([entry({ mode: undefined }), entry({ mode: 0o600 }), entry({ mode: 0o755 })]),
    )
    expect(parsed.entries.map((item) => item.mode)).toEqual([DEFAULT_FILE_MODE, 0o600, 0o755])
  })

  test('refuses setuid, setgid, sticky, and file-type bits', () => {
    for (const mode of [0o4755, 0o2755, 0o1755, 0o7777, 0o100644]) {
      expectCode(manifest([entry({ mode })]), 'invalid-mode')
    }
  })
})

describe('manifest bounds', () => {
  test('refuses more entries than the cap', () => {
    const entries = Array.from({ length: MAX_MANIFEST_ENTRIES + 1 }, () => entry())
    expectCode(manifest(entries), 'too-many-entries')
  })

  test('refuses an entry whose declared size is over the per-entry cap', () => {
    expectCode(manifest([entry({ size: MAX_MANIFEST_ENTRY_BYTES + 1 })]), 'entry-too-large')
    expectCode(
      manifest([entry({ blob: { id: 'b'.repeat(64), size: MAX_MANIFEST_ENTRY_BYTES + 1 } })]),
      'entry-too-large',
    )
  })

  test('refuses a manifest over the byte cap before walking entries', () => {
    expectCode(manifest([entry()]), 'manifest-too-large', MAX_MANIFEST_BYTES + 1)
  })
})
