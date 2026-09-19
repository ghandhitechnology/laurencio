import { parse, stringify, type TomlTable } from 'smol-toml'
import type { ConflictRegion, FormatReport, MergeResult } from '../model'
import { type KeyMergeOp, planKeyMerge } from './treeMerge'

export interface TomlMergeOptions {
  /** Dot-joined key paths whose arrays merge by union; everything else conflicts. */
  unionArrays?: readonly string[]
  /**
   * Canonical re-serialization when the line patcher cannot apply an op.
   * Default false: keep the patched local text and report the merge conflicted.
   */
  allowReserialize?: boolean
}

export interface TomlMergeResult extends MergeResult {
  format: FormatReport
}

/**
 * Table-aware TOML merge. Changed keys are patched in place so comments,
 * key order, and whitespace survive. Anything the line patcher cannot express
 * is reported, never silently rewritten.
 */
export function mergeToml(
  baseText: string,
  localText: string,
  remoteText: string,
  options: TomlMergeOptions = {},
): TomlMergeResult {
  let base: unknown
  let local: unknown
  let remote: unknown
  try {
    base = parse(baseText)
    local = parse(localText)
    remote = parse(remoteText)
  } catch (error) {
    return refuse(localText, `invalid TOML: ${errorMessage(error)}`)
  }

  const plan = planKeyMerge(base, local, remote, {
    ...(options.unionArrays !== undefined ? { unionArrays: options.unionArrays } : {}),
    // Arrays of tables hold positional objects; index alignment is the only
    // sound way to merge them, unlike JSON arrays where order is user data.
    mergeObjectArraysByIndex: true,
  })
  const remoteIndex = scanToml(remoteText)
  const localIndex = scanToml(localText)
  const baseIndex = scanToml(baseText)

  let text = localText
  const unpatched: string[] = []
  let patched = 0
  for (const op of plan.ops) {
    const outcome = applyTomlOp(text, op, remoteIndex)
    if (outcome.ok) {
      text = outcome.text
      patched++
    } else {
      unpatched.push(outcome.reason)
    }
  }

  const conflicts: ConflictRegion[] = plan.conflicts.map((conflict) => ({
    baseRange: tomlRange(baseIndex, conflict.path),
    localRange: tomlRange(localIndex, conflict.path),
    remoteRange: tomlRange(remoteIndex, conflict.path),
  }))

  if (unpatched.length > 0) {
    const reason = `line patcher could not apply: ${unpatched.join('; ')}`
    if (options.allowReserialize === true) {
      const merged = applyTomlOps(local, plan.ops)
      return {
        status: 'conflicted',
        content: stringify(merged as TomlTable),
        conflicts,
        format: { preserved: false, mode: 'reserialized', reason },
      }
    }
    return {
      status: 'conflicted',
      content: text,
      conflicts,
      format: { preserved: true, mode: patched > 0 ? 'patched' : 'verbatim', reason },
    }
  }

  const status = conflicts.length > 0 ? 'conflicted' : text === localText ? 'unchanged' : 'clean'
  return {
    status,
    content: text,
    conflicts,
    format: { preserved: true, mode: patched > 0 ? 'patched' : 'verbatim' },
  }
}

type PatchOutcome = { ok: true; text: string } | { ok: false; reason: string }

function applyTomlOp(text: string, op: KeyMergeOp, remoteIndex: TomlIndex): PatchOutcome {
  const index = scanToml(text)
  const site = index.keys.get(pathKey(op.path))
  if (op.kind === 'delete') {
    if (!site) {
      const table = index.tables.get(pathKey(op.path))
      if (!table || table.headerLine < 0) return { ok: true, text }
      return deleteTableSection(index, table, op)
    }
    if (site.multiline) {
      return { ok: false, reason: `cannot delete multi-line value at ${dotPath(op.path)}` }
    }
    const lines = [...index.lines]
    lines.splice(site.lineStart, 1)
    return validate(lines.join('\n'), op)
  }
  if (site) {
    if (site.multiline) {
      return { ok: false, reason: `cannot patch multi-line value at ${dotPath(op.path)}` }
    }
    const verbatim = op.origin === 'remote' ? remoteValueText(remoteIndex, op.path) : undefined
    const line = index.lines[site.lineStart] ?? ''
    const lines = [...index.lines]
    lines[site.lineStart] =
      line.slice(0, site.valueStart) +
      (verbatim ?? serializeTomlValue(op.value)) +
      line.slice(site.valueEnd)
    return validate(lines.join('\n'), op)
  }
  const inline = applyInlineTableOp(index, op, remoteIndex)
  if (inline) return inline
  return insertTomlKey(index, op, remoteIndex)
}

/**
 * Inline tables (`env = { FOO = 1 }`) have no key lines to patch. The nearest
 * enclosing inline table is replaced with the remote's verbatim text, which
 * keeps the rest of the file untouched.
 */
function applyInlineTableOp(
  index: TomlIndex,
  op: KeyMergeOp,
  remoteIndex: TomlIndex,
): PatchOutcome | undefined {
  if (op.origin !== 'remote') return undefined
  for (let depth = op.path.length - 1; depth >= 1; depth--) {
    const ancestorPath = op.path.slice(0, depth)
    const site = index.keys.get(pathKey(ancestorPath))
    if (!site || site.multiline || !site.valueText.trimStart().startsWith('{')) continue
    const verbatim = remoteValueText(remoteIndex, ancestorPath)
    if (verbatim === undefined) {
      return { ok: false, reason: `cannot patch inline table at ${dotPath(ancestorPath)}` }
    }
    const line = index.lines[site.lineStart] ?? ''
    const lines = [...index.lines]
    lines[site.lineStart] = line.slice(0, site.valueStart) + verbatim + line.slice(site.valueEnd)
    return validate(lines.join('\n'), op)
  }
  return undefined
}

function deleteTableSection(index: TomlIndex, table: TableSite, op: KeyMergeOp): PatchOutcome {
  const end = tableSectionEnd(index, table.headerLine)
  let start = commentStart(index.lines, table.headerLine)
  // Swallow the blank line that separated the removed section from the rest.
  if (start > 0 && (index.lines[start - 1] ?? '').trim() === '' && end >= index.lines.length - 1) {
    start--
  }
  const lines = [...index.lines]
  lines.splice(start, end - start)
  return validate(lines.join('\n'), op)
}

function insertTomlKey(
  index: TomlIndex,
  op: Extract<KeyMergeOp, { kind: 'set' }>,
  remoteIndex: TomlIndex,
): PatchOutcome {
  const key = op.path.at(-1)
  if (key === undefined) return { ok: false, reason: 'empty key path' }
  const parentPath = op.path.slice(0, -1)
  const verbatim = op.origin === 'remote' ? remoteValueText(remoteIndex, op.path) : undefined
  const rendered = verbatim ?? serializeTomlValue(op.value)

  // The remote may express this value as a `[table]` section. Copy those
  // sections verbatim so comments and formatting survive; a synthesized line
  // would flatten the table into an inline table.
  const section = isObjectValue(op.value) ? remoteSubtreeLines(remoteIndex, op.path) : []
  if (section.length > 0) return insertLines(index, section, op)

  // An array of tables is a run of `[[path]]` sections, one per element.
  if (Array.isArray(op.value)) {
    const arraySections = remoteArrayTableSections(remoteIndex, op.path)
    if (arraySections.length > 0) return insertLines(index, arraySections, op)
  }

  const ancestor = longestAncestorTable(index, parentPath)
  const dottedPath = [...parentPath.slice(ancestor.depth), key]
  const line = `${dottedPath.map(serializeTomlKey).join('.')} = ${rendered}`
  const lines = [...index.lines]
  if (ancestor.depth === 0) {
    const root = rootTable(index)
    const at =
      root.lastKeyLine >= 0
        ? root.lastKeyLine + 1
        : firstHeaderLine(index) < lines.length
          ? firstHeaderLine(index)
          : trailingBlankStart(lines)
    lines.splice(at, 0, line)
  } else {
    const table = ancestor.table
    const at = table.lastKeyLine >= 0 ? table.lastKeyLine + 1 : table.headerLine + 1
    lines.splice(at, 0, `${table.indent}${line}`)
  }
  return validate(lines.join('\n'), op)
}

/** Deepest table in the local text that encloses `path`; the root table always matches. */
function longestAncestorTable(
  index: TomlIndex,
  path: readonly string[],
): { table: TableSite; depth: number } {
  let best: { table: TableSite; depth: number } = { table: rootTable(index), depth: 0 }
  for (let depth = 1; depth <= path.length; depth++) {
    const table = index.tables.get(pathKey(path.slice(0, depth)))
    if (table) best = { table, depth }
  }
  return best
}

function rootTable(index: TomlIndex): TableSite {
  const root = index.tables.get(pathKey([]))
  if (!root) throw new Error('toml index lost its root table')
  return root
}

function isObjectValue(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function firstHeaderLine(index: TomlIndex): number {
  let at = index.lines.length
  for (const table of index.tables.values()) {
    if (table.headerLine >= 0 && table.headerLine < at) at = table.headerLine
  }
  return at
}

function insertLines(index: TomlIndex, inserted: readonly string[], op: KeyMergeOp): PatchOutcome {
  const lines = [...index.lines]
  const at = trailingBlankStart(lines)
  lines.splice(at, 0, ...(at > 0 ? [''] : []), ...inserted)
  return validate(lines.join('\n'), op)
}

function trailingBlankStart(lines: readonly string[]): number {
  let at = lines.length
  while (at > 0 && (lines[at - 1] ?? '').trim() === '') at--
  return at
}

/**
 * Verbatim remote sections for a new subtree: the table at `path` and any
 * deeper tables, each with the comment lines directly above its header.
 */
function remoteSubtreeLines(remoteIndex: TomlIndex, path: readonly string[]): string[] {
  const sections: Array<{ start: number; end: number }> = []
  for (const [key, table] of remoteIndex.tables) {
    const tablePath = key.split('\u0000')
    if (table.headerLine < 0 || !isPathPrefix(path, tablePath)) continue
    sections.push({
      start: commentStart(remoteIndex.lines, table.headerLine),
      end: tableSectionEnd(remoteIndex, table.headerLine),
    })
  }
  sections.sort((a, b) => a.start - b.start)
  const lines: string[] = []
  for (const section of sections) {
    if (lines.length > 0) lines.push('')
    lines.push(...remoteIndex.lines.slice(section.start, section.end))
  }
  return lines
}

function isPathPrefix(prefix: readonly string[], candidate: readonly string[]): boolean {
  return (
    candidate.length >= prefix.length &&
    prefix.every((segment, index) => candidate[index] === segment)
  )
}

/** Verbatim remote `[[path]]` sections, one per array element. */
function remoteArrayTableSections(remoteIndex: TomlIndex, path: readonly string[]): string[] {
  const lines: string[] = []
  for (const [key, table] of remoteIndex.tables) {
    const tablePath = key.split('\u0000')
    if (table.headerLine < 0 || !isArrayTablePath(tablePath, path)) continue
    const start = commentStart(remoteIndex.lines, table.headerLine)
    const end = tableSectionEnd(remoteIndex, table.headerLine)
    if (lines.length > 0) lines.push('')
    lines.push(...remoteIndex.lines.slice(start, end))
  }
  return lines
}

/** `mcp.0` is the scanner's path for the first `[[mcp]]` element. */
function isArrayTablePath(candidate: readonly string[], path: readonly string[]): boolean {
  return (
    candidate.length === path.length + 1 &&
    isPathPrefix(path, candidate) &&
    /^\d+$/.test(candidate.at(-1) ?? '')
  )
}

function commentStart(lines: readonly string[], headerLine: number): number {
  let start = headerLine
  while (start > 0 && (lines[start - 1] ?? '').trim().startsWith('#')) start--
  return start
}

function tableSectionEnd(index: TomlIndex, headerLine: number): number {
  let end = index.lines.length
  for (const table of index.tables.values()) {
    if (table.headerLine > headerLine && table.headerLine < end) end = table.headerLine
  }
  while (end > headerLine && (index.lines[end - 1] ?? '').trim() === '') end--
  return end
}

function validate(text: string, op: KeyMergeOp): PatchOutcome {
  try {
    parse(text)
    return { ok: true, text }
  } catch {
    return { ok: false, reason: `patch of ${dotPath(op.path)} produced invalid TOML` }
  }
}

function remoteValueText(remoteIndex: TomlIndex, path: readonly string[]): string | undefined {
  const site = remoteIndex.keys.get(pathKey(path))
  return site && !site.multiline ? site.valueText : undefined
}

function applyTomlOps(local: unknown, ops: readonly KeyMergeOp[]): unknown {
  for (const op of ops) {
    const parent = containerAt(local, op.path)
    const key = op.path.at(-1)
    if (!parent || key === undefined) continue
    if (op.kind === 'delete') delete parent[key]
    else parent[key] = op.value
  }
  return local
}

function containerAt(root: unknown, path: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = root
  for (const segment of path.slice(0, -1)) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return typeof current === 'object' && current !== null && !Array.isArray(current)
    ? (current as Record<string, unknown>)
    : undefined
}

interface KeySite {
  lineStart: number
  lineEnd: number
  valueStart: number
  valueEnd: number
  valueText: string
  multiline: boolean
}

interface TableSite {
  headerLine: number
  lastKeyLine: number
  indent: string
}

interface TomlIndex {
  lines: string[]
  keys: Map<string, KeySite>
  tables: Map<string, TableSite>
}

function scanToml(text: string): TomlIndex {
  const lines = text.split('\n')
  const keys = new Map<string, KeySite>()
  const tables = new Map<string, TableSite>()
  const root: TableSite = { headerLine: -1, lastKeyLine: -1, indent: '' }
  tables.set(pathKey([]), root)
  const arrayCounts = new Map<string, number>()
  let current = root
  let currentPath: string[] = []
  let index = 0

  while (index < lines.length) {
    const raw = lines[index] ?? ''
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#')) {
      index++
      continue
    }
    const header = stripComment(trimmed).trim()
    if (header.startsWith('[[') && header.endsWith(']]')) {
      const path = parseDottedKey(header.slice(2, -2))
      if (!path) {
        index++
        continue
      }
      const count = arrayCounts.get(pathKey(path)) ?? 0
      arrayCounts.set(pathKey(path), count + 1)
      currentPath = [...path, String(count)]
      current = { headerLine: index, lastKeyLine: -1, indent: '' }
      tables.set(pathKey(currentPath), current)
      index++
      continue
    }
    if (header.startsWith('[') && header.endsWith(']')) {
      const path = parseDottedKey(header.slice(1, -1))
      if (!path) {
        index++
        continue
      }
      currentPath = path
      current = { headerLine: index, lastKeyLine: -1, indent: '' }
      tables.set(pathKey(path), current)
      index++
      continue
    }

    const equals = findEquals(raw)
    const keySegments = equals === -1 ? undefined : parseDottedKey(raw.slice(0, equals))
    const valueStart = equals === -1 ? -1 : findValueStart(raw, equals)
    if (!keySegments || valueStart === -1) {
      index++
      continue
    }
    const extent = findValueEnd(lines, index, valueStart)
    const path = [...currentPath, ...keySegments]
    const indent = /^[ \t]*/.exec(raw)?.[0] ?? ''
    keys.set(pathKey(path), {
      lineStart: index,
      lineEnd: extent.endLine + 1,
      valueStart,
      valueEnd: extent.endCol,
      valueText: raw.slice(valueStart, extent.endLine === index ? extent.endCol : raw.length),
      multiline: extent.multiline,
    })
    current.lastKeyLine = index
    if (indent !== '') current.indent = indent
    index = extent.endLine + 1
  }
  return { lines, keys, tables }
}

/** Finds `=` outside quoted keys. */
function findEquals(line: string): number {
  let quote: "'" | '"' | undefined
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (char === '\\') index++
      else if (char === '"') quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '#') return -1
    else if (char === '=') return index
  }
  return -1
}

function findValueStart(line: string, equals: number): number {
  let index = equals + 1
  while (index < line.length && (line[index] === ' ' || line[index] === '\t')) index++
  return index < line.length ? index : -1
}

/** Scans a value to its end, tracking strings, brackets, and the inline comment. */
function findValueEnd(
  lines: readonly string[],
  startLine: number,
  startCol: number,
): { endLine: number; endCol: number; multiline: boolean } {
  let line = startLine
  let column = startCol
  let depth = 0
  let state: 'plain' | 'basic' | 'literal' | 'multiline-basic' | 'multiline-literal' = 'plain'
  let endLine = startLine
  let endCol = startCol

  while (line < lines.length) {
    const text = lines[line] ?? ''
    while (column < text.length) {
      const char = text[column]
      const next = text[column + 1]
      const third = text[column + 2]
      if (state === 'plain') {
        if (char === '#') {
          if (depth > 0) {
            column = text.length
            break
          }
          return {
            endLine: line,
            endCol: trimTrailingWhitespace(text, column),
            multiline: line !== startLine,
          }
        }
        if (char === '"') {
          if (next === '"' && third === '"') state = 'multiline-basic'
          else state = 'basic'
          column += state === 'multiline-basic' ? 3 : 1
          endLine = line
          endCol = column
          continue
        }
        if (char === "'") {
          if (next === "'" && third === "'") state = 'multiline-literal'
          else state = 'literal'
          column += state === 'multiline-literal' ? 3 : 1
          endLine = line
          endCol = column
          continue
        }
        if (char === '[' || char === '{') depth++
        else if (char === ']' || char === '}') depth--
        column++
        endLine = line
        endCol = column
        continue
      }
      if (state === 'basic') {
        if (char === '\\') column += 2
        else {
          if (char === '"') state = 'plain'
          column++
        }
      } else if (state === 'literal') {
        if (char === "'") state = 'plain'
        column++
      } else if (state === 'multiline-basic') {
        if (char === '"' && next === '"' && third === '"') {
          state = 'plain'
          column += 3
        } else column++
      } else {
        if (char === "'" && next === "'" && third === "'") {
          state = 'plain'
          column += 3
        } else column++
      }
      endLine = line
      endCol = column
    }
    if (state === 'basic' || state === 'literal') {
      // A newline inside a single-line string is malformed TOML; leave it unpatched.
      return { endLine: line, endCol: text.length, multiline: true }
    }
    line++
    column = 0
    if (state === 'plain' && depth === 0) break
  }
  const endText = lines[endLine] ?? ''
  return {
    endLine,
    endCol: trimTrailingWhitespace(endText, endCol),
    multiline: endLine !== startLine,
  }
}

function trimTrailingWhitespace(text: string, column: number): number {
  let end = column
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--
  return end
}

/** Removes a trailing comment, ignoring `#` inside quoted strings. */
function stripComment(text: string): string {
  let quote: "'" | '"' | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (quote === '"') {
      if (char === '\\') index++
      else if (char === '"') quote = undefined
      continue
    }
    if (char === "'" || char === '"') quote = char
    else if (char === '#') return text.slice(0, index)
  }
  return text
}

function parseDottedKey(text: string): string[] | undefined {
  const segments: string[] = []
  let index = 0
  const trimmed = text.trim()
  while (index < trimmed.length) {
    while (trimmed[index] === ' ' || trimmed[index] === '\t') index++
    const char = trimmed[index]
    if (char === '"' || char === "'") {
      const end = findClosingQuote(trimmed, index, char)
      if (end === -1) return undefined
      const raw = trimmed.slice(index, end + 1)
      if (char === '"') {
        try {
          const parsed: unknown = JSON.parse(raw)
          if (typeof parsed !== 'string') return undefined
          segments.push(parsed)
        } catch {
          return undefined
        }
      } else {
        segments.push(raw.slice(1, -1))
      }
      index = end + 1
    } else {
      const start = index
      while (index < trimmed.length && trimmed[index] !== '.') index++
      const bare = trimmed.slice(start, index).trim()
      if (!/^[A-Za-z0-9_-]+$/.test(bare)) return undefined
      segments.push(bare)
    }
    while (trimmed[index] === ' ' || trimmed[index] === '\t') index++
    if (index < trimmed.length) {
      if (trimmed[index] !== '.') return undefined
      index++
    }
  }
  return segments.length > 0 ? segments : undefined
}

function findClosingQuote(text: string, start: number, quote: "'" | '"'): number {
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index]
    if (quote === '"' && char === '\\') index++
    else if (char === quote) return index
  }
  return -1
}

export function serializeTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan'
    if (value === Infinity) return 'inf'
    if (value === -Infinity) return '-inf'
    return String(value)
  }
  if (typeof value === 'bigint') return `${value}`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return `[${value.map(serializeTomlValue).join(', ')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(
      ([key, item]) => `${serializeTomlKey(key)} = ${serializeTomlValue(item)}`,
    )
    return `{ ${entries.join(', ')} }`
  }
  throw new Error(`cannot serialize TOML value: ${typeof value}`)
}

function serializeTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
}

function tomlRange(index: TomlIndex, path: readonly string[]): [number, number] {
  const site = index.keys.get(pathKey(path))
  if (site) return [site.lineStart + 1, site.lineEnd + 1]
  const table = index.tables.get(pathKey(path.slice(0, -1)))
  const anchor = table ? Math.max(table.headerLine, table.lastKeyLine) : -1
  return [anchor + 2, anchor + 2]
}

function pathKey(path: readonly string[]): string {
  return path.join('\u0000')
}

function dotPath(path: readonly string[]): string {
  return path.join('.')
}

function refuse(localText: string, reason: string): TomlMergeResult {
  return {
    status: 'conflicted',
    content: localText,
    conflicts: [],
    format: { preserved: true, mode: 'verbatim', reason },
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
