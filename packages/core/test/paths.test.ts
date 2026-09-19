import { describe, expect, test } from 'bun:test'
import {
  expand,
  joinStorePath,
  PATH_TOKENS,
  PathError,
  type TokenEnv,
  tokenize,
  tokenValue,
} from '../src/paths'

const env = (overrides: Record<string, string | undefined> = {}): TokenEnv => ({
  home: '/u/home',
  platform: 'darwin',
  env: overrides,
})

describe('expand', () => {
  test('expands $HOME and braced tokens', () => {
    expect(expand('$HOME/.claude/skills', env())).toBe('/u/home/.claude/skills')
    expect(expand(`\${CODEX_HOME}/skills`, env())).toBe('/u/home/.codex/skills')
    expect(expand(`\${CLAUDE_CONFIG_DIR}/settings.json`, env())).toBe(
      '/u/home/.claude/settings.json',
    )
    expect(expand(`\${XDG_CONFIG_HOME}/opencode`, env())).toBe('/u/home/.config/opencode')
  })

  test('environment overrides win over defaults', () => {
    const custom = env({
      CODEX_HOME: '/opt/codex',
      CLAUDE_CONFIG_DIR: '/opt/claude',
      XDG_CONFIG_HOME: '/opt/xdg',
    })
    expect(expand(`\${CODEX_HOME}/config.toml`, custom)).toBe('/opt/codex/config.toml')
    expect(expand(`\${CLAUDE_CONFIG_DIR}/CLAUDE.md`, custom)).toBe('/opt/claude/CLAUDE.md')
    expect(expand(`\${XDG_CONFIG_HOME}/opencode`, custom)).toBe('/opt/xdg/opencode')
  })

  test('expands %APPDATA% only when the platform provides it', () => {
    const windows = env({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' })
    windows.platform = 'win32'
    expect(expand('%APPDATA%/opencode', windows)).toBe('C:\\Users\\u\\AppData\\Roaming\\opencode')
    expect(() => expand('%APPDATA%/opencode', env())).toThrow(PathError)
  })

  test('unknown and unresolved tokens throw with a code', () => {
    try {
      expand(`\${NOPE_HOME}/x`, env())
      throw new Error('expected expand to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PathError)
      expect((error as PathError).code).toBe('unknown-token')
    }
    try {
      expand('%APPDATA%/x', env())
      throw new Error('expected expand to throw')
    } catch (error) {
      expect((error as PathError).code).toBe('unresolved-token')
    }
  })

  test('relative templates are rejected', () => {
    expect(() => expand('.claude/skills', env())).toThrow(PathError)
  })
})

describe('tokenize', () => {
  test('round-trips every token spelling', () => {
    for (const token of PATH_TOKENS) {
      if (token === '%APPDATA%') continue
      const template = `${token}/nested/file.md`
      const absPath = expand(template, env())
      expect(tokenize(absPath, env())).toBe(template)
    }
  })

  test('picks the most specific token', () => {
    const custom = env({ CLAUDE_CONFIG_DIR: '/u/home/.claude' })
    expect(tokenize('/u/home/.claude/skills/commit/SKILL.md', custom)).toBe(
      `\${CLAUDE_CONFIG_DIR}/skills/commit/SKILL.md`,
    )
    expect(tokenize('/u/home/other/file.md', custom)).toBe('$HOME/other/file.md')
  })

  test('a path no token covers throws', () => {
    try {
      tokenize('/var/tmp/laurencio/file.md', env())
      throw new Error('expected tokenize to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(PathError)
      expect((error as PathError).code).toBe('unrepresentable')
    }
  })

  test('relative paths are rejected', () => {
    expect(() => tokenize('relative/file.md', env())).toThrow(PathError)
  })

  test('tokenValue returns undefined for unknown tokens', () => {
    expect(tokenValue(`\${NOPE}`, env())).toBeUndefined()
  })
})

describe('joinStorePath', () => {
  test('joins with forward slashes', () => {
    expect(joinStorePath('$HOME/.claude', 'skills/commit/SKILL.md')).toBe(
      '$HOME/.claude/skills/commit/SKILL.md',
    )
    expect(joinStorePath('$HOME/.claude/', '')).toBe('$HOME/.claude')
  })

  test('rejects absolute and traversing relatives', () => {
    expect(() => joinStorePath('$HOME/.claude', '/etc/passwd')).toThrow(PathError)
    expect(() => joinStorePath('$HOME/.claude', '../.ssh/id_rsa')).toThrow(PathError)
    expect(() => joinStorePath('$HOME/.claude', 'a/../../b')).toThrow(PathError)
  })
})
