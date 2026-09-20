import { describe, expect, test } from 'bun:test'
import { type ParseError, parse } from 'jsonc-parser'
import {
  opencodePathRewrite,
  opencodeSchemaNormalize,
  opencodeSkillOwnership,
} from '../src/adapters/opencode/transforms'
import type { TokenEnv } from '../src/paths'
import { buildFakeHome } from './helpers/fake-home'

function parseStrict(text: string): unknown {
  const errors: ParseError[] = []
  const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  expect(errors).toEqual([])
  return value
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object')
  }
  return value as Record<string, unknown>
}

describe('opencodeSchemaNormalize', () => {
  test('upload preserves native key names, MCP shape, comments, and unknown settings', () => {
    for (const input of [
      '{"plugins":["local"],"agents":{"review":{}},"mcp":{"servers":{"demo":{}}}}\n',
      '{"plugin":["local"],"agent":{"review":{}},"mcp":{"demo":{}},"future":true}\n',
      '{\n  // native config\n  "plugin": ["a"],\n}\n',
      '{"plugin":["a"],"plugins":["b"]}\n',
    ]) {
      const result = opencodeSchemaNormalize(input, 'upload')
      expect(result.text).toBe(input)
      expect(result.notes).toEqual([])
    }
  })

  test('apply leaves the file untouched and logs keys only one schema reads', () => {
    const input = '{"plugins": [], "skills": ["x"], "mcp": {"a": {}}, "future": 1}\n'
    const result = opencodeSchemaNormalize(input, 'apply')
    expect(result.text).toBe(input)
    expect(result.notes).toEqual([
      {
        kind: 'single-owner',
        key: 'plugins',
        detail: 'read by v1 only; the other schema ignores it',
      },
      { kind: 'single-owner', key: 'mcp', detail: 'read by v2 only; the other schema ignores it' },
      {
        kind: 'single-owner',
        key: 'skills',
        detail: 'read by v2 only; the other schema ignores it',
      },
    ])
  })

  test('invalid JSONC is reported, not rewritten', () => {
    const result = opencodeSchemaNormalize('{ nope', 'upload')
    expect(result.text).toBe('{ nope')
    expect(result.notes[0]?.kind).toBe('invalid')
  })
})

describe('opencodePathRewrite', () => {
  test('tokenize replaces absolute sound, plugin, and skill paths', () => {
    const home = buildFakeHome({ entries: [] })
    const tokenEnv: TokenEnv = { home: home.home, platform: 'darwin', env: {} }
    const input = JSON.stringify(
      {
        attention: {
          sounds: {
            permission: `${home.home}/sounds/permission.wav`,
            missing: '/opt/other/done.wav',
          },
        },
        plugins: [
          `${home.home}/plugins/local`,
          './plugins/relative',
          'https://example.com/plugin.js',
          { package: `${home.home}/plugins/router` },
        ],
        skills: ['~/.agents-opencode/skills', `${home.home}/skills/local`],
      },
      null,
      2,
    )
    const result = opencodePathRewrite(input, 'tokenize', tokenEnv)
    const value = asRecord(parseStrict(result.text))
    const attention = asRecord(value.attention)
    const sounds = asRecord(attention.sounds)
    expect(sounds.permission).toBe('$HOME/sounds/permission.wav')
    expect(sounds.missing).toBe('/opt/other/done.wav')
    expect(value.plugins).toEqual([
      '$HOME/plugins/local',
      './plugins/relative',
      'https://example.com/plugin.js',
      { package: '$HOME/plugins/router' },
    ])
    expect(value.skills).toEqual(['~/.agents-opencode/skills', '~/skills/local'])
    expect(result.rewrites.map((rewrite) => rewrite.key)).toEqual([
      'plugins.0',
      'plugins.3.package',
      'skills.1',
      'attention.sounds.permission',
    ])
    expect(result.notes.join('\n')).toContain('attention.sounds.missing')
    home.cleanup()
  })

  test('tokenize normalizes an already-tokenized skill path to the tilde form', () => {
    const home = buildFakeHome({ entries: [] })
    const tokenEnv: TokenEnv = { home: home.home, platform: 'darwin', env: {} }
    const result = opencodePathRewrite('{"skills":["$HOME/skills/x"]}\n', 'tokenize', tokenEnv)
    expect(parseStrict(result.text)).toEqual({ skills: ['~/skills/x'] })
    home.cleanup()
  })

  test('expand reverses tokenized and tilde paths and keeps relative plugin paths', () => {
    const home = buildFakeHome({ entries: [] })
    const tokenEnv: TokenEnv = { home: home.home, platform: 'darwin', env: {} }
    const input = JSON.stringify(
      {
        attention: { sounds: { permission: '$HOME/sounds/permission.wav' } },
        plugins: ['./plugins/relative', '$HOME/plugins/local'],
        skills: ['~/skills/local'],
      },
      null,
      2,
    )
    const result = opencodePathRewrite(input, 'expand', tokenEnv)
    const value = asRecord(parseStrict(result.text))
    const sounds = asRecord(asRecord(value.attention).sounds)
    expect(sounds.permission).toBe(`${home.home}/sounds/permission.wav`)
    expect(value.plugins).toEqual(['./plugins/relative', `${home.home}/plugins/local`])
    expect(value.skills).toEqual([`${home.home}/skills/local`])
    home.cleanup()
  })

  test('tokenize then expand round-trips an absolute path file byte for byte', () => {
    const home = buildFakeHome({ entries: [] })
    const tokenEnv: TokenEnv = { home: home.home, platform: 'darwin', env: {} }
    const input = `{
  "plugins": ["${home.home}/plugins/local", "./plugins/relative"],
  "skills": ["${home.home}/skills/local"],
  "attention": { "sounds": { "permission": "${home.home}/sounds/x.wav" } }
}
`
    const tokenized = opencodePathRewrite(input, 'tokenize', tokenEnv)
    expect(tokenized.text).not.toContain(home.home)
    const expanded = opencodePathRewrite(tokenized.text, 'expand', tokenEnv)
    expect(expanded.text).toBe(input)
    home.cleanup()
  })
})

describe('opencodeSkillOwnership', () => {
  test('declares both shared skill sources as references', () => {
    const surfaces = opencodeSkillOwnership()
    expect(surfaces.map((surface) => [surface.id, surface.path, surface.shared])).toEqual([
      ['opencode.claude-skills', '$HOME/.claude/skills', true],
      ['opencode.agents-skills', '$HOME/.agents/skills', true],
    ])
  })
})
