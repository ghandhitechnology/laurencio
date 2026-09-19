import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { type ScannedEntry, type ScanResult, scan } from '../src/scan'
import type { Surface } from '../src/types'
import { file, keyedFile, testAdapter, tree } from './helpers/adapter-fixtures'
import { buildFakeHome, type FakeHome, type FakeHomeOptions } from './helpers/fake-home'

const deviceId = DeviceId.parse('00000000000000000000000000')
const revisionId = RevisionId.parse('00000000000000000000000000')
const createdAt = '2026-01-01T00:00:00.000Z'

const sid = SurfaceId.parse

function scanHome(
  home: FakeHome,
  surfaces: Surface[],
  harness: 'claude' | 'codex' | 'opencode' = 'claude',
) {
  return scan({
    adapters: [testAdapter(harness, surfaces)],
    ctx: home.ctx,
    deviceId,
    revisionId,
    createdAt,
  })
}

function entryFor(result: ScanResult, localPath: string): ScannedEntry {
  const found = result.entries.find((entry) => entry.localPath === localPath)
  if (found === undefined) throw new Error(`missing entry ${localPath}`)
  return found
}

const fixtureOptions: FakeHomeOptions = {
  entries: [
    { kind: 'file', path: '.claude/settings.json', content: '{"model":"opus"}', mode: 0o644 },
    { kind: 'file', path: '.claude/CLAUDE.md', content: '# rules\n', mode: 0o644 },
    { kind: 'file', path: '.claude/.credentials.json', content: '{"token":"secret"}', mode: 0o600 },
    {
      kind: 'file',
      path: '.claude/projects/a/session.jsonl',
      content: '{"line":1}\n',
      mode: 0o600,
    },
    { kind: 'dir', path: '.claude/skills/commit' },
    { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# commit\n', mode: 0o644 },
    { kind: 'file', path: '.claude/skills/local-notes.md', content: 'local\n', mode: 0o644 },
    { kind: 'dir', path: '.claude/skills/node_modules/dep' },
    { kind: 'file', path: '.claude/skills/node_modules/dep/index.js', content: 'x\n', mode: 0o644 },
    { kind: 'file', path: '.agents/skills/shared/SKILL.md', content: '# shared\n', mode: 0o644 },
  ],
  ignore: [],
}

function fixtureSurfaces(): Surface[] {
  return [
    file({ id: 'claude.settings', path: '$HOME/.claude/settings.json', format: 'json' }),
    file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' }),
    file({ id: 'claude.credentials', path: '$HOME/.claude/.credentials.json', policy: 'never' }),
    tree({ id: 'claude.transcripts', path: '$HOME/.claude/projects', policy: 'never' }),
    tree({
      id: 'claude.skills',
      path: '$HOME/.claude/skills',
      exclude: ['**/node_modules/**'],
    }),
    tree({ id: 'claude.shared-skills', path: '$HOME/.agents/skills' }),
  ]
}

describe('scan manifest', () => {
  test('classifies files, excludes trees, and never reads never surfaces', () => {
    const home = buildFakeHome(fixtureOptions)
    home.symlink('.claude/skills/shared', '$HOME/.agents/skills/shared')
    const result = scanHome(home, fixtureSurfaces())

    const manifestPaths = result.manifest.entries.map((entry) => entry.path)
    expect(manifestPaths).toEqual([
      '$HOME/.claude/CLAUDE.md',
      '$HOME/.claude/settings.json',
      '$HOME/.agents/skills/shared/SKILL.md',
      '$HOME/.claude/skills/commit/SKILL.md',
      '$HOME/.claude/skills/local-notes.md',
    ])
    const credentials = entryFor(result, home.path('.claude/.credentials.json'))
    expect(credentials.classification).toBe('never')
    expect(credentials.hash).toBeNull()
    expect(credentials.storePath).toBeNull()
    const session = entryFor(result, home.path('.claude/projects/a/session.jsonl'))
    expect(session.classification).toBe('never')
    const excluded = entryFor(result, home.path('.claude/skills/node_modules'))
    expect(excluded.classification).toBe('excluded')
    expect(
      result.entries.some(
        (entry) => entry.localPath === home.path('.claude/skills/node_modules/dep'),
      ),
    ).toBe(false)

    const skills = result.surfaces.find((surface) => surface.surfaceId === sid('claude.skills'))
    expect(skills?.files).toBe(2)
    expect(skills?.excluded).toBe(1)
    expect(skills?.links).toBe(1)
    home.cleanup()
  })

  test('records link topology and points links at the surface that owns the target', () => {
    const home = buildFakeHome(fixtureOptions)
    home.symlink('.claude/skills/shared', '$HOME/.agents/skills/shared')
    const result = scanHome(home, fixtureSurfaces())

    const link = entryFor(result, home.path('.claude/skills/shared'))
    expect(link.kind).toBe('symlink')
    expect(link.classification).toBe('link')
    expect(link.linkTarget).toBe(home.path('.agents/skills/shared'))
    expect(link.linkedSurfaceId).toBe(sid('claude.shared-skills'))
    expect(result.layout.entries).toContainEqual({
      path: home.path('.claude/skills/shared'),
      mode: 'symlink',
      linkTarget: home.path('.agents/skills/shared'),
    })
    home.cleanup()
  })

  test('a surface root that is a symlink keeps the link in the layout and the content elsewhere', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# c\n', mode: 0o644 },
        { kind: 'dir', path: '.codex' },
      ],
    })
    home.symlink('.codex/skills', '$HOME/.claude/skills')
    const result = scanHome(
      home,
      [
        tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
        tree({ id: 'codex.skills', path: '$HOME/.codex/skills' }),
      ],
      'codex',
    )
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/skills/commit/SKILL.md',
    ])
    expect(result.ownership).toEqual([
      {
        surfaceId: sid('claude.skills'),
        resolvedPath: home.path('.claude/skills'),
        referencedBy: [sid('codex.skills')],
      },
    ])
    expect(result.layout.entries).toContainEqual({
      path: home.path('.codex/skills'),
      mode: 'symlink',
      linkTarget: home.path('.claude/skills'),
    })
    home.cleanup()
  })

  test('a nested declared surface takes its path out of the enclosing tree', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/settings.json', content: '{"a":1}', mode: 0o644 },
        { kind: 'file', path: '.claude/settings.local.json', content: '{"b":2}', mode: 0o600 },
        { kind: 'file', path: '.claude/CLAUDE.md', content: '# x\n', mode: 0o644 },
      ],
    })
    const result = scanHome(home, [
      tree({ id: 'claude.dir', path: '$HOME/.claude' }),
      file({ id: 'claude.settings', path: '$HOME/.claude/settings.json', format: 'json' }),
      file({
        id: 'claude.local',
        path: '$HOME/.claude/settings.local.json',
        policy: 'never',
      }),
    ])
    expect(result.manifest.entries.map((entry) => [entry.surfaceId, entry.path])).toEqual([
      [sid('claude.dir'), '$HOME/.claude/CLAUDE.md'],
      [sid('claude.settings'), '$HOME/.claude/settings.json'],
    ])
    expect(entryFor(result, home.path('.claude/settings.json')).classification).toBe('nested')
    expect(entryFor(result, home.path('.claude/settings.local.json')).classification).toBe('nested')
    home.cleanup()
  })

  test('a keyed file surface hashes the file it owns', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.codex/config.toml', content: 'model = "x"\n', mode: 0o600 },
      ],
    })
    const result = scanHome(
      home,
      [keyedFile({ id: 'codex.config', path: '$HOME/.codex/config.toml' })],
      'codex',
    )
    expect(result.manifest.entries).toHaveLength(1)
    expect(result.manifest.entries[0]?.mode).toBe(0o600)
    expect(result.manifest.entries[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    home.cleanup()
  })

  test('scanning twice produces identical output', () => {
    const home = buildFakeHome(fixtureOptions)
    home.symlink('.claude/skills/shared', '$HOME/.agents/skills/shared')
    const first = scanHome(home, fixtureSurfaces())
    const second = scanHome(home, fixtureSurfaces())
    expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2))
    home.cleanup()
  })

  test('reproduces the committed manifest fixture byte for byte', async () => {
    const home = buildFakeHome(fixtureOptions)
    home.symlink('.claude/skills/shared', '$HOME/.agents/skills/shared')
    const result = scanHome(home, fixtureSurfaces())
    const expected = await Bun.file(
      new URL('./fixtures/scan-home/expected-manifest.json', import.meta.url),
    ).text()
    expect(`${JSON.stringify(result.manifest, null, 2)}\n`).toBe(expected)
    home.cleanup()
  })

  test('a missing surface root is reported and skipped', () => {
    const home = buildFakeHome({ entries: [] })
    const result = scanHome(home, [
      file({ id: 'claude.settings', path: '$HOME/.claude/settings.json', format: 'json' }),
    ])
    expect(result.manifest.entries).toEqual([])
    expect(result.surfaces[0]?.exists).toBe(false)
    expect(result.entries).toEqual([])
    home.cleanup()
  })

  test('scanning leaves the home byte for byte untouched', () => {
    const home = buildFakeHome(fixtureOptions)
    home.symlink('.claude/skills/shared', '$HOME/.agents/skills/shared')
    const snapshot = (dir: string): string[] =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((entry) => {
          const localPath = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) return [`link ${localPath} ${fs.readlinkSync(localPath)}`]
          if (entry.isDirectory()) return [localPath, ...snapshot(localPath)]
          const stat = fs.statSync(localPath)
          return [`file ${localPath} ${stat.size} ${stat.mtimeMs}`]
        })
        .sort()
    const before = snapshot(home.home)
    scanHome(home, fixtureSurfaces())
    expect(snapshot(home.home)).toEqual(before)
    home.cleanup()
  })
})
