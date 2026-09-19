import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultPolicy } from '../src/model'
import {
  activeAdapters,
  loadPolicy,
  nextRunDelayMs,
  PolicyError,
  parsePolicyToml,
  policyPath,
  savePolicy,
} from '../src/sync/policy'
import { file, testAdapter, tree } from './helpers/adapter-fixtures'

function tempHome(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-policy-'))
}

describe('device policy', () => {
  test('missing config.toml yields the defaults', () => {
    const home = tempHome()
    expect(loadPolicy(home)).toEqual(defaultPolicy())
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('parses ignore lists, harness toggles, surface toggles, and cadence', () => {
    const policy = parsePolicyToml(`
ignore = ["**/node_modules/**", "$HOME/.claude/plugins/**"]
prune = true

[cadence]
watch = false
intervalSeconds = 900

[harnesses.claude]
enabled = true
[harnesses.claude.surfaces]
"claude.settings" = "off"
"claude.skills" = "on"

[harnesses.codex]
enabled = false
`)
    expect(policy.ignore).toEqual(['**/node_modules/**', '$HOME/.claude/plugins/**'])
    expect(policy.prune).toBe(true)
    expect(policy.cadence).toEqual({ watch: false, intervalSeconds: 900 })
    expect(policy.harnesses.claude).toEqual({
      enabled: true,
      surfaces: { 'claude.settings': 'off', 'claude.skills': 'on' },
    })
    expect(policy.harnesses.codex?.enabled).toBe(false)
    expect(nextRunDelayMs(policy)).toBeNull()
    expect(nextRunDelayMs(parsePolicyToml('cadence = { watch = true }'))).toBe(300_000)
  })

  test('activeAdapters drops disabled harnesses and switched-off surfaces', () => {
    const policy = parsePolicyToml(`
[harnesses.claude.surfaces]
"claude.settings" = "off"
[harnesses.codex]
enabled = false
`)
    const claude = testAdapter('claude', [
      file({ id: 'claude.settings', path: '$HOME/.claude/settings.json' }),
      file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md' }),
    ])
    const codex = testAdapter('codex', [
      file({ id: 'codex.agents', path: '$HOME/.codex/AGENTS.md' }),
    ])
    const adapted = activeAdapters([claude, codex], policy)
    const ctx = { home: '/tmp/home', platform: 'darwin' as const, env: {} }
    const claudeSurfaces = adapted[0]?.surfaces(ctx).map((surface) => String(surface.id)) ?? []
    expect(claudeSurfaces).toEqual(['claude.instructions'])
    expect(adapted[1]?.surfaces(ctx)).toEqual([])
    expect(adapted[0]?.detect(ctx).installed).toBe(true)
  })

  test('an enabled harness with no surface overrides passes its surfaces through', () => {
    const policy = parsePolicyToml('[harnesses.claude]\nenabled = true\n')
    const adapter = testAdapter('claude', [
      tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
    ])
    const adapted = activeAdapters([adapter], policy)
    expect(adapted[0]).toBe(adapter)
  })

  test('round-trips through ~/.laurencio/config.toml', () => {
    const home = tempHome()
    const policy = parsePolicyToml(`
ignore = ["**/cache/**"]
prune = true
cadence = { watch = true, intervalSeconds = 60 }
[harnesses.opencode]
enabled = true
[harnesses.opencode.surfaces]
"opencode.config" = "off"
`)
    const filePath = savePolicy(home, policy)
    expect(filePath).toBe(policyPath(home))
    expect(loadPolicy(home)).toEqual(policy)
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('rejects malformed TOML and wrong value types loudly', () => {
    expect(() => parsePolicyToml('ignore = [')).toThrow(PolicyError)
    expect(() => parsePolicyToml('ignore = "not an array"')).toThrow(/ignore must be an array/)
    expect(() => parsePolicyToml('[cadence]\nintervalSeconds = 0')).toThrow(PolicyError)
    expect(() => parsePolicyToml('[harnesses.claude.surfaces]\nsettings = "maybe"')).toThrow(
      PolicyError,
    )
    expect(() => parsePolicyToml('[harnesses.claude]\nenabled = "yes"')).toThrow(PolicyError)
  })
})
