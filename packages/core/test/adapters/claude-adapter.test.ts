import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { claudeAdapter, claudeSurfaces, detectClaude } from '../../src/adapters/claude'
import { builtinAdapters, createAdapterRegistry } from '../../src/adapters/registry'
import type { EntryClass, ScannedEntry, ScanResult } from '../../src/scan'
import { scan } from '../../src/scan'
import type { AdapterContext, Surface } from '../../src/types'
import { buildFakeHome, type FakeEntry, type FakeHome } from '../helpers/fake-home'

const deviceId = DeviceId.parse('00000000000000000000000000')
const revisionId = RevisionId.parse('00000000000000000000000000')
const createdAt = '2026-01-01T00:00:00.000Z'

const braced = (name: string): string => `\${${name}}`
const CONFIG_ROOT = braced('CLAUDE_CONFIG_DIR')

const fixtureEntries: FakeEntry[] = [
  { kind: 'file', path: '.claude/settings.json', content: '{"model":"opus"}' },
  { kind: 'file', path: '.claude/CLAUDE.md', content: '# rules\n' },
  { kind: 'file', path: '.claude/rules/style.md', content: '# style\n' },
  { kind: 'file', path: '.claude/agents/reviewer.md', content: '# reviewer\n' },
  { kind: 'file', path: '.claude/commands/ship.md', content: '# ship\n' },
  { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# commit\n' },
  { kind: 'file', path: '.claude/skills/synced/account/SKILL.md', content: '# synced\n' },
  { kind: 'file', path: '.claude/output-styles/terse.md', content: '# terse\n' },
  { kind: 'file', path: '.claude/themes/dark.json', content: '{"name":"dark"}' },
  { kind: 'file', path: '.claude/workflows/flow.md', content: '# flow\n' },
  { kind: 'file', path: '.claude/keybindings.json', content: '{"bindings":[]}' },
  { kind: 'file', path: '.claude/hooks/session-start.sh', content: '#!/bin/sh\n' },
  { kind: 'file', path: '.claude/statusline.sh', content: '#!/bin/sh\n' },
  { kind: 'file', path: '.claude/plugins/installed_plugins.json', content: '{"version":2}' },
  { kind: 'file', path: '.claude/plugins/known_marketplaces.json', content: '{}' },
  { kind: 'file', path: '.claude/.credentials.json', content: '{"token":"redacted"}' },
  { kind: 'file', path: '.claude/settings.local.json', content: '{"permissions":{}}' },
  { kind: 'file', path: '.claude/history.jsonl', content: '{"prompt":"redacted"}\n' },
  { kind: 'file', path: '.claude/stats-cache.json', content: '{}' },
  { kind: 'file', path: '.claude/sessions/123.json', content: '{}' },
  { kind: 'file', path: '.claude/shell-snapshots/snap.sh', content: '#!/bin/sh\n' },
  { kind: 'file', path: '.claude/backups/.claude.json.backup', content: '{}' },
  { kind: 'file', path: '.claude/cache/model-catalog.json', content: '{}' },
  { kind: 'file', path: '.claude/jobs/pins.json', content: '{}' },
  { kind: 'file', path: '.claude/daemon/control.key', content: 'redacted' },
  { kind: 'file', path: '.claude/plugins/cache/official/plugin/index.js', content: 'x\n' },
  { kind: 'file', path: '.claude/plugins/marketplaces/official/marketplace.json', content: '{}' },
  { kind: 'file', path: '.claude/plugins/data/official/data.json', content: '{}' },
  { kind: 'file', path: '.claude/plugins/synced/account/skill.md', content: '# synced\n' },
  { kind: 'file', path: '.claude/plugins/.last_inuse_sweep', content: '0' },
  { kind: 'file', path: '.claude/.last-cleanup', content: '0' },
  { kind: 'file', path: '.claude/CLAUDEX.md', content: '# unlisted\n' },
  { kind: 'file', path: '.claude/projects/-Users-test-repo/abc.jsonl', content: '{"line":1}\n' },
  {
    kind: 'file',
    path: '.claude/projects/-Users-test-repo/memory/MEMORY.md',
    content: '# memory\n',
  },
  { kind: 'file', path: '.claude/projects/-Users-test-repo/memory/topic.md', content: '# topic\n' },
  {
    kind: 'file',
    path: '.claude/projects/-Users-test-repo/subagents/agent.jsonl',
    content: '{}\n',
  },
  { kind: 'file', path: '.claude/projects/.DS_Store', content: 'junk' },
]

function fixtureHome(): FakeHome {
  return buildFakeHome({ entries: fixtureEntries })
}

function scanClaude(home: FakeHome, ctx: AdapterContext = home.ctx): ScanResult {
  return scan({
    adapters: [claudeAdapter],
    ctx,
    deviceId,
    revisionId,
    createdAt,
  })
}

function classification(result: ScanResult, localPath: string): EntryClass {
  const entry = result.entries.find(
    (candidate) => candidate.localPath === localPath && candidate.classification !== 'nested',
  )
  if (entry === undefined) throw new Error(`missing entry ${localPath}`)
  return entry.classification
}

function entryFor(result: ScanResult, localPath: string): ScannedEntry {
  const entry = result.entries.find(
    (candidate) => candidate.localPath === localPath && candidate.classification !== 'nested',
  )
  if (entry === undefined) throw new Error(`missing entry ${localPath}`)
  return entry
}

describe('claude surface map', () => {
  test('every fixture path is classified by the policy table', () => {
    const home = fixtureHome()
    const result = scanClaude(home)
    const cases: Array<[string, EntryClass]> = [
      ['.claude/settings.json', 'sync'],
      ['.claude/CLAUDE.md', 'sync'],
      ['.claude/rules/style.md', 'sync'],
      ['.claude/agents/reviewer.md', 'sync'],
      ['.claude/commands/ship.md', 'sync'],
      ['.claude/skills/commit/SKILL.md', 'sync'],
      ['.claude/skills/synced', 'excluded'],
      ['.claude/output-styles/terse.md', 'sync'],
      ['.claude/themes/dark.json', 'sync'],
      ['.claude/workflows/flow.md', 'sync'],
      ['.claude/keybindings.json', 'sync'],
      ['.claude/hooks/session-start.sh', 'sync'],
      ['.claude/statusline.sh', 'sync'],
      ['.claude/plugins/installed_plugins.json', 'sync'],
      ['.claude/plugins/known_marketplaces.json', 'sync'],
      ['.claude/.credentials.json', 'never'],
      ['.claude/settings.local.json', 'never'],
      ['.claude/history.jsonl', 'never'],
      ['.claude/stats-cache.json', 'never'],
      ['.claude/sessions/123.json', 'never'],
      ['.claude/shell-snapshots/snap.sh', 'never'],
      ['.claude/backups/.claude.json.backup', 'never'],
      ['.claude/cache/model-catalog.json', 'never'],
      ['.claude/jobs/pins.json', 'never'],
      ['.claude/daemon/control.key', 'never'],
      ['.claude/plugins/cache/official/plugin/index.js', 'never'],
      ['.claude/plugins/marketplaces/official/marketplace.json', 'never'],
      ['.claude/plugins/data/official/data.json', 'never'],
      ['.claude/plugins/synced/account/skill.md', 'never'],
      ['.claude/plugins/.last_inuse_sweep', 'never'],
      ['.claude/.last-cleanup', 'never'],
      ['.claude/CLAUDEX.md', 'never'],
      // Memory owns the projects/ tree; transcripts are excluded before they are read.
      ['.claude/projects/-Users-test-repo/subagents', 'excluded'],
      ['.claude/projects/-Users-test-repo/abc.jsonl', 'excluded'],
      ['.claude/projects/.DS_Store', 'excluded'],
      ['.claude/projects/-Users-test-repo/memory/MEMORY.md', 'opt-in'],
      ['.claude/projects/-Users-test-repo/memory/topic.md', 'opt-in'],
    ]
    for (const [relative, expected] of cases) {
      expect([relative, classification(result, home.path(relative))]).toEqual([relative, expected])
    }
    expect(result.entries.some((entry) => entry.classification === 'unreadable')).toBe(false)
    expect(result.entries.some((entry) => entry.classification === 'unsupported')).toBe(false)
    home.cleanup()
  })

  test('never paths are never read, hashed, or stored', () => {
    const home = fixtureHome()
    const result = scanClaude(home)
    const neverPaths = [
      '.claude/.credentials.json',
      '.claude/settings.local.json',
      '.claude/history.jsonl',
      '.claude/stats-cache.json',
      '.claude/sessions/123.json',
      '.claude/plugins/cache/official/plugin/index.js',
      '.claude/plugins/.last_inuse_sweep',
      '.claude/CLAUDEX.md',
    ]
    const neverSuffixes = [
      '.credentials.json',
      'settings.local.json',
      'history.jsonl',
      'stats-cache.json',
      'sessions/',
      'plugins/cache/',
      '.last_inuse_sweep',
      'CLAUDEX.md',
      '.DS_Store',
    ]
    const manifestPaths = result.manifest.entries.map((entry) => entry.path)
    for (const relative of neverPaths) {
      const entry = entryFor(result, home.path(relative))
      expect([relative, entry.classification]).toEqual([relative, 'never'])
      expect(entry.storePath).toBeNull()
      expect(entry.hash).toBeNull()
    }
    for (const suffix of neverSuffixes) {
      expect(manifestPaths.some((stored) => stored.includes(suffix))).toBe(false)
    }
    home.cleanup()
  })

  test('transcripts stay out of the manifest while memory is hashed as opt-in', () => {
    const home = fixtureHome()
    const result = scanClaude(home)
    const transcript = entryFor(result, home.path('.claude/projects/-Users-test-repo/abc.jsonl'))
    expect(transcript.classification).toBe('excluded')
    expect(transcript.storePath).toBeNull()
    expect(transcript.hash).toBeNull()

    const memory = entryFor(result, home.path('.claude/projects/-Users-test-repo/memory/MEMORY.md'))
    expect(memory.classification).toBe('opt-in')
    expect(memory.storePath).toBe(`${CONFIG_ROOT}/projects/-Users-test-repo/memory/MEMORY.md`)
    expect(memory.hash).toMatch(/^[0-9a-f]{64}$/)

    const manifestPaths = result.manifest.entries.map((entry) => entry.path)
    expect(manifestPaths).toContain(`${CONFIG_ROOT}/projects/-Users-test-repo/memory/MEMORY.md`)
    expect(manifestPaths.some((path) => path.endsWith('.jsonl'))).toBe(false)
    home.cleanup()
  })

  test('the declared map matches DESIGN section 2', () => {
    const home = fixtureHome()
    const surfaces = claudeSurfaces(home.ctx)
    const byId = new Map(surfaces.map((surface) => [surface.id, surface]))
    const get = (id: string): Surface => {
      const surface = byId.get(SurfaceId.parse(id))
      if (surface === undefined) throw new Error(`missing surface ${id}`)
      return surface
    }

    expect(get('claude.settings').policy).toBe('sync')
    expect(get('claude.settings').transforms).toEqual([{ kind: 'pathTokenize' }])
    expect(get('claude.skills')).toMatchObject({
      kind: 'tree',
      exclude: ['synced', 'synced/**'],
    })
    expect(get('claude.memory').policy).toBe('opt-in')
    expect(get('claude.memory').transforms).toEqual([{ kind: 'claudeSlugRekey' }])
    expect(get('claude.plugins-installed').transforms).toEqual([{ kind: 'claudePluginRecords' }])
    expect(get('claude.plugins-known-marketplaces').transforms).toEqual([
      { kind: 'claudePluginRecords' },
    ])
    expect(get('claude.plugins-marketplaces').policy).toBe('never')
    expect(get('claude.mcp').transforms).toEqual([{ kind: 'claudeMcpExtract' }])
    expect(get('claude.mcp').path).toBe('$HOME/.claude.json')
    expect(get('claude.credentials').policy).toBe('never')
    expect(get('claude.state').policy).toBe('never')
    expect(get('claude.managed-policy').policy).toBe('never')
    expect(get('claude.managed-policy').path).toBe('/Library/Application Support/ClaudeCode')

    const overridden = claudeSurfaces({
      ...home.ctx,
      env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    })
    const mcp = overridden.find((surface) => surface.id === SurfaceId.parse('claude.mcp'))
    expect(mcp?.path).toBe(`${CONFIG_ROOT}/.claude.json`)
    const linux = claudeSurfaces({ ...home.ctx, platform: 'linux' })
    expect(
      linux.find((surface) => surface.id === SurfaceId.parse('claude.managed-policy'))?.path,
    ).toBe('/etc/claude-code')
    home.cleanup()
  })

  test('a symlinked skills root stays a link and its content is scanned through it', () => {
    const home = buildFakeHome({
      entries: [{ kind: 'file', path: '.agents/skills/shared/SKILL.md', content: '# shared\n' }],
    })
    home.symlink('.claude/skills', '$HOME/.agents/skills')
    const result = scanClaude(home)

    expect(result.layout.entries).toContainEqual({
      path: home.path('.claude/skills'),
      mode: 'symlink',
      linkTarget: home.path('.agents/skills'),
    })
    const entry = entryFor(result, home.path('.agents/skills/shared/SKILL.md'))
    expect(entry.surfaceId).toBe(SurfaceId.parse('claude.skills'))
    expect(entry.classification).toBe('sync')
    expect(entry.storePath).toBe(`${CONFIG_ROOT}/skills/shared/SKILL.md`)
    // The enclosing state tree records the root link itself; it is never dereferenced.
    const link = entryFor(result, home.path('.claude/skills'))
    expect(link.kind).toBe('symlink')
    expect(link.classification).toBe('link')
    expect(link.linkTarget).toBe(home.path('.agents/skills'))
    expect(home.read('.agents/skills/shared/SKILL.md')).toBe('# shared\n')
    home.cleanup()
  })

  test('the built-in registry accepts every claude surface without collisions', () => {
    const home = buildFakeHome({ entries: [] })
    expect(builtinAdapters.map((adapter) => adapter.id)).toContain('claude')
    const inventory = createAdapterRegistry(builtinAdapters).inventory(home.ctx)
    const ids = inventory.map((entry) => entry.surface.id)
    expect(ids).toContain(SurfaceId.parse('claude.settings'))
    expect(new Set(ids).size).toBe(ids.length)
    home.cleanup()
  })
})

describe('claude detection', () => {
  const base: AdapterContext = { home: '/Users/test', platform: 'darwin', env: {} }

  test('reads installed and version from the CLI probe', () => {
    const detection = detectClaude({
      ...base,
      probes: { claude: { installed: true, version: '2.1.277', notes: ['probe ok'] } },
    })
    expect(detection.installed).toBe(true)
    expect(detection.version).toBe('2.1.277')
    expect(detection.configRoots).toEqual([CONFIG_ROOT])
    expect(detection.notes).toEqual(['probe ok'])
  })

  test('reports a missing probe instead of guessing', () => {
    const detection = detectClaude(base)
    expect(detection.installed).toBe(false)
    expect(detection.version).toBeUndefined()
    expect(detection.notes.join(' ')).toContain('no claude probe')
  })

  test('notes the CLAUDE_CONFIG_DIR override', () => {
    const detection = detectClaude({
      ...base,
      env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
      probes: { claude: { installed: true, notes: [] } },
    })
    expect(detection.notes.join(' ')).toContain('CLAUDE_CONFIG_DIR')
  })
})
