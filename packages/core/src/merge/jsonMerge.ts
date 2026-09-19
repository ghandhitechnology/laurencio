import {
  applyEdits,
  type EditResult,
  type FormattingOptions,
  findNodeAtLocation,
  modify,
  type Node,
  type ParseError,
  parse,
  parseTree,
} from 'jsonc-parser'
import type { ConflictRegion, FormatReport, MergeResult } from '../model'
import { deepEqual, isPlainObject, planKeyMerge } from './treeMerge'

export interface JsoncMergeOptions {
  /** Dot-joined key paths whose arrays merge by union; everything else conflicts. */
  unionArrays?: readonly string[]
}

export interface JsoncMergeResult extends MergeResult {
  format: FormatReport
}

/**
 * Key-level JSONC merge through jsonc-parser edits: scalar changes keep the
 * surrounding comments, key order, and whitespace. Unknown keys from both sides
 * survive because only changed paths are touched.
 */
export function mergeJsonc(
  baseText: string,
  localText: string,
  remoteText: string,
  options: JsoncMergeOptions = {},
): JsoncMergeResult {
  const parsed = {
    base: parseJsonc(baseText),
    local: parseJsonc(localText),
    remote: parseJsonc(remoteText),
  }
  const { base, local, remote } = parsed
  if (!base || !local || !remote) {
    return refuse(localText, 'invalid JSONC; key merge refused')
  }

  const plan = planKeyMerge(base.value, local.value, remote.value, {
    ...(options.unionArrays !== undefined ? { unionArrays: options.unionArrays } : {}),
  })
  const formattingOptions = detectFormatting(localText)
  const replacedContainers: string[] = []
  let patched = 0

  // Ops are applied one at a time against the current text: jsonc-parser
  // computes offsets against the text it is given, and appends to one array
  // would otherwise produce overlapping edits.
  let content = localText
  for (const op of plan.ops) {
    const current = parseJsonc(content)
    if (!current) return refuse(localText, 'jsonc edits produced invalid JSONC')
    if (op.kind === 'delete') {
      if (findNodeAtLocation(current.root, [...op.path]) === undefined) continue
      const outcome = applyEdit(content, modify(content, op.path, undefined, { formattingOptions }))
      if (!outcome.ok) return refuse(localText, outcome.reason)
      content = outcome.text
      patched++
      continue
    }
    const existing = findNodeAtLocation(current.root, [...op.path])
    const localValue = valueAtPath(current.value, op.path)
    if (op.origin === 'union' && Array.isArray(localValue)) {
      const outcome = appendArrayItems(content, localValue, op.path, op.value, formattingOptions)
      if (!outcome.ok) return refuse(localText, outcome.reason)
      content = outcome.text
      patched++
      continue
    }
    const outcome = applyEdit(content, modify(content, op.path, op.value, { formattingOptions }))
    if (!outcome.ok) return refuse(localText, outcome.reason)
    content = outcome.text
    patched++
    if (existing && (existing.type === 'object' || existing.type === 'array')) {
      replacedContainers.push(op.path.join('.'))
    }
  }

  const conflicts: ConflictRegion[] = plan.conflicts.map((conflict) => ({
    baseRange: rangeForPath(baseText, base.root, conflict.path),
    localRange: rangeForPath(localText, local.root, conflict.path),
    remoteRange: rangeForPath(remoteText, remote.root, conflict.path),
  }))

  const status = conflicts.length > 0 ? 'conflicted' : content === localText ? 'unchanged' : 'clean'
  return {
    status,
    content,
    conflicts,
    format: {
      preserved: replacedContainers.length === 0,
      mode: patched > 0 ? 'patched' : 'verbatim',
      ...(replacedContainers.length > 0
        ? { reason: `replaced container values: ${replacedContainers.join(', ')}` }
        : {}),
    },
  }
}

interface ParsedJsonc {
  value: unknown
  root: Node
}

function parseJsonc(text: string): ParsedJsonc | undefined {
  const errors: ParseError[] = []
  const options = { allowTrailingComma: true, disallowComments: false }
  const root = parseTree(text, errors, options)
  if (!root || errors.length > 0) return undefined
  return { value: parse(text, undefined, options) as unknown, root }
}

/** Appends union items one at a time, re-reading the text after each insert. */
function appendArrayItems(
  text: string,
  localValue: readonly unknown[],
  path: readonly string[],
  unionValue: unknown,
  formattingOptions: FormattingOptions,
): { ok: true; text: string } | { ok: false; reason: string } {
  if (!Array.isArray(unionValue)) return { ok: true, text }
  let content = text
  let appended = 0
  for (const item of unionValue) {
    if (localValue.some((existing) => deepEqual(existing, item))) continue
    const index = localValue.length + appended
    const edit = modify(content, [...path, index], item, {
      formattingOptions,
      isArrayInsertion: true,
    })
    const outcome = applyEdit(content, edit)
    if (!outcome.ok) return outcome
    content = outcome.text
    appended++
  }
  return { ok: true, text: content }
}

function applyEdit(
  text: string,
  edits: EditResult,
): { ok: true; text: string } | { ok: false; reason: string } {
  try {
    return { ok: true, text: applyEdits(text, edits) }
  } catch (error) {
    return { ok: false, reason: `jsonc edit failed: ${errorMessage(error)}` }
  }
}

function valueAtPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root
  for (const segment of path) {
    if (Array.isArray(current)) current = current[Number(segment)]
    else if (isPlainObject(current)) current = current[segment]
    else return undefined
  }
  return current
}

function rangeForPath(text: string, root: Node, path: readonly string[]): [number, number] {
  const node = findNodeAtLocation(root, [...path])
  if (node) {
    const startLine = lineAtOffset(text, node.offset) + 1
    const endLine = lineAtOffset(text, Math.max(node.offset, node.offset + node.length - 1)) + 1
    return [startLine, endLine + 1]
  }
  const parent = findNodeAtLocation(root, path.slice(0, -1)) ?? root
  const endLine = lineAtOffset(text, Math.max(parent.offset, parent.offset + parent.length - 1)) + 1
  return [endLine, endLine]
}

function lineAtOffset(text: string, offset: number): number {
  let line = 0
  for (let index = 0; index < offset && index < text.length; index++) {
    if (text[index] === '\n') line++
  }
  return line
}

function detectFormatting(text: string): FormattingOptions {
  const tabIndented = /^\t/m.test(text)
  const spaces = /^( +)\S/m.exec(text)
  return {
    insertSpaces: !tabIndented,
    tabSize: spaces?.[1]?.length ?? 2,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  }
}

function refuse(localText: string, reason: string): JsoncMergeResult {
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
