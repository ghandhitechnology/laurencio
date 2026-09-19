import path from 'node:path'
import { SurfaceId } from '@laurencio/protocol'
import {
  applyEdits,
  type EditResult,
  type FormattingOptions,
  modify,
  type Node,
  type ParseError,
  parse,
  parseTree,
} from 'jsonc-parser'
import { deepEqual, isPlainObject } from '../../merge/treeMerge'
import { expand, PathError, type TokenEnv, tokenize } from '../../paths'
import type { TreeSurface } from '../../types'
import type { OpenCodeSchemaVersion } from './detect'

export type OpenCodeKeyOwner = 'v1' | 'v2' | 'both'

export interface OpenCodeSchema {
  version: OpenCodeSchemaVersion
  keys: Record<string, OpenCodeKeyOwner>
}

/**
 * Which schema reads a config key. v1 and v2 read the same file with different spellings and
 * shapes; everything not listed is either shared or unknown and is preserved untouched.
 */
export const OPENCODE_SCHEMA_KEYS: Readonly<Record<string, OpenCodeKeyOwner>> = {
  plugin: 'v2',
  plugins: 'v1',
  agent: 'v2',
  agents: 'v1',
  command: 'v2',
  commands: 'v1',
  permission: 'v2',
  permissions: 'v1',
  mcp: 'v2',
  'mcp.servers': 'v1',
  // v2 reads `skills` as an array of sources; v1 expects an object under the same key.
  skills: 'v2',
  model: 'both',
  small_model: 'both',
  providers: 'both',
  instructions: 'both',
}

/** The key table from one schema version's point of view. */
export function opencodeSchema(version: OpenCodeSchemaVersion): OpenCodeSchema {
  return { version, keys: { ...OPENCODE_SCHEMA_KEYS } }
}

/** Ambiguous families: v1 reads the plural spelling, v2 the singular one. */
const MIRRORED_KEY_FAMILIES: readonly (readonly [string, string])[] = [
  ['plugins', 'plugin'],
  ['agents', 'agent'],
  ['commands', 'command'],
  ['permissions', 'permission'],
]

export type OpenCodeNormalizeNoteKind =
  | 'mirrored'
  | 'single-owner'
  | 'conflict'
  | 'invalid'
  | 'unparsed'

export interface OpenCodeNormalizeNote {
  kind: OpenCodeNormalizeNoteKind
  key: string
  detail: string
}

export interface OpenCodeNormalizeResult {
  text: string
  notes: OpenCodeNormalizeNote[]
}

interface ParsedJsonc {
  value: unknown
  root: Node
}

function parseJsonc(text: string): ParsedJsonc | undefined {
  const errors: ParseError[] = []
  const options = { allowTrailingComma: true, disallowComments: false }
  const root = parseTree(text, errors, options)
  if (root === undefined || errors.length > 0) return undefined
  return { value: parse(text, undefined, options) as unknown, root }
}

function formattingOptions(text: string): FormattingOptions {
  const tabIndented = /^\t/m.test(text)
  const spaces = /^( +)\S/m.exec(text)
  return {
    insertSpaces: !tabIndented,
    tabSize: spaces?.[1]?.length ?? 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  }
}

function applyEdit(
  text: string,
  edits: EditResult,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return { ok: true, text: applyEdits(text, edits) }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

function valueAtPath(root: unknown, segments: readonly (string | number)[]): unknown {
  let current: unknown = root
  for (const segment of segments) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isPlainObject(current)) current = current[String(segment)]
    else return undefined
  }
  return current
}

/**
 * Upload projection: write the keys both schemas read so neither silently drops content when
 * the file lands on a machine running the other version. Apply: leave the file as the merge
 * engine wrote it and report keys only one version reads. Unknown keys always survive.
 */
export function opencodeSchemaNormalize(
  text: string,
  mode: 'upload' | 'apply',
): OpenCodeNormalizeResult {
  const notes: OpenCodeNormalizeNote[] = []
  const parsed = parseJsonc(text)
  if (parsed === undefined || !isPlainObject(parsed.value)) {
    notes.push({ kind: 'invalid', key: '', detail: 'not a JSONC object; left untouched' })
    return { text, notes }
  }
  const value = parsed.value

  if (mode === 'apply') {
    for (const [key, owner] of Object.entries(OPENCODE_SCHEMA_KEYS)) {
      if (owner === 'both' || !Object.hasOwn(value, key)) continue
      notes.push({
        kind: 'single-owner',
        key,
        detail: `read by ${owner} only; the other schema ignores it`,
      })
    }
    return { text, notes }
  }

  let content = text
  const format = formattingOptions(text)
  const insert = (keyPath: (string | number)[], inserted: unknown): boolean => {
    const outcome = applyEdit(
      content,
      modify(content, keyPath, inserted, { formattingOptions: format }),
    )
    if (!outcome.ok) {
      notes.push({ kind: 'unparsed', key: keyPath.join('.'), detail: outcome.reason })
      return false
    }
    content = outcome.text
    return true
  }

  for (const [plural, singular] of MIRRORED_KEY_FAMILIES) {
    const hasPlural = Object.hasOwn(value, plural)
    const hasSingular = Object.hasOwn(value, singular)
    if (!hasPlural && !hasSingular) continue
    if (hasPlural && hasSingular) {
      if (!deepEqual(value[plural], value[singular])) {
        notes.push({
          kind: 'conflict',
          key: `${plural}/${singular}`,
          detail: 'both spellings present with different values; kept both',
        })
      }
      continue
    }
    const from = hasPlural ? plural : singular
    const to = hasPlural ? singular : plural
    // Values may be profile-scoped arrays or definition maps; mirror the whole value.
    if (insert([to], value[from])) {
      notes.push({
        kind: 'mirrored',
        key: to,
        detail: `mirrored ${from} to ${to}; both schemas read the same value`,
      })
    }
  }

  mirrorMcpServers(value, insert, notes)
  return { text: content, notes }
}

/** v1 nests servers under `mcp.servers`, v2 reads them flat; write both shapes when ambiguous. */
function mirrorMcpServers(
  value: Record<string, unknown>,
  insert: (keyPath: (string | number)[], inserted: unknown) => boolean,
  notes: OpenCodeNormalizeNote[],
): void {
  const mcp = value.mcp
  if (!isPlainObject(mcp)) return
  const servers = isPlainObject(mcp.servers) ? mcp.servers : undefined
  const flat = Object.entries(mcp).filter(([key]) => key !== 'servers')

  if (servers === undefined) {
    if (flat.length === 0) return
    if (insert(['mcp', 'servers'], Object.fromEntries(flat))) {
      notes.push({
        kind: 'mirrored',
        key: 'mcp.servers',
        detail: 'mirrored flat mcp servers under mcp.servers for v1',
      })
    }
    return
  }

  if (flat.length === 0) {
    for (const [name, config] of Object.entries(servers)) {
      if (insert(['mcp', name], config)) {
        notes.push({
          kind: 'mirrored',
          key: `mcp.${name}`,
          detail: 'mirrored an mcp.servers entry to the flat shape for v2',
        })
      }
    }
    return
  }

  for (const [name, config] of flat) {
    if (Object.hasOwn(servers, name)) continue
    if (insert(['mcp', 'servers', name], config)) {
      notes.push({
        kind: 'mirrored',
        key: `mcp.servers.${name}`,
        detail: 'unioned a flat mcp server into mcp.servers for v1',
      })
    }
  }
  for (const [name, config] of Object.entries(servers)) {
    if (flat.some(([flatName]) => flatName === name)) continue
    if (insert(['mcp', name], config)) {
      notes.push({
        kind: 'mirrored',
        key: `mcp.${name}`,
        detail: 'unioned an mcp.servers entry into the flat shape for v2',
      })
    }
  }
}

export type OpenCodePathFieldKind = 'sound' | 'plugin' | 'skill'
export type OpenCodePathAction = 'tokenized' | 'expanded'

export interface OpenCodePathRewrite {
  key: string
  kind: OpenCodePathFieldKind
  from: string
  to: string
  action: OpenCodePathAction
}

export interface OpenCodePathRewriteResult {
  text: string
  rewrites: OpenCodePathRewrite[]
  notes: string[]
}

interface PathCandidate {
  path: (string | number)[]
  kind: OpenCodePathFieldKind
}

const URL_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//i
const TOKEN_PATTERN = /\$HOME|\$\{[A-Za-z0-9_]+\}|%APPDATA%/

function collectPathCandidates(root: Record<string, unknown>): PathCandidate[] {
  const candidates: PathCandidate[] = []
  // Local plugin paths may appear under the v1 or v2 spelling before normalization runs.
  for (const pluginsKey of ['plugins', 'plugin']) {
    const list = root[pluginsKey]
    if (!Array.isArray(list)) continue
    list.forEach((entry, index) => {
      if (typeof entry === 'string') candidates.push({ path: [pluginsKey, index], kind: 'plugin' })
      else if (isPlainObject(entry) && typeof entry.package === 'string') {
        candidates.push({ path: [pluginsKey, index, 'package'], kind: 'plugin' })
      }
    })
  }
  const skills = root.skills
  if (Array.isArray(skills)) {
    skills.forEach((entry, index) => {
      if (typeof entry === 'string') candidates.push({ path: ['skills', index], kind: 'skill' })
    })
  }
  const attention = root.attention
  if (isPlainObject(attention) && isPlainObject(attention.sounds)) {
    for (const [name, sound] of Object.entries(attention.sounds)) {
      if (typeof sound === 'string')
        candidates.push({ path: ['attention', 'sounds', name], kind: 'sound' })
    }
  }
  return candidates
}

/** Upload: replace absolute local paths with tokens. Relative paths keep their documented meaning. */
function tokenizePathValue(
  value: string,
  kind: OpenCodePathFieldKind,
  tokenEnv: TokenEnv,
): { to: string } | { note: string } {
  if (URL_PATTERN.test(value)) return { to: value }
  if (value === '~' || value.startsWith('~/')) {
    // Skills are documented as `~`-expanded; only the other fields need the generic token.
    if (kind === 'skill') return { to: value }
    return { to: `$HOME${value.slice(1)}` }
  }
  if (TOKEN_PATTERN.test(value)) {
    if (kind === 'skill' && (value === '$HOME' || value.startsWith('$HOME/'))) {
      return { to: `~${value.slice('$HOME'.length)}` }
    }
    return { to: value }
  }
  try {
    const tokenized = tokenize(value, tokenEnv)
    if (kind === 'skill' && (tokenized === '$HOME' || tokenized.startsWith('$HOME/'))) {
      return { to: `~${tokenized.slice('$HOME'.length)}` }
    }
    return { to: tokenized }
  } catch (error) {
    if (error instanceof PathError && error.code === 'relative-path') {
      return { note: 'relative path, kept as-is (plugin paths resolve against the config file)' }
    }
    return { note: error instanceof Error ? error.message : String(error) }
  }
}

/** Apply: expand tokens back to absolute paths on this machine. */
function expandPathValue(value: string, tokenEnv: TokenEnv): { to: string } | { note: string } {
  if (value === '~') return { to: tokenEnv.home }
  if (value.startsWith('~/')) {
    const joined = path.join(tokenEnv.home, ...value.slice(2).split('/'))
    return { to: tokenEnv.platform === 'win32' ? joined.replace(/\//g, '\\') : joined }
  }
  if (!TOKEN_PATTERN.test(value)) return { to: value }
  try {
    return { to: expand(value, tokenEnv) }
  } catch (error) {
    return { note: error instanceof Error ? error.message : String(error) }
  }
}

/** Tokenize on upload, expand on apply. Both directions are pure; `tokenEnv` comes from the CLI edge. */
export function opencodePathRewrite(
  text: string,
  mode: 'tokenize' | 'expand',
  tokenEnv: TokenEnv,
): OpenCodePathRewriteResult {
  const rewrites: OpenCodePathRewrite[] = []
  const notes: string[] = []
  const parsed = parseJsonc(text)
  if (parsed === undefined || !isPlainObject(parsed.value)) {
    return { text, rewrites, notes: ['not a JSONC object; left untouched'] }
  }
  let content = text
  const format = formattingOptions(text)
  for (const candidate of collectPathCandidates(parsed.value)) {
    const key = candidate.path.join('.')
    const current = valueAtPath(parsed.value, candidate.path)
    if (typeof current !== 'string') continue
    const outcome =
      mode === 'tokenize'
        ? tokenizePathValue(current, candidate.kind, tokenEnv)
        : expandPathValue(current, tokenEnv)
    if ('note' in outcome) {
      notes.push(`${key}: ${outcome.note}`)
      continue
    }
    if (outcome.to === current) continue
    const edited = applyEdit(
      content,
      modify(content, candidate.path, outcome.to, { formattingOptions: format }),
    )
    if (!edited.ok) {
      notes.push(`${key}: ${edited.reason}`)
      continue
    }
    content = edited.text
    rewrites.push({
      key,
      kind: candidate.kind,
      from: current,
      to: outcome.to,
      action: mode === 'tokenize' ? 'tokenized' : 'expanded',
    })
  }
  return { text: content, rewrites, notes }
}

export interface OpenCodeSkillReference {
  id: string
  path: string
  reason: string
}

/**
 * Skill trees OpenCode reads from other harnesses. Each is declared `shared`, so
 * `resolveOwnership` elects the direct owner when one exists and emits an `OwnershipRef`
 * back to this adapter; OpenCode is never a second owner.
 */
export const OPENCODE_SKILL_REFERENCES: readonly OpenCodeSkillReference[] = [
  {
    id: 'opencode.claude-skills',
    path: '$HOME/.claude/skills',
    reason: 'Claude Code owns this tree; OpenCode reads it as a skill source.',
  },
  {
    id: 'opencode.agents-skills',
    path: '$HOME/.agents/skills',
    reason: 'Codex and OpenCode share this tree; the direct owner keeps it.',
  },
]

export function opencodeSkillOwnership(): TreeSurface[] {
  return OPENCODE_SKILL_REFERENCES.map((reference): TreeSurface => {
    return {
      id: SurfaceId.parse(reference.id),
      harness: 'opencode',
      kind: 'tree',
      path: reference.path,
      policy: 'sync',
      description: `Skill source (reference only): ${reference.reason}`,
      format: 'mixed',
      merge: 'text3way',
      exclude: [],
      transforms: [],
      secretRules: [],
      shared: true,
    }
  })
}
