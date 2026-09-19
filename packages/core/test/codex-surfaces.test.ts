import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { codexAdapter } from '../src/adapters/codex'
import { builtinAdapters } from '../src/adapters/registry'
import { type ScannedEntry, scan } from '../src/scan'
import type { AdapterContext } from '../src/types'
import { buildCodexHome } from './helpers/codex-fixture'

const sid = SurfaceId.parse
const deviceId = DeviceId.parse('00000000000000000000000000')
const revisionId = RevisionId.parse('00000000000000000000000000')
const createdAt = '2026-09-19T00:00:00.000Z'

function scanCodex(ctx: AdapterContext) {
  return scan({ adapters: [codexAdapter], ctx, deviceId, revisionId, createdAt })
}

function classesFor(entries: readonly ScannedEntry[], suffix: string): string[] {
  return entries
    .filter((entry) => entry.localPath.endsWith(suffix))
    .map((entry) => entry.classification)
    .filter((classification) => classification !== 'nested')
}

describe('codex surfaces', () => {
  test('classifies every known path from DESIGN section 2', () => {
    const home = buildCodexHome()
    const result = scanCodex(home.ctx)

    const syncPaths = [
      '/.codex/config.toml',
      '/.codex/.config.toml',
      '/.codex/work.config.toml',
      '/.codex/AGENTS.md',
      '/.codex/AGENTS.override.md',
      '/.codex/hooks.json',
      '/.codex/rules/default.rules',
      '/.codex/skills/local/SKILL.md',
      '/.agents/skills/shared/SKILL.md',
      '/.codex/automations/daily/automation.toml',
      '/.codex/automations/daily/memory.md',
    ]
    for (const path of syncPaths) {
      expect(classesFor(result.entries, path), path).toEqual(['sync'])
    }

    const neverPaths = [
      '/.codex/auth.json',
      '/.codex/.codex-global-state.json',
      '/.codex/history.jsonl',
      '/.codex/session_index.jsonl',
      '/.codex/sessions/2026/rollout.jsonl',
      '/.codex/archived_sessions/old.jsonl',
      '/.codex/plugins/cache/blob',
      '/.codex/cache/blob',
      '/.codex/log/codex.log',
      '/.codex/tmp/scratch',
      '/.codex/sqlite/aux',
      '/.codex/state_5.sqlite',
      '/.codex/logs_2.sqlite-wal',
      '/.codex/memories_1.sqlite',
    ]
    for (const path of neverPaths) {
      expect(classesFor(result.entries, path), path).toContain('never')
      expect(classesFor(result.entries, path), path).not.toContain('sync')
    }

    expect(classesFor(result.entries, '/.codex/.tmp')).toContain('excluded')
    expect(classesFor(result.entries, '/.codex/computer-use')).toContain('excluded')

    const homeSurface = result.surfaces.find((surface) => surface.surfaceId === sid('codex.home'))
    expect(homeSurface?.policy).toBe('never')
    home.cleanup()
  })

  test('uploads only declared sync surfaces', () => {
    const home = buildCodexHome()
    const result = scanCodex(home.ctx)
    const syncSurfaces = new Set([
      'codex.config',
      'codex.default-profile',
      'codex.instructions',
      'codex.instructions-override',
      'codex.hooks',
      'codex.rules',
      'codex.skills',
      'codex.agents-skills',
      'codex.automations',
    ])
    // Profile files sync through the never `codex.home` tree as per-file overrides.
    const homeProfiles = new Set([`\${CODEX_HOME}/work.config.toml`])
    expect(result.manifest.entries.length).toBeGreaterThan(0)
    for (const entry of result.manifest.entries) {
      const declared = syncSurfaces.has(entry.surfaceId) || homeProfiles.has(entry.path)
      expect(declared, entry.path).toBe(true)
      expect(entry.path).not.toContain('sqlite')
      expect(entry.path).not.toContain('auth.json')
    }
    home.cleanup()
  })

  test('syncs named profile files while machine state in the same tree stays never', () => {
    const home = buildCodexHome()
    const result = scanCodex(home.ctx)

    expect(classesFor(result.entries, '/.codex/work.config.toml')).toEqual(['sync'])
    const profile = result.manifest.entries.find(
      (entry) => entry.path === `\${CODEX_HOME}/work.config.toml`,
    )
    expect(profile?.surfaceId).toBe(sid('codex.home'))
    expect(profile?.hash).toMatch(/^[0-9a-f]{64}$/)

    const config = result.manifest.entries.filter(
      (entry) => entry.surfaceId === sid('codex.config'),
    )
    expect(config.map((entry) => entry.path)).toEqual([`\${CODEX_HOME}/config.toml`])

    const machineSuffixes = [
      '/.codex/auth.json',
      '/.codex/history.jsonl',
      '/.codex/session_index.jsonl',
      '/.codex/sessions/2026/rollout.jsonl',
      '/.codex/archived_sessions/old.jsonl',
      '/.codex/state_5.sqlite',
      '/.codex/memories_1.sqlite',
    ]
    for (const suffix of machineSuffixes) {
      const entries = result.entries.filter((entry) => entry.localPath.endsWith(suffix))
      expect(entries.length, suffix).toBeGreaterThan(0)
      for (const entry of entries) {
        expect(entry.classification, suffix).not.toBe('sync')
        expect(entry.classification, suffix).not.toBe('opt-in')
        expect(entry.hash, suffix).toBeNull()
        expect(entry.storePath, suffix).toBeNull()
      }
    }
    home.cleanup()
  })

  test('gives the shared skills tree one owner when it links elsewhere', () => {
    const home = buildCodexHome({ skillsLink: true })
    const result = scanCodex(home.ctx)
    expect(result.ownership).toEqual([
      {
        surfaceId: sid('codex.skills'),
        resolvedPath: home.path('.agents/skills'),
        referencedBy: [sid('codex.agents-skills')],
      },
    ])
    expect(classesFor(result.entries, '/.agents/skills/shared/SKILL.md')).toEqual(['sync'])
    home.cleanup()
  })

  test('resolves both skills trees independently when neither links', () => {
    const home = buildCodexHome()
    const result = scanCodex(home.ctx)
    expect(result.ownership).toEqual([])
    const skills = result.surfaces.find((surface) => surface.surfaceId === sid('codex.skills'))
    const agentsSkills = result.surfaces.find(
      (surface) => surface.surfaceId === sid('codex.agents-skills'),
    )
    expect(skills?.role).toBe('owner')
    expect(skills?.owner).toBe(sid('codex.skills'))
    expect(agentsSkills?.role).toBe('owner')
    expect(agentsSkills?.owner).toBe(sid('codex.agents-skills'))
  })

  test('declares the surface map, including never auth and shared agent skills', () => {
    const home = buildCodexHome()
    const surfaces = codexAdapter.surfaces(home.ctx)
    const byPath = new Map(surfaces.map((surface) => [surface.path, surface]))
    const config = byPath.get(`\${CODEX_HOME}/config.toml`)
    expect(config?.kind).toBe('keyed-file')
    expect(config?.policy).toBe('sync')
    expect(config?.transforms.map((transform) => transform.kind)).toEqual([
      'codexTomlSplit',
      'pathTokenize',
    ])
    if (config?.kind === 'keyed-file') {
      expect(config.keyPolicy.machine).toContain('projects')
      expect(config.keyPolicy.machine).toContain('hooks.state')
      expect(config.keyPolicy.machine).toContain('marketplaces.*.source')
      expect(config.keyPolicy.machine).toContain('shell_environment_policy.set')
    }
    expect(byPath.get(`\${CODEX_HOME}/auth.json`)?.policy).toBe('never')
    expect(byPath.get(`\${CODEX_HOME}/sessions`)?.policy).toBe('never')
    expect(byPath.get(`\${CODEX_HOME}/rules/default.rules`)?.policy).toBe('sync')
    const agentSkills = byPath.get('$HOME/.agents/skills')
    expect(agentSkills?.kind).toBe('tree')
    if (agentSkills?.kind === 'tree') expect(agentSkills.shared).toBe(true)
    const homeTree = byPath.get(`\${CODEX_HOME}`)
    expect(homeTree?.kind).toBe('tree')
    if (homeTree?.kind === 'tree') {
      expect(homeTree.filePolicy).toEqual([{ pattern: '*.config.toml', policy: 'sync' }])
    }
    expect(
      surfaces.some((surface) => surface.path === '/etc/codex' && surface.policy === 'never'),
    ).toBe(true)
    expect(codexAdapter.id).toBe('codex')
    expect(builtinAdapters.map((adapter) => adapter.id)).toContain('codex')
    home.cleanup()
  })

  test('honors a CODEX_HOME override from the environment', () => {
    const home = buildCodexHome()
    const ctx: AdapterContext = {
      ...home.ctx,
      env: { ...home.ctx.env, CODEX_HOME: home.path('custom-codex') },
    }
    home.write('custom-codex/config.toml', 'model = "gpt-5.6-codex"\n')
    const result = scanCodex(ctx)
    const config = result.surfaces.find((surface) => surface.surfaceId === sid('codex.config'))
    expect(config?.declaredPath).toBe(home.path('custom-codex/config.toml'))
    const homeSurface = result.surfaces.find((surface) => surface.surfaceId === sid('codex.home'))
    expect(homeSurface?.declaredPath).toBe(home.path('custom-codex'))
    expect(homeSurface?.exists).toBe(true)
    expect(result.entries.some((entry) => entry.localPath.endsWith('.codex/AGENTS.md'))).toBe(false)
    home.cleanup()
  })
})
