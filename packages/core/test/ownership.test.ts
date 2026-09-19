import { describe, expect, test } from 'bun:test'
import { SurfaceId } from '@laurencio/protocol'
import { OwnershipCollisionError, type ResolvedSurface, resolveOwnership } from '../src/ownership'
import type { Surface } from '../src/types'
import { file, testAdapter, tree } from './helpers/adapter-fixtures'
import { buildFakeHome, type FakeHome } from './helpers/fake-home'

const sid = SurfaceId.parse

function ownershipOf(
  home: FakeHome,
  surfaces: Surface[],
  adapterId: 'claude' | 'codex' | 'opencode' = 'claude',
) {
  return resolveOwnership(
    surfaces.map((surface) => ({ adapter: testAdapter(adapterId, [surface]), surface })),
    home.ctx,
  )
}

function byId(surfaces: ResolvedSurface[], id: string): ResolvedSurface {
  const found = surfaces.find((surface) => surface.registered.surface.id === id)
  if (found === undefined) throw new Error(`missing surface ${id}`)
  return found
}

describe('resolveOwnership', () => {
  test('one surface keeps ownership of its own tree', () => {
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.claude/skills' }] })
    const result = ownershipOf(home, [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })])
    const skills = byId(result.surfaces, 'claude.skills')
    expect(skills.role).toBe('owner')
    expect(skills.owner).toBe(sid('claude.skills'))
    expect(skills.exists).toBe(true)
    expect(result.refs).toEqual([])
    home.cleanup()
  })

  test('a symlinked tree becomes a reference to the direct owner', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.claude/skills' },
        { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: 'x' },
        { kind: 'dir', path: '.codex' },
      ],
    })
    home.symlink('.codex/skills', '$HOME/.claude/skills')
    const result = ownershipOf(home, [
      tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
      tree({ id: 'codex.skills', path: '$HOME/.codex/skills' }),
    ])
    expect(byId(result.surfaces, 'claude.skills').role).toBe('owner')
    expect(byId(result.surfaces, 'claude.skills').linkedBy).toEqual([sid('codex.skills')])
    const codex = byId(result.surfaces, 'codex.skills')
    expect(codex.role).toBe('reference')
    expect(codex.owner).toBe(sid('claude.skills'))
    expect(result.refs).toEqual([
      {
        surfaceId: sid('claude.skills'),
        resolvedPath: home.path('.claude/skills'),
        referencedBy: [sid('codex.skills')],
      },
    ])
    home.cleanup()
  })

  test('two direct declarations of one resolved path collide', () => {
    const home = buildFakeHome({
      entries: [{ kind: 'dir', path: '.claude/skills' }],
      env: { CLAUDE_CONFIG_DIR: '' },
    })
    home.ctx.env.CLAUDE_CONFIG_DIR = home.path('.claude')
    try {
      ownershipOf(home, [
        tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
        tree({ id: 'codex.skills', path: `\${CLAUDE_CONFIG_DIR}/skills` }),
      ])
      throw new Error('expected ownership to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(OwnershipCollisionError)
      expect((error as OwnershipCollisionError).reason).toBe('multiple-owners')
      expect((error as OwnershipCollisionError).surfaceIds).toEqual([
        sid('claude.skills'),
        sid('codex.skills'),
      ])
    }
    home.cleanup()
  })

  test('a shared declaration loses to the direct owner instead of colliding', () => {
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.agents/skills' }] })
    const result = ownershipOf(
      home,
      [
        tree({ id: 'codex.skills', path: '$HOME/.agents/skills', shared: true }),
        tree({ id: 'opencode.skills', path: '$HOME/.agents/skills' }),
      ],
      'codex',
    )
    expect(byId(result.surfaces, 'opencode.skills').role).toBe('owner')
    expect(byId(result.surfaces, 'codex.skills').role).toBe('reference')
    home.cleanup()
  })

  test('a file surface linked into an owned tree becomes a reference', () => {
    const home = buildFakeHome({
      entries: [{ kind: 'file', path: '.agents-opencode/agents.md', content: '# rules' }],
    })
    home.symlink('.config/opencode/AGENTS.md', '$HOME/.agents-opencode/agents.md')
    const result = ownershipOf(
      home,
      [
        tree({ id: 'opencode.agents-opencode', path: '$HOME/.agents-opencode' }),
        file({ id: 'opencode.agents', path: '$HOME/.config/opencode/AGENTS.md' }),
      ],
      'opencode',
    )
    const agents = byId(result.surfaces, 'opencode.agents')
    expect(agents.role).toBe('reference')
    expect(agents.owner).toBe(sid('opencode.agents-opencode'))
    expect(result.refs).toEqual([
      {
        surfaceId: sid('opencode.agents-opencode'),
        resolvedPath: home.path('.agents-opencode/agents.md'),
        referencedBy: [sid('opencode.agents')],
      },
    ])
    home.cleanup()
  })

  test('a missing root stays a self-owned surface', () => {
    const home = buildFakeHome({ entries: [] })
    const result = ownershipOf(home, [tree({ id: 'claude.skills', path: '$HOME/.claude/skills' })])
    const skills = byId(result.surfaces, 'claude.skills')
    expect(skills.exists).toBe(false)
    expect(skills.role).toBe('owner')
    expect(skills.owner).toBe(sid('claude.skills'))
    home.cleanup()
  })
})
