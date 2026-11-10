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
import { isPlainObject } from '../../merge/treeMerge'
import { expand, PathError, type TokenEnv, tokenize } from '../../paths'
import type { TreeSurface } from '../../types'
import type { OpenCodeSchemaVersion } from './detect'

export type OpenCodeKeyOwner = 'v1' | 'v2' | 'both'

export interface OpenCodeSchema {
  version: OpenCodeSchemaVersion
  keys: Record<string, OpenCodeKeyOwner>
}

/**
 * Which versions accept a key. V2 also accepts supported V1 fields and normalizes them
 * in memory. This metadata must never be used to copy values between schema shapes.
 */
export const OPENCODE_SCHEMA_KEYS: Readonly<Record<string, OpenCodeKeyOwner>> = {
  plugin: 'both',
  plugins: 'v2',
  agent: 'both',
  agents: 'v2',
  command: 'both',
  commands: 'v2',
  permission: 'both',
  permissions: 'v2',
  mcp: 'both',
  'mcp.servers': 'v2',
  // V1 uses an object; V2 also accepts an array. Preserve the source shape.
  skills: 'both',
  model: 'both',
  small_model: 'both',
  provider: 'both',
  providers: 'v2',
  instructions: 'both',
}

/** The key table from one schema version's point of view. */
export function opencodeSchema(version: OpenCodeSchemaVersion): OpenCodeSchema {
  return { version, keys: { ...OPENCODE_SCHEMA_KEYS } }
}

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
 * Preserve native config in both directions. OpenCode handles supported V1 compatibility
 * itself; copying aliases can turn permission objects into invalid V2 arrays and override
 * valid settings. Version migration belongs to OpenCode, never the sync projection.
 */
export function opencodeSchemaNormalize(
  text: string,
  _mode: 'upload' | 'apply',
): OpenCodeNormalizeResult {
  const notes: OpenCodeNormalizeNote[] = []
  const parsed = parseJsonc(text)
  if (parsed === undefined || !isPlainObject(parsed.value)) {
    notes.push({ kind: 'invalid', key: '', detail: 'not a JSONC object; left untouched' })
    return { text, notes }
  }
  return { text, notes }
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
