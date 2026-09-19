import { describe, expect, test } from 'bun:test'
import { SurfaceId } from '@laurencio/protocol'
import { AdapterRegistryError, createAdapterRegistry } from '../src/adapters/registry'
import { detectionReport } from '../src/adapters/types'
import { file, testAdapter, tree } from './helpers/adapter-fixtures'
import { buildFakeHome } from './helpers/fake-home'

const sid = SurfaceId.parse

describe('createAdapterRegistry', () => {
  test('lists surfaces sorted by id', () => {
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.claude' }] })
    const registry = createAdapterRegistry([
      testAdapter('claude', [
        tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
        file({ id: 'claude.settings', path: '$HOME/.claude/settings.json' }),
      ]),
    ])
    const inventory = registry.inventory(home.ctx)
    expect(inventory.map((entry) => entry.surface.id)).toEqual([
      sid('claude.settings'),
      sid('claude.skills'),
    ])
    home.cleanup()
  })

  test('rejects duplicate adapter ids at creation', () => {
    const registry = () =>
      createAdapterRegistry([testAdapter('claude', []), testAdapter('claude', [])])
    expect(registry).toThrow(AdapterRegistryError)
    try {
      registry()
    } catch (error) {
      expect((error as AdapterRegistryError).kind).toBe('duplicate-adapter')
    }
  })

  test('rejects duplicate surface ids', () => {
    const home = buildFakeHome({ entries: [] })
    const registry = createAdapterRegistry([
      testAdapter('claude', [file({ id: 'claude.settings', path: '$HOME/.claude/a.json' })]),
      testAdapter('codex', [file({ id: 'claude.settings', path: '$HOME/.codex/b.json' })]),
    ])
    expect(() => registry.inventory(home.ctx)).toThrow(AdapterRegistryError)
    home.cleanup()
  })

  test('rejects two adapters declaring the same path template', () => {
    const home = buildFakeHome({ entries: [] })
    const registry = createAdapterRegistry([
      testAdapter('claude', [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })]),
      testAdapter('codex', [tree({ id: 'codex.skills', path: '$HOME/.claude/skills' })]),
    ])
    try {
      registry.inventory(home.ctx)
      throw new Error('expected inventory to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterRegistryError)
      expect((error as AdapterRegistryError).kind).toBe('duplicate-path')
      expect((error as AdapterRegistryError).paths).toEqual(['$HOME/.claude/skills'])
    }
    home.cleanup()
  })

  test('different token spellings of one physical tree pass the registry and collide in ownership', () => {
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.claude/skills' }] })
    const registry = createAdapterRegistry([
      testAdapter('claude', [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })]),
      testAdapter('codex', [tree({ id: 'codex.skills', path: `\${CLAUDE_CONFIG_DIR}/skills` })]),
    ])
    expect(() => registry.inventory(home.ctx)).not.toThrow()
    home.cleanup()
  })

  test('a shared tree may declare the same path as a direct owner', () => {
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.agents/skills' }] })
    const registry = createAdapterRegistry([
      testAdapter('codex', [
        tree({ id: 'codex.skills', path: '$HOME/.agents/skills', shared: true }),
      ]),
      testAdapter('opencode', [tree({ id: 'opencode.skills', path: '$HOME/.agents/skills' })]),
    ])
    expect(() => registry.inventory(home.ctx)).not.toThrow()
    home.cleanup()
  })
})

describe('detectionReport', () => {
  test('normalizes optional detection fields', () => {
    const home = buildFakeHome({ entries: [] })
    const report = detectionReport(
      {
        id: 'claude',
        displayName: 'Claude Code',
        detect: () => ({ installed: false, configRoots: ['$HOME/.claude'], notes: ['not found'] }),
        surfaces: () => [],
      },
      home.ctx,
    )
    expect(report).toEqual({
      adapterId: 'claude',
      displayName: 'Claude Code',
      installed: false,
      version: null,
      configRoots: ['$HOME/.claude'],
      notes: ['not found'],
    })
    home.cleanup()
  })
})
