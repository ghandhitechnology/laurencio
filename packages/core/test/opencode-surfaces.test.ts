import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import { type ParseError, parse } from 'jsonc-parser'
import { opencodeAdapter } from '../src/adapters/opencode'
import { OPENCODE_CONFIG_ROOT } from '../src/adapters/opencode/detect'
import { OPENCODE_PROJECT_SURFACES, opencodeSurfaces } from '../src/adapters/opencode/surfaces'
import { opencodePathRewrite, opencodeSchemaNormalize } from '../src/adapters/opencode/transforms'
import { builtinAdapters, createAdapterRegistry } from '../src/adapters/registry'
import type { TokenEnv } from '../src/paths'
import { scan } from '../src/scan'
import { testAdapter, tree } from './helpers/adapter-fixtures'
import { buildFakeHome } from './helpers/fake-home'
import { buildOpenCodeHome, withOpenCodeProbe } from './helpers/opencode-fixtures'

const sid = SurfaceId.parse
const deviceId = DeviceId.parse('00000000000000000000000000')
const revisionId = RevisionId.parse('00000000000000000000000000')
const createdAt = '2026-01-01T00:00:00.000Z'

describe('opencode surfaces', () => {
  test('declares every DESIGN section 2 row with the right policy', () => {
    const home = buildOpenCodeHome()
    const surfaces = opencodeSurfaces(withOpenCodeProbe(home.ctx))
    const byId = new Map(surfaces.map((surface) => [surface.id, surface]))
    const syncIds = [
      'opencode.config-json',
      'opencode.config-jsonc',
      'opencode.cli',
      'opencode.tui',
      'opencode.instructions',
      'opencode.agents',
      'opencode.commands',
      'opencode.skills',
      'opencode.themes',
      'opencode.plugins',
      'opencode.package',
      'opencode.package-lock',
      'opencode.bun-lock',
      'opencode.tools',
      'opencode.source',
      'opencode.claude-skills',
      'opencode.agents-skills',
    ]
    for (const id of syncIds) {
      expect(byId.get(sid(id))?.policy).toBe('sync')
    }
    const neverIds = [
      'opencode.service',
      'opencode.node-modules',
      'opencode.data',
      'opencode.auth',
      'opencode.database',
      'opencode.mcp-auth',
      'opencode.state',
      'opencode.cache',
    ]
    for (const id of neverIds) {
      expect(byId.get(sid(id))?.policy).toBe('never')
    }
    expect(byId.get(sid('opencode.config-json'))?.path).toBe(
      `${OPENCODE_CONFIG_ROOT}/opencode.json`,
    )
    expect(byId.get(sid('opencode.plugins'))?.kind).toBe('tree')
    home.cleanup()
  })

  test('project surfaces are declared never with a repo-git reason', () => {
    expect(OPENCODE_PROJECT_SURFACES.map((surface) => surface.path)).toEqual([
      '.opencode/',
      'opencode.json',
      'opencode.jsonc',
      '.well-known/opencode/',
    ])
    for (const surface of OPENCODE_PROJECT_SURFACES) {
      expect(surface.policy).toBe('never')
      expect(surface.reason.length).toBeGreaterThan(0)
    }
    expect(
      OPENCODE_PROJECT_SURFACES.filter((surface) => surface.reason.includes('repository git')),
    ).toHaveLength(3)
  })

  test('upload projections never contain secret stores, state, cache, or node_modules', () => {
    const home = buildOpenCodeHome()
    const result = scan({
      adapters: [opencodeAdapter],
      ctx: withOpenCodeProbe(home.ctx),
      deviceId,
      revisionId,
      createdAt,
    })
    const forbidden = [
      '/service.json',
      '/node_modules/',
      '/auth.json',
      '/mcp-auth.json',
      '/opencode.db',
      '/.local/state/',
      '/.cache/opencode/',
    ]
    for (const entry of result.manifest.entries) {
      expect(forbidden.some((suffix) => entry.path.includes(suffix))).toBe(false)
    }
    const neverLocal = [
      home.path('.config/opencode/service.json'),
      home.path('.config/opencode/node_modules/dep/index.js'),
      home.path('.local/share/opencode/auth.json'),
      home.path('.local/share/opencode/opencode.db'),
      home.path('.local/share/opencode/mcp-auth.json'),
      home.path('.local/state/opencode/model.json'),
      home.path('.cache/opencode/models.json'),
    ]
    for (const localPath of neverLocal) {
      expect(
        result.entries.some(
          (entry) => entry.localPath === localPath && entry.classification === 'never',
        ),
      ).toBe(true)
    }
    home.cleanup()
  })

  test('node_modules inside plugins is excluded, not walked', () => {
    const home = buildOpenCodeHome()
    const result = scan({
      adapters: [opencodeAdapter],
      ctx: withOpenCodeProbe(home.ctx),
      deviceId,
      revisionId,
      createdAt,
    })
    const excluded = result.entries.find(
      (entry) => entry.localPath === home.path('.config/opencode/plugins/node_modules'),
    )
    expect(excluded?.classification).toBe('excluded')
    const nodeModulesPrefix = `${home.path('.config/opencode/plugins/node_modules')}/`
    expect(result.entries.some((entry) => entry.localPath.startsWith(nodeModulesPrefix))).toBe(
      false,
    )
    home.cleanup()
  })

  test('symlinked AGENTS.md, agents, and skills are reported as links, never dereferenced', () => {
    const home = buildOpenCodeHome()
    const result = scan({
      adapters: [opencodeAdapter],
      ctx: withOpenCodeProbe(home.ctx),
      deviceId,
      revisionId,
      createdAt,
    })
    const linkCases: [string, string][] = [
      ['.config/opencode/AGENTS.md', home.path('.agents-opencode/agents.md')],
      ['.config/opencode/agents', home.path('.agents-opencode/agents')],
      ['.config/opencode/skills', home.path('.agents-opencode/skills')],
    ]
    for (const [relative, target] of linkCases) {
      const declaredPath = home.path(relative)
      const report = result.surfaces.find((surface) => surface.declaredPath === declaredPath)
      expect(report?.role).toBe('reference')
      expect(report?.owner).toBe(sid('opencode.source'))
      expect(result.layout.entries).toContainEqual({
        path: declaredPath,
        mode: 'symlink',
        linkTarget: target,
      })
    }
    // The content lives once, under the source tree.
    const agentsManifest = result.manifest.entries.filter((entry) =>
      entry.path.endsWith('/agents.md'),
    )
    expect(agentsManifest.map((entry) => entry.path)).toEqual(['$HOME/.agents-opencode/agents.md'])
    home.cleanup()
  })

  test('shared skill trees resolve to the direct owner', () => {
    const home = buildFakeHome({
      entries: [{ kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# commit\n' }],
    })
    const claude = testAdapter('claude', [
      tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
    ])
    const result = scan({
      adapters: [opencodeAdapter, claude],
      ctx: withOpenCodeProbe(home.ctx),
      deviceId,
      revisionId,
      createdAt,
    })
    expect(result.ownership).toContainEqual({
      surfaceId: sid('claude.skills'),
      resolvedPath: home.path('.claude/skills'),
      referencedBy: [sid('opencode.claude-skills')],
    })
    home.cleanup()
  })

  test('the v2 config projects to valid JSONC with both key spellings and no absolute paths', () => {
    const home = buildOpenCodeHome()
    const raw = home.read('.config/opencode/opencode.jsonc')
    const normalized = opencodeSchemaNormalize(raw, 'upload')
    const tokenEnv: TokenEnv = { home: home.home, platform: home.ctx.platform, env: home.ctx.env }
    const tokenized = opencodePathRewrite(normalized.text, 'tokenize', tokenEnv)
    const errors: ParseError[] = []
    parse(tokenized.text, errors, { allowTrailingComma: true, disallowComments: false })
    expect(errors).toEqual([])
    expect(tokenized.text).toContain('// Skills and agents live in ~/.agents-opencode.')
    expect(tokenized.text).toContain('"plugin"')
    expect(tokenized.text).toContain('"plugins"')
    expect(tokenized.text).toContain('"servers"')
    expect(tokenized.text).toContain('"unknown_future_key"')
    expect(tokenized.text).not.toContain(home.home)
    home.cleanup()
  })

  test('registry inventory is sorted and rejects nothing', () => {
    const home = buildOpenCodeHome()
    const registry = createAdapterRegistry([opencodeAdapter])
    const inventory = registry.inventory(withOpenCodeProbe(home.ctx))
    const ids = inventory.map((entry) => entry.surface.id)
    expect(ids.length).toBe(opencodeSurfaces(home.ctx).length)
    expect([...ids].sort()).toEqual(ids)
    expect(builtinAdapters).toContain(opencodeAdapter)
    home.cleanup()
  })
})
