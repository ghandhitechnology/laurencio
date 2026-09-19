import { parse, stringify, type TomlTable } from 'smol-toml'
import { type TokenEnv, tokenize, tokenValue } from '../../paths'

export type CodexKeyClass = 'portable' | 'machine' | 'ignored' | 'mixed'

/** A key-level split of one `config.toml`. `ignored` records unclaimed key paths. */
export interface CodexConfigSplit {
  portable: TomlTable
  machine: TomlTable
  ignored: string[]
}

/** A key-level split of one `automations/<name>/automation.toml`. */
export interface CodexAutomationSplit {
  definition: TomlTable
  device: TomlTable
  ignored: string[]
}

export interface CodexUnsupportedSurface {
  path: string
  reason: string
}

/**
 * Key paths the config split uploads. `*` matches one key; a trailing `*` matches a key
 * prefix. `hooks`, `marketplaces`, and `shell_environment_policy` are listed whole because
 * only a subtree of each is machine state; the machine list below wins where they overlap.
 */
export const CODEX_PORTABLE_KEYS: readonly string[] = [
  'model*',
  'openai_base_url',
  'approval_policy',
  'approvals_reviewer',
  'sandbox_mode',
  'sandbox_workspace_write',
  'service_tier',
  'mcp_servers',
  'tui',
  'features',
  'history',
  'hooks',
  'marketplaces',
  'shell_environment_policy',
  'desktop',
  'plan_mode_reasoning_effort',
  'skills.config',
  'plugins.*.enabled',
  'profiles',
  'profile',
]

/**
 * Machine key families that never upload: absolute-path trust state, local hook hashes,
 * local marketplace sources, and `notify`'s local command. Unknown keys stay local too.
 */
export const CODEX_MACHINE_KEYS: readonly string[] = [
  'projects',
  'hooks.state',
  'marketplaces.*.source',
  'shell_environment_policy.set',
  'notify',
]

/** Automation keys per device: the cwds a task runs in and its run history. */
export const CODEX_AUTOMATION_DEVICE_KEYS: readonly string[] = [
  'cwds',
  'runs',
  'run_history',
  'history',
  'last_run',
  'last_run_at',
  'last_status',
  'created_at',
  'updated_at',
]

/** Automation keys that define the task and travel between devices. */
export const CODEX_AUTOMATION_DEFINITION_KEYS: readonly string[] = [
  'version',
  'id',
  'kind',
  'name',
  'description',
  'enabled',
  'status',
  'rrule',
  'prompt',
  'model*',
  'reasoning_effort',
  'execution_environment',
  'target',
  'schedule',
  'timezone',
]

/**
 * Codex memory is a local SQLite store, so the adapter reports it as unsupported instead
 * of guessing at a file-based projection. Phase 13's `--memory` flag reads this report.
 */
export const CODEX_MEMORY_UNSUPPORTED: CodexUnsupportedSurface = {
  path: `\${CODEX_HOME}/memories_*.sqlite`,
  reason: 'Codex memory is an opaque SQLite store; file-based memory sync is unsupported',
}

export const CODEX_UNSUPPORTED: readonly CodexUnsupportedSurface[] = [CODEX_MEMORY_UNSUPPORTED]

/** `match` covers the pattern and its subtree, `prefix` is a container, `none` misses. */
function patternRelation(pattern: string, path: readonly string[]): 'match' | 'prefix' | 'none' {
  const parts = pattern.split('.')
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]
    if (part === undefined) return 'none'
    if (part === '*') {
      if (index >= path.length) return 'prefix'
      continue
    }
    const segment = path[index]
    if (segment === undefined) return 'prefix'
    if (part.endsWith('*')) {
      if (index !== parts.length - 1) return 'none'
      return segment.startsWith(part.slice(0, -1)) ? 'match' : 'none'
    }
    if (part !== segment) return 'none'
  }
  return 'match'
}

function classifyWith(
  path: readonly string[],
  machinePatterns: readonly string[],
  portablePatterns: readonly string[],
): CodexKeyClass {
  if (path.length === 0) return 'mixed'
  for (const pattern of machinePatterns) {
    if (patternRelation(pattern, path) === 'match') return 'machine'
  }
  // A machine family can sit inside a portable table (`marketplaces.*.source`), so a
  // partial machine match makes the container mixed rather than portable.
  for (const pattern of machinePatterns) {
    if (patternRelation(pattern, path) === 'prefix') return 'mixed'
  }
  for (const pattern of portablePatterns) {
    if (patternRelation(pattern, path) === 'match') return 'portable'
  }
  for (const pattern of portablePatterns) {
    if (patternRelation(pattern, path) === 'prefix') return 'mixed'
  }
  return 'ignored'
}

export function classifyCodexConfigKey(path: readonly string[]): CodexKeyClass {
  return classifyWith(path, CODEX_MACHINE_KEYS, CODEX_PORTABLE_KEYS)
}

export function classifyCodexAutomationKey(path: readonly string[]): CodexKeyClass {
  return classifyWith(path, CODEX_AUTOMATION_DEVICE_KEYS, CODEX_AUTOMATION_DEFINITION_KEYS)
}

function isTable(value: unknown): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function ensureTable(parent: TomlTable, key: string): TomlTable {
  const existing = parent[key]
  if (isTable(existing)) return existing
  const created: TomlTable = {}
  parent[key] = created
  return created
}

/**
 * Walks one parsed TOML tree and routes every key into `portable` or `machine`, recording
 * unclaimed paths in `ignored`. Mixed containers are created on both sides and descended.
 */
function splitToml(
  root: TomlTable,
  classify: (path: readonly string[]) => CodexKeyClass,
): { portable: TomlTable; machine: TomlTable; ignored: string[] } {
  const portable: TomlTable = {}
  const machine: TomlTable = {}
  const ignored: string[] = []
  const walk = (
    value: TomlTable,
    path: readonly string[],
    portableTarget: TomlTable,
    machineTarget: TomlTable,
  ): void => {
    for (const [key, child] of Object.entries(value)) {
      const childPath = [...path, key]
      const kind = classify(childPath)
      if (kind === 'mixed' && isTable(child)) {
        walk(child, childPath, ensureTable(portableTarget, key), ensureTable(machineTarget, key))
        continue
      }
      if (kind === 'ignored' || kind === 'mixed') {
        ignored.push(childPath.join('.'))
        continue
      }
      if (kind === 'machine') machineTarget[key] = child
      else portableTarget[key] = child
    }
  }
  walk(root, [], portable, machine)
  return { portable, machine, ignored }
}

/** Total split: every key lands in `portable`, `machine`, or `ignored`. */
export function codexTomlSplit(text: string): CodexConfigSplit {
  const split = splitToml(parse(text), classifyCodexConfigKey)
  return { portable: split.portable, machine: split.machine, ignored: split.ignored }
}

/** Definitions upload; cwds and run history stay in the device override. */
export function codexAutomationSplit(text: string): CodexAutomationSplit {
  const split = splitToml(parse(text), classifyCodexAutomationKey)
  return { definition: split.portable, device: split.machine, ignored: split.ignored }
}

/** Deep key merge for TOML tables: tables merge, every other value in the patch wins. */
function mergeTables(base: TomlTable, patch: TomlTable): TomlTable {
  const merged: TomlTable = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const existing = merged[key]
    merged[key] = isTable(existing) && isTable(value) ? mergeTables(existing, value) : value
  }
  return merged
}

function applySplit(machineText: string | null, projectionText: string): string {
  const projection = parse(projectionText)
  if (machineText === null || machineText.trim() === '') return stringify(projection)
  const merged = mergeTables(parse(machineText), projection)
  return stringify(merged)
}

/**
 * Apply-side inverse of `codexTomlSplit`: merge the portable projection into the local
 * file so machine keys (`[projects.*]` trust, `[hooks.state.*]` hashes, marketplace
 * sources, `shell_environment_policy.set`) survive the download.
 */
export function codexTomlApply(machineText: string | null, projectionText: string): string {
  return applySplit(machineText, projectionText)
}

/** Apply-side inverse of `codexAutomationSplit`: definition keys land, device keys stay. */
export function codexAutomationApply(machineText: string | null, projectionText: string): string {
  return applySplit(machineText, projectionText)
}

const absolutePathPattern = /\/(?:[A-Za-z0-9._~@+-]+\/)*[A-Za-z0-9._~@+-]+/g
const textTokenPattern = /\$\{([A-Za-z0-9_]+)\}|\$HOME|%APPDATA%/g

/** Upload side of `codexPathRewrite`: absolute paths become tokens, unrepresented paths stay. */
export function codexPathRewriteToStore(text: string, tokenEnv: TokenEnv): string {
  return text.replace(absolutePathPattern, (candidate) => {
    try {
      return tokenize(candidate, tokenEnv)
    } catch {
      return candidate
    }
  })
}

/** Apply side of `codexPathRewrite`: tokens become this machine's absolute paths. */
export function codexPathRewriteToLocal(text: string, tokenEnv: TokenEnv): string {
  return text.replace(textTokenPattern, (match, name: string | undefined) => {
    const token = name === undefined ? match : `\${${name}}`
    return tokenValue(token, tokenEnv) ?? match
  })
}
