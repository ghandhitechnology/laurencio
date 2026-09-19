import { createHash } from 'node:crypto'
import path from 'node:path'
import { PATH_TOKENS, PathError, type TokenEnv, tokenize, tokenValue } from '../../paths'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Copy arbitrary parsed data into a JSON value, dropping anything JSON cannot carry. */
function copyJson(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'string'
  ) {
    return value
  }
  if (Array.isArray(value)) return value.map(copyJson)
  if (isJsonObject(value)) {
    const output: JsonObject = {}
    for (const [key, child] of Object.entries(value)) output[key] = copyJson(child)
    return output
  }
  return null
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export interface McpEnvIndirection {
  server: string
  key: string
}

export interface McpExtraction {
  /** `{ mcpServers: ... }`, the only projection of `~/.claude.json` that is stored. */
  value: JsonObject
  /** Env keys replaced with `${KEY}` so the harness expands them from the device environment. */
  indirectEnv: McpEnvIndirection[]
  /** Top-level keys of `~/.claude.json` the transform deliberately never extracts. */
  ignoredKeys: string[]
}

const envReference = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/

/**
 * Pull the user-scope `mcpServers` table out of a parsed `~/.claude.json`.
 * Everything else in that file (oauthAccount, machineID, per-project trust state) stays
 * on the machine, and secret env values become `${KEY}` references instead of values.
 */
export function claudeMcpExtract(config: unknown): McpExtraction {
  if (!isJsonObject(config)) {
    return { value: { mcpServers: {} }, indirectEnv: [], ignoredKeys: [] }
  }
  const source = isJsonObject(config.mcpServers) ? config.mcpServers : {}
  const mcpServers: JsonObject = {}
  const indirectEnv: McpEnvIndirection[] = []
  for (const [server, raw] of Object.entries(source)) {
    if (!isJsonObject(raw)) {
      mcpServers[server] = copyJson(raw)
      continue
    }
    const entry: JsonObject = {}
    for (const [key, child] of Object.entries(raw)) {
      if (key !== 'env' || !isJsonObject(child)) {
        entry[key] = copyJson(child)
        continue
      }
      const env: JsonObject = {}
      for (const [name, value] of Object.entries(child)) {
        if (typeof value === 'string' && value !== '' && !envReference.test(value)) {
          env[name] = `\${${name}}`
          indirectEnv.push({ server, key: name })
        } else {
          env[name] = copyJson(value)
        }
      }
      entry.env = env
    }
    mcpServers[server] = entry
  }
  return {
    value: { mcpServers },
    indirectEnv,
    ignoredKeys: Object.keys(config)
      .filter((key) => key !== 'mcpServers')
      .sort(),
  }
}

export interface PluginRecordsResult {
  value: JsonValue
  /** Dotted paths of machine-local keys removed from the projection. */
  stripped: string[]
}

const machineRecordKeys = new Set(['installLocation', 'installPath', 'installedAt', 'lastUpdated'])

/**
 * Strip install paths and timestamps from plugin and marketplace install records, so the
 * synced record describes what is installed, not where this machine put it.
 */
export function claudePluginRecords(records: unknown): PluginRecordsResult {
  const stripped: string[] = []
  if (!isJsonObject(records) && !Array.isArray(records)) return { value: null, stripped }
  const value = stripRecordKeys(copyJson(records), [], stripped)
  return { value, stripped }
}

function stripRecordKeys(value: JsonValue, trail: string[], stripped: string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) => stripRecordKeys(item, [...trail, String(index)], stripped))
  }
  if (!isJsonObject(value)) return value
  const output: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (machineRecordKeys.has(key)) {
      stripped.push([...trail, key].join('.'))
      continue
    }
    output[key] = stripRecordKeys(child, [...trail, key], stripped)
  }
  return output
}

export interface TextRewrite {
  text: string
  count: number
}

interface RootMatch {
  value: string
  start: number
}

function tokenRoots(tokenEnv: TokenEnv): string[] {
  const roots: string[] = []
  for (const token of PATH_TOKENS) {
    const value = tokenValue(token, tokenEnv)
    if (value === undefined || value === '') continue
    roots.push(value)
  }
  return roots
}

/** Characters that keep a preceding string part of one path, so a match is refused there. */
const pathContinuation = /[A-Za-z0-9._~@-]/
const separators = new Set(['/', '\\'])

function findRoot(text: string, from: number, roots: readonly string[]): RootMatch | null {
  let best: RootMatch | null = null
  for (const value of roots) {
    let index = text.indexOf(value, from)
    while (index !== -1) {
      const before = index === 0 ? '' : (text[index - 1] ?? '')
      const after = text[index + value.length]
      const boundary = before === '' || !pathContinuation.test(before)
      const continues = after === undefined || separators.has(after)
      if (boundary && continues) {
        if (
          best === null ||
          index < best.start ||
          (index === best.start && value.length > best.value.length)
        ) {
          best = { value, start: index }
        }
        break
      }
      index = text.indexOf(value, index + 1)
    }
  }
  return best
}

const trailingPunctuation = /[ \t;|&()<>[\]{},:]+$/

/** First colon that ends a path component, skipping a Windows drive letter. */
function colonCut(candidate: string): number {
  for (let index = 0; index < candidate.length; index += 1) {
    if (candidate[index] !== ':') continue
    const drive = index === 1 && /^[A-Za-z]$/.test(candidate[0] ?? '')
    if (drive) continue
    return index
  }
  return -1
}

/**
 * End of the path candidate starting at `start`. Inside a quote, the quote wins so paths
 * with spaces survive; outside one, whitespace and the shell characters that cannot be
 * part of a path stop the candidate.
 */
function candidateEnd(text: string, start: number): number {
  const single = text.lastIndexOf("'", start - 1)
  const double = text.lastIndexOf('"', start - 1)
  const quoteStart = Math.max(single, double)
  if (quoteStart !== -1) {
    const quote = quoteStart === single ? "'" : '"'
    const close = text.indexOf(quote, start)
    const lineEnd = text.slice(start).search(/[\r\n]/)
    const hardEnd = lineEnd === -1 ? text.length : start + lineEnd
    if (close !== -1 && close < hardEnd) return close
  }
  const stop = text.slice(start).search(/[\s"'`]/)
  return stop === -1 ? text.length : start + stop
}

function rewriteRoot(
  text: string,
  match: RootMatch,
  tokenEnv: TokenEnv,
): { replacement: string; end: number } | null {
  const raw = text.slice(match.start, candidateEnd(text, match.start))
  const cut = colonCut(raw)
  const candidate = cut === -1 ? raw : raw.slice(0, cut)
  const trimmed = candidate.replace(trailingPunctuation, '')
  const suffix = candidate.slice(trimmed.length)
  if (trimmed === '') return null
  try {
    return {
      replacement: tokenize(trimmed, tokenEnv) + suffix,
      end: match.start + candidate.length,
    }
  } catch (error) {
    if (error instanceof PathError) return null
    throw error
  }
}

/**
 * Replace absolute paths that a token covers with their `${...}` token, leaving other
 * absolute paths (system binaries and the like) untouched.
 */
export function tokenizePathsInText(text: string, tokenEnv: TokenEnv): TextRewrite {
  const roots = tokenRoots(tokenEnv)
  if (roots.length === 0) return { text, count: 0 }
  let output = ''
  let cursor = 0
  let count = 0
  while (cursor < text.length) {
    const match = findRoot(text, cursor, roots)
    if (match === null) break
    const rewritten = rewriteRoot(text, match, tokenEnv)
    if (rewritten === null) {
      cursor = match.start + match.value.length
      continue
    }
    output += text.slice(cursor, match.start) + rewritten.replacement
    cursor = rewritten.end
    count += 1
  }
  return { text: output + text.slice(cursor), count }
}

/** Apply-side inverse of `tokenizePathsInText`: expand every path token back to this machine. */
export function expandPathsInText(text: string, tokenEnv: TokenEnv): TextRewrite {
  const tokens = [...PATH_TOKENS].sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`${tokens.map(escapeRegExp).join('|')}(?![A-Za-z0-9_])`, 'g')
  let count = 0
  const expanded = text.replace(pattern, (match) => {
    const value = tokenValue(match, tokenEnv)
    if (value === undefined) return match
    count += 1
    return value
  })
  return { text: expanded, count }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SettingsRewrite {
  value: JsonObject
  /** Dotted locations whose command text changed, for diagnostics. */
  rewritten: string[]
}

/** Tokenize absolute paths in the settings references that carry them: hooks and statusLine. */
export function claudePathRewrite(settings: JsonObject, tokenEnv: TokenEnv): SettingsRewrite {
  const value = cloneJsonObject(settings)
  const rewritten: string[] = []

  const hooks = value.hooks
  if (isJsonObject(hooks)) {
    for (const [event, groups] of Object.entries(hooks)) {
      if (!Array.isArray(groups)) continue
      groups.forEach((group, groupIndex) => {
        if (!isJsonObject(group)) return
        const entries = group.hooks
        if (!Array.isArray(entries)) return
        entries.forEach((entry, entryIndex) => {
          if (!isJsonObject(entry)) return
          const command = entry.command
          if (typeof command !== 'string') return
          const result = tokenizePathsInText(command, tokenEnv)
          if (result.count === 0) return
          entry.command = result.text
          rewritten.push(`hooks.${event}[${groupIndex}].hooks[${entryIndex}].command`)
        })
      })
    }
  }

  const statusLine = value.statusLine
  if (isJsonObject(statusLine) && typeof statusLine.command === 'string') {
    const result = tokenizePathsInText(statusLine.command, tokenEnv)
    if (result.count > 0) {
      statusLine.command = result.text
      rewritten.push('statusLine.command')
    }
  }

  return { value, rewritten }
}

function cloneJsonObject(input: JsonObject): JsonObject {
  const output: JsonObject = {}
  for (const [key, value] of Object.entries(input)) output[key] = copyJson(value)
  return output
}

export interface MemoryProject {
  /** Directory name under `<config>/projects`, for example `-Users-me-projects-repo`. */
  slug: string
  /** Absolute working directory the slug was derived from. */
  projectPath: string
  /** Absolute repository root, when the project is inside a git repository. */
  repoRoot?: string
  /** `origin` remote URL, when the repository has one. */
  repoRemote?: string
}

export interface MemoryIdentity {
  repoRemote?: string
  repoRelativePath: string
  fallbackHash: string
}

export interface MemoryRekey {
  slug: string
  identity: MemoryIdentity
  /** Store-relative prefix for this memory tree. Never contains a local path. */
  storePrefix: string
}

function repoRelativePath(repoRoot: string, projectPath: string): string {
  const relative = path.relative(repoRoot, projectPath)
  if (relative === '' || relative === '.') return ''
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return ''
  }
  return relative.split(path.sep).join('/')
}

/**
 * Map `projects/<slug>/memory` to a repository-keyed identity: remote plus repository
 * relative path when the repo has a remote, a stable hash otherwise. The hash is one way,
 * so the local path itself never reaches storage.
 */
export function claudeSlugRekey(project: MemoryProject): MemoryRekey {
  const relative =
    project.repoRoot === undefined ? '' : repoRelativePath(project.repoRoot, project.projectPath)
  const identity: MemoryIdentity = {
    ...(project.repoRemote === undefined ? {} : { repoRemote: project.repoRemote }),
    repoRelativePath: relative,
    fallbackHash: sha256Hex(project.repoRoot ?? project.projectPath),
  }
  return { slug: project.slug, identity, storePrefix: `memory/${memoryIdentityKey(identity)}` }
}

/** Stable storage key for a memory identity. Remotes are hashed so URLs never land in paths. */
export function memoryIdentityKey(identity: MemoryIdentity): string {
  const base =
    identity.repoRemote === undefined
      ? `path-${identity.fallbackHash.slice(0, 32)}`
      : `repo-${sha256Hex(identity.repoRemote).slice(0, 32)}`
  if (identity.repoRelativePath === '') return base
  return `${base}-${identity.repoRelativePath.replace(/[^A-Za-z0-9._-]+/g, '_')}`
}
