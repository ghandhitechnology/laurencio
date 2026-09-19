import { describe, expect, test } from 'bun:test'
import {
  envVarName,
  isPlaceholder,
  placeholderToken,
  resolvePlaceholder,
  rewriteEnv,
  rewriteHeaders,
  rewriteValue,
} from '../../src/secrets/placeholders'

const context = { path: 'claude.json', scope: 'mcp_github' }
const githubToken = 'ghp_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal expansion syntax is what is under test
const CLAUDE_REFERENCE = '${MCP_GITHUB_GITHUB_TOKEN}'
const OPENCODE_REFERENCE = '{env:MCP_GITHUB_GITHUB_TOKEN}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal expansion syntax is what is under test
const CLAUDE_EXISTING = '${ALREADY_SET}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal expansion syntax is what is under test
const CLAUDE_HEADER = '${MCP_GITHUB_HEADER_AUTHORIZATION}'
// biome-ignore lint/suspicious/noTemplateCurlyInString: the literal expansion syntax is what is under test
const CLAUDE_HEADER_API_KEY = '${MCP_GITHUB_HEADER_X_API_KEY}'

describe('native indirection', () => {
  test('claude gets the dollar-brace form, opencode gets the env: form', () => {
    expect(rewriteValue('claude', context, 'GITHUB_TOKEN', githubToken).value).toBe(
      CLAUDE_REFERENCE,
    )
    expect(rewriteValue('opencode', context, 'GITHUB_TOKEN', githubToken).value).toBe(
      OPENCODE_REFERENCE,
    )
  })

  test('codex has no native expansion, so the value moves out', () => {
    const outcome = rewriteValue('codex', context, 'GITHUB_TOKEN', githubToken)
    expect(outcome.value).toBe(placeholderToken('MCP_GITHUB_GITHUB_TOKEN'))
    expect(outcome.moved).toEqual({
      name: 'MCP_GITHUB_GITHUB_TOKEN',
      path: 'claude.json',
      value: githubToken,
    })
  })

  test('already-indirected and placeholder values pass through untouched', () => {
    expect(rewriteValue('claude', context, 'X', CLAUDE_EXISTING).moved).toBeNull()
    expect(rewriteValue('opencode', context, 'X', '{env:ALREADY_SET}').moved).toBeNull()
    const placeholder = placeholderToken('SOME_SECRET')
    expect(rewriteValue('codex', context, 'X', placeholder).value).toBe(placeholder)
  })
})

describe('env and header maps', () => {
  test('moved secrets carry the file path for the override log', () => {
    const result = rewriteEnv(
      'codex',
      { path: 'codex/config.toml', scope: 'mcp_internal' },
      {
        INTERNAL_SHARED_SECRET: 'mF7bQ2xZ9pL4vN6cR1tY8uI3oP5aS0dG7hJ2kM4nB6vC9xZ',
        LOG_LEVEL: 'debug',
      },
    )
    expect(result.moved).toHaveLength(1)
    expect(result.moved[0]?.path).toBe('codex/config.toml')
    expect(result.values.INTERNAL_SHARED_SECRET).toStartWith('laurencio:secret:')
    expect(result.values.LOG_LEVEL).toBe('debug')
  })

  test('ordinary non-secret values are left alone', () => {
    const result = rewriteEnv('claude', context, {
      LOG_LEVEL: 'debug',
      REGION: 'us-east-1',
      NODE_OPTIONS: '--max-old-space-size=4096',
    })
    expect(result.moved).toHaveLength(0)
    expect(result.values.LOG_LEVEL).toBe('debug')
    expect(result.values.REGION).toBe('us-east-1')
  })

  test('header names are namespaced before indirection', () => {
    const result = rewriteHeaders('claude', context, {
      Authorization: `Bearer ${githubToken}`,
      'x-api-key': githubToken,
    })
    expect(result.values.Authorization).toBe(CLAUDE_HEADER)
    expect(result.values['x-api-key']).toBe(CLAUDE_HEADER_API_KEY)
    expect(result.moved).toHaveLength(0)
  })
})

describe('placeholders', () => {
  test('tokens round-trip through a lookup', () => {
    const token = placeholderToken('SOME_SECRET')
    expect(isPlaceholder(token)).toBe(true)
    expect(resolvePlaceholder(token, (name) => (name === 'SOME_SECRET' ? 'real' : undefined))).toBe(
      'real',
    )
    expect(resolvePlaceholder(token, () => undefined)).toBeUndefined()
    expect(resolvePlaceholder('plain', () => 'x')).toBe('plain')
  })

  test('env names are upper-snake and never start with a digit', () => {
    expect(envVarName('mcp_internal', 'shared-secret')).toBe('MCP_INTERNAL_SHARED_SECRET')
    expect(envVarName('9lives', 'key')).toBe('MCP_9LIVES_KEY')
  })
})
