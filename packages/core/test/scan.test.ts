import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { hashContent } from '../src/apply'
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
      '$HOME/.claude/skills/shared/SKILL.md',
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
    expect(skills?.files).toBe(3)
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

  test('a link to a directory outside every surface records its content at the declared path', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.claude/skills' },
        { kind: 'file', path: 'external/skill/SKILL.md', content: '# external\n' },
      ],
    })
    home.symlink('.claude/skills/ext', '$HOME/external/skill')
    const result = scanHome(home, [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })])

    const entry = result.manifest.entries.find(
      (item) => item.path === '$HOME/.claude/skills/ext/SKILL.md',
    )
    expect(entry?.surfaceId).toBe(sid('claude.skills'))
    expect(entry?.hash).toBe(hashContent('# external\n'))
    expect(entryFor(result, home.path('.claude/skills/ext')).classification).toBe('link')
    home.cleanup()
  })

  test('a link that points at its own ancestor is recorded but never walked', () => {
    const home = buildFakeHome({
      entries: [{ kind: 'file', path: '.claude/skills/real/SKILL.md', content: '# real\n' }],
    })
    home.symlink('.claude/skills/loop', '$HOME/.claude/skills')
    const result = scanHome(home, [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })])

    expect(entryFor(result, home.path('.claude/skills/loop')).classification).toBe('link')
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/skills/real/SKILL.md',
    ])
    home.cleanup()
  })

  test('a link to a file records one file entry', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.claude/skills' },
        { kind: 'file', path: 'other/doc.md', content: '# doc\n' },
      ],
    })
    home.symlink('.claude/skills/doc.md', '$HOME/other/doc.md')
    const result = scanHome(home, [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })])

    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/skills/doc.md',
    ])
    home.cleanup()
  })

  test('a link whose declared path is excluded is recorded but not descended', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.claude/skills' },
        { kind: 'file', path: 'external/secret/SKILL.md', content: '# secret\n' },
      ],
    })
    home.symlink('.claude/skills/.system', '$HOME/external/secret')
    const result = scanHome(home, [
      tree({
        id: 'claude.skills',
        path: '$HOME/.claude/skills',
        exclude: ['.system', '.system/**'],
      }),
    ])

    expect(entryFor(result, home.path('.claude/skills/.system')).classification).toBe('link')
    expect(result.manifest.entries).toEqual([])
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

  test('a symlinked HOME root still takes nested surfaces out of the enclosing tree', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/CLAUDE.md', content: '# x\n' },
        { kind: 'file', path: '.claude/projects/a/session.jsonl', content: '{"line":1}\n' },
      ],
    })
    const aliasDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-alias-'))
    const aliasHome = path.join(aliasDir, 'home')
    fs.symlinkSync(home.home, aliasHome)
    const result = scan({
      adapters: [
        testAdapter('claude', [
          tree({ id: 'claude.dir', path: '$HOME/.claude' }),
          tree({ id: 'claude.projects', path: '$HOME/.claude/projects', policy: 'never' }),
        ]),
      ],
      ctx: { ...home.ctx, home: aliasHome },
      deviceId,
      revisionId,
      createdAt,
    })

    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['$HOME/.claude/CLAUDE.md'])
    const session = entryFor(result, home.path('.claude/projects/a/session.jsonl'))
    expect(session.classification).toBe('never')
    expect(session.storePath).toBeNull()
    expect(
      result.entries.filter(
        (entry) => entry.localPath === home.path('.claude/projects/a/session.jsonl'),
      ),
    ).toHaveLength(1)
    home.cleanup()
    fs.rmSync(aliasDir, { recursive: true, force: true })
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

describe('scan tree file policies', () => {
  test('a sync override inside a never tree joins the manifest and the rest stays never', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/projects/a/memory.md', content: '# memory\n' },
        { kind: 'file', path: '.claude/projects/a/session.jsonl', content: '{"line":1}\n' },
        { kind: 'file', path: '.claude/projects/.hidden.json', content: '{"h":1}\n' },
      ],
    })
    const result = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [
          { pattern: '**/memory.md', policy: 'sync' },
          { pattern: '*.json', policy: 'opt-in' },
        ],
      }),
    ])

    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/projects/.hidden.json',
      '$HOME/.claude/projects/a/memory.md',
    ])
    expect(entryFor(result, home.path('.claude/projects/a/memory.md')).classification).toBe('sync')
    expect(entryFor(result, home.path('.claude/projects/.hidden.json')).classification).toBe(
      'opt-in',
    )
    const session = entryFor(result, home.path('.claude/projects/a/session.jsonl'))
    expect(session.classification).toBe('never')
    expect(session.hash).toBeNull()
    expect(session.storePath).toBeNull()
    home.cleanup()
  })

  test('the first matching override wins, regardless of specificity', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/projects/work.config.toml', content: 'model = "x"\n' },
        { kind: 'file', path: '.claude/projects/notes.toml', content: 'x = 1\n' },
      ],
    })
    const firstWins = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [
          { pattern: '**/*.toml', policy: 'never' },
          { pattern: 'work.config.toml', policy: 'sync' },
        ],
      }),
    ])
    expect(entryFor(firstWins, home.path('.claude/projects/work.config.toml')).classification).toBe(
      'never',
    )
    expect(firstWins.manifest.entries).toEqual([])

    const reordered = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [
          { pattern: 'work.config.toml', policy: 'sync' },
          { pattern: '**/*.toml', policy: 'never' },
        ],
      }),
    ])
    expect(entryFor(reordered, home.path('.claude/projects/work.config.toml')).classification).toBe(
      'sync',
    )
    expect(entryFor(reordered, home.path('.claude/projects/notes.toml')).classification).toBe(
      'never',
    )
    expect(reordered.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/projects/work.config.toml',
    ])
    home.cleanup()
  })

  test('patterns are tree-relative globs and dotfiles match', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/projects/top.md', content: '# top\n' },
        { kind: 'file', path: '.claude/projects/.dotted.md', content: '# dot\n' },
        { kind: 'file', path: '.claude/projects/deep/nested.md', content: '# deep\n' },
      ],
    })
    const shallow = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [{ pattern: '*.md', policy: 'sync' }],
      }),
    ])
    expect(shallow.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      '$HOME/.claude/projects/.dotted.md',
      '$HOME/.claude/projects/top.md',
    ])

    const recursive = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [{ pattern: '**/*.md', policy: 'sync' }],
      }),
    ])
    expect(recursive.manifest.entries.map((entry) => entry.path).sort()).toEqual([
      '$HOME/.claude/projects/.dotted.md',
      '$HOME/.claude/projects/deep/nested.md',
      '$HOME/.claude/projects/top.md',
    ])
    home.cleanup()
  })

  test('a declared nested surface still owns files an override would capture', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/projects/README.md', content: '# readme\n' },
        { kind: 'file', path: '.claude/projects/a/notes.md', content: '# notes\n' },
      ],
    })
    const result = scanHome(home, [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [{ pattern: '**/*.md', policy: 'sync' }],
      }),
      file({ id: 'claude.readme', path: '$HOME/.claude/projects/README.md', format: 'markdown' }),
    ])
    expect(result.manifest.entries.map((entry) => [entry.surfaceId, entry.path])).toEqual([
      [sid('claude.projects'), '$HOME/.claude/projects/a/notes.md'],
      [sid('claude.readme'), '$HOME/.claude/projects/README.md'],
    ])
    expect(entryFor(result, home.path('.claude/projects/README.md')).classification).toBe('nested')
    home.cleanup()
  })

  test('never files in an overridden tree are not read and two scans match', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'file', path: '.claude/projects/sync.md', content: '# sync\n' },
        { kind: 'file', path: '.claude/projects/locked.json', content: 'secret\n', mode: 0o000 },
      ],
    })
    const surfaces = [
      tree({
        id: 'claude.projects',
        path: '$HOME/.claude/projects',
        policy: 'never',
        filePolicy: [{ pattern: '*.md', policy: 'sync' }],
      }),
    ]
    const first = scanHome(home, surfaces)
    const second = scanHome(home, surfaces)

    const locked = entryFor(first, home.path('.claude/projects/locked.json'))
    expect(locked.classification).toBe('never')
    expect(locked.hash).toBeNull()
    expect(first.surfaces[0]?.errors).toBe(0)
    expect(first.manifest.entries.map((entry) => entry.path)).toEqual([
      '$HOME/.claude/projects/sync.md',
    ])
    expect(JSON.stringify(second, null, 2)).toBe(JSON.stringify(first, null, 2))
    home.cleanup()
  })
})
