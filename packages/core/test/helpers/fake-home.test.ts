import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { buildFakeHome } from './fake-home'

describe('buildFakeHome', () => {
  test('creates plain files and directories with explicit modes', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.claude/skills/commit' },
        { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# x\n', mode: 0o600 },
      ],
    })
    expect(home.read('.claude/skills/commit/SKILL.md')).toBe('# x\n')
    expect(home.lstat('.claude/skills/commit/SKILL.md').mode & 0o777).toBe(0o600)
    expect(home.lstat('.claude/skills/commit').isDirectory()).toBe(true)
    home.cleanup()
  })

  test('creates symlinks to $HOME-relative and absolute targets', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.agents-opencode/skills' },
        { kind: 'file', path: '.agents-opencode/skills/SKILL.md', content: 'x\n' },
        { kind: 'dir', path: '.config/opencode' },
      ],
    })
    home.symlink('.config/opencode/skills', '$HOME/.agents-opencode/skills')
    home.symlink('.config/opencode/absolute', home.path('.agents-opencode/skills/SKILL.md'))
    expect(fs.readlinkSync(home.path('.config/opencode/skills'))).toBe(
      home.path('.agents-opencode/skills'),
    )
    expect(fs.readlinkSync(home.path('.config/opencode/absolute'))).toBe(
      home.path('.agents-opencode/skills/SKILL.md'),
    )
    home.cleanup()
  })

  test('honors the ignore list and exposes the platform and env', () => {
    const home = buildFakeHome({
      platform: 'linux',
      env: { CODEX_HOME: '/opt/codex' },
      ignore: ['.claude/settings.json'],
      entries: [
        { kind: 'file', path: '.claude/settings.json', content: '{}' },
        { kind: 'file', path: '.claude/CLAUDE.md', content: '# x\n' },
      ],
    })
    expect(fs.existsSync(home.path('.claude/settings.json'))).toBe(false)
    expect(fs.existsSync(home.path('.claude/CLAUDE.md'))).toBe(true)
    expect(home.ctx.platform).toBe('linux')
    expect(home.ctx.env.CODEX_HOME).toBe('/opt/codex')
    home.cleanup()
  })

  test('copy mode materializes links as real trees for Windows-style layouts', () => {
    const home = buildFakeHome({
      linkMode: 'copy',
      entries: [
        { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# x\n' },
        { kind: 'dir', path: '.codex' },
        { kind: 'dir', path: '.codex/skills', link: '$HOME/.claude/skills' },
      ],
    })
    expect(fs.lstatSync(home.path('.codex/skills')).isDirectory()).toBe(true)
    expect(fs.lstatSync(home.path('.codex/skills')).isSymbolicLink()).toBe(false)
    expect(home.read('.codex/skills/commit/SKILL.md')).toBe('# x\n')
    home.cleanup()
  })

  test('cleanup removes the scratch directory', () => {
    const home = buildFakeHome({ entries: [{ kind: 'file', path: 'a.txt', content: 'a' }] })
    const dir = home.home
    home.cleanup()
    expect(fs.existsSync(dir)).toBe(false)
  })
})
