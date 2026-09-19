import { describe, expect, test } from 'bun:test'
import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml'
import {
  CODEX_AUTOMATION_DEVICE_KEYS,
  CODEX_MACHINE_KEYS,
  CODEX_PORTABLE_KEYS,
  CODEX_UNSUPPORTED,
  classifyCodexConfigKey,
  codexAutomationSplit,
  codexPathRewriteToLocal,
  codexPathRewriteToStore,
  codexTomlSplit,
} from '../src/adapters/codex'
import type { TokenEnv } from '../src/paths'
import { buildCodexHome } from './helpers/codex-fixture'

const tokenEnv: TokenEnv = {
  home: '/Users/laurencio',
  platform: 'darwin',
  env: { CODEX_HOME: '/Users/laurencio/.codex' },
}

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function leafPaths(value: unknown, path: string[] = []): string[][] {
  if (isTable(value)) {
    const entries = Object.entries(value)
    if (entries.length === 0) return [path]
    return entries.flatMap(([key, child]) => leafPaths(child, [...path, key]))
  }
  return [path]
}

function hasPath(table: TomlTable, path: readonly string[]): boolean {
  let current: unknown = table
  for (const key of path) {
    if (!isTable(current) || !Object.hasOwn(current, key)) return false
    current = current[key]
  }
  return true
}

/** Reapplies the projections onto the parsed local file, as apply does after a merge. */
function applyProjection(base: unknown, projection: TomlTable): TomlValue {
  if (!isTable(base)) return projection
  const result: TomlTable = { ...base }
  for (const [key, value] of Object.entries(projection)) {
    result[key] = isTable(value) && isTable(base[key]) ? applyProjection(base[key], value) : value
  }
  return result
}

describe('codexTomlSplit', () => {
  test('classifies every key so nothing is dropped silently', () => {
    const home = buildCodexHome()
    const text = home.read('.codex/config.toml')
    const original = parse(text)
    const split = codexTomlSplit(text)

    for (const leaf of leafPaths(original)) {
      const joined = leaf.join('.')
      const covered =
        hasPath(split.portable, leaf) ||
        hasPath(split.machine, leaf) ||
        split.ignored.some((prefix) => joined === prefix || joined.startsWith(`${prefix}.`))
      expect(covered, `unclassified key ${joined}`).toBe(true)
    }

    expect(split.ignored).toContain('plugins.chrome@openai-bundled.last_updated')
    expect(split.ignored).toContain('future_thing')
    home.cleanup()
  })

  test('keeps machine keys out of the upload projection', () => {
    const home = buildCodexHome()
    const split = codexTomlSplit(home.read('.codex/config.toml'))
    const uploaded = stringify(split.portable)

    expect(uploaded).toContain('mcp_servers')
    expect(uploaded).toContain('skills.config')
    expect(uploaded).toContain('profiles')
    expect(uploaded).toContain('plugins')
    expect(uploaded).not.toContain('trust_level')
    expect(uploaded).not.toContain('trusted_hash')
    expect(uploaded).not.toContain('PATH_EXTRA')
    expect(uploaded).not.toContain('/Users/laurencio/.codex/.tmp')
    expect(uploaded).not.toContain('notify')
    expect(uploaded).not.toContain('future_thing')

    const projected = parse(uploaded)
    expect(projected.model).toBe('gpt-5.6-codex')
    expect(projected.projects).toBeUndefined()
    expect(projected.notify).toBeUndefined()
    const envPolicy = projected.shell_environment_policy
    expect(isTable(envPolicy) && envPolicy.set).toBeFalsy()
    home.cleanup()
  })

  test('routes the machine families into the device projection', () => {
    const home = buildCodexHome()
    const split = codexTomlSplit(home.read('.codex/config.toml'))
    expect(split.machine.projects).toBeDefined()
    expect(split.machine.notify).toBeDefined()
    const machineHooks = split.machine.hooks
    expect(isTable(machineHooks) && machineHooks.state).toBeDefined()
    const marketplaces = split.machine.marketplaces
    const bundled = isTable(marketplaces) ? marketplaces.bundled : undefined
    expect(isTable(bundled) && bundled.source).toBe(
      '/Users/laurencio/.codex/.tmp/bundled-marketplaces/bundled',
    )
    home.cleanup()
  })

  test('reapplying the projections to the local file drops no keys', () => {
    const home = buildCodexHome()
    const text = home.read('.codex/config.toml')
    const original = parse(text)
    const split = codexTomlSplit(text)
    const reapplied = applyProjection(applyProjection(original, split.portable), split.machine)
    expect(reapplied).toEqual(original)
    home.cleanup()
  })

  test('classifies the DESIGN machine keys as machine', () => {
    expect(classifyCodexConfigKey(['projects', '/Users/laurencio/app'])).toBe('machine')
    expect(classifyCodexConfigKey(['hooks', 'state', 'x'])).toBe('machine')
    expect(classifyCodexConfigKey(['marketplaces', 'bundled', 'source'])).toBe('machine')
    expect(classifyCodexConfigKey(['shell_environment_policy', 'set', 'FOO'])).toBe('machine')
    expect(classifyCodexConfigKey(['marketplaces', 'bundled', 'last_updated'])).toBe('portable')
    expect(classifyCodexConfigKey(['hooks', 'pre_tool_use'])).toBe('portable')
    expect(classifyCodexConfigKey(['shell_environment_policy', 'inherit'])).toBe('portable')
    expect(classifyCodexConfigKey(['profiles', 'fast', 'model'])).toBe('portable')
    expect(CODEX_MACHINE_KEYS).toContain('shell_environment_policy.set')
    expect(CODEX_PORTABLE_KEYS).toContain('plugins.*.enabled')
  })
})

describe('codexPathRewrite', () => {
  test('tokenizes paths inside rules and hooks, and round-trips', () => {
    const home = buildCodexHome()
    const rules = home.read('.codex/rules/default.rules')
    const hooks = home.read('.codex/hooks.json')

    expect(codexPathRewriteToStore(rules, tokenEnv)).toContain(
      `"\${CODEX_HOME}/skills/.system/x/run.mjs"`,
    )
    expect(codexPathRewriteToStore(rules, tokenEnv)).toContain('"/bin/sh"')
    expect(codexPathRewriteToStore(hooks, tokenEnv)).toContain(
      `bash '\${CODEX_HOME}/herdr-agent-state.sh' session`,
    )
    expect(codexPathRewriteToLocal(codexPathRewriteToStore(rules, tokenEnv), tokenEnv)).toBe(rules)
    expect(codexPathRewriteToLocal(codexPathRewriteToStore(hooks, tokenEnv), tokenEnv)).toBe(hooks)

    const homePath = 'prefix_rule(pattern=["node", "/Users/laurencio/projects/app/x.mjs"])'
    expect(codexPathRewriteToStore(homePath, tokenEnv)).toContain('"$HOME/projects/app/x.mjs"')
    home.cleanup()
  })

  test('leaves paths no token covers untouched', () => {
    const text = 'prefix_rule(pattern=["sh", "/opt/tools/bin/run"])'
    expect(codexPathRewriteToStore(text, tokenEnv)).toBe(text)
  })
})

describe('codexAutomationSplit', () => {
  test('syncs definitions and keeps cwds and run history on the device', () => {
    const home = buildCodexHome()
    const text = home.read('.codex/automations/daily/automation.toml')
    const split = codexAutomationSplit(text)

    expect(split.definition.prompt).toBe('Update READMEs.')
    expect(split.definition.target).toBeDefined()
    expect(split.definition.cwds).toBeUndefined()
    expect(split.device.cwds).toEqual(['/Users/laurencio/projects/app'])
    expect(split.device.created_at).toBe(1785345678652)
    expect(split.device.last_run_at).toBe(1785346000000)
    expect(split.ignored).toEqual([])
    expect(CODEX_AUTOMATION_DEVICE_KEYS).toContain('cwds')
    home.cleanup()
  })

  test('reports unknown automation keys instead of uploading them', () => {
    const split = codexAutomationSplit('name = "x"\ncwds = ["/tmp"]\nfuture_key = true\n')
    expect(split.ignored).toEqual(['future_key'])
    expect(split.definition.future_key).toBeUndefined()
    expect(split.device.future_key).toBeUndefined()
  })
})

describe('codex unsupported report', () => {
  test('names SQLite memory and gives the reason', () => {
    expect(CODEX_UNSUPPORTED.map((entry) => entry.path)).toEqual([
      `\${CODEX_HOME}/memories_*.sqlite`,
    ])
    expect(CODEX_UNSUPPORTED[0]?.reason).toContain('opaque SQLite store')
  })
})
