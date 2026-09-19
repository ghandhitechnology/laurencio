import { structuredPatch } from 'diff'
import { diff3Merge } from 'node-diff3'
import type { ConflictRegion, FormatReport, MergeResult } from '../model'

export const DEFAULT_MARKER_NAME = 'laurencio:local'

/** A `<!-- laurencio:local -->` block lifted out of the working copy before merging. */
export interface MarkerBlock {
  /** Normalized opening marker line, used to find the anchor after the merge. */
  startMarker: string
  endMarker: string
  body: string[]
}

export interface MarkerExtraction {
  /** The file without block bodies; marker lines stay as anchors. */
  projection: string
  blocks: MarkerBlock[]
}

export interface TextMergeOptions {
  /** Strip local marker blocks before merging and re-insert them after. */
  markerBlocks?: boolean
  /** Marker name inside the HTML comment; default `laurencio:local`. */
  markerName?: string
}

export interface TextMergeResult extends MergeResult {
  format: FormatReport
}

export interface UnifiedDiffOptions {
  from?: string
  to?: string
  context?: number
}

/**
 * Three-way merge over lines. Clean merges are symmetric; conflicts keep the
 * local side in `content` and are reported with 1-based, end-exclusive ranges.
 */
export function mergeText3Way(
  baseText: string,
  localText: string,
  remoteText: string,
  options: TextMergeOptions = {},
): TextMergeResult {
  const markerName = options.markerName ?? DEFAULT_MARKER_NAME
  const localNormalized = normalizeEol(localText)
  let local = localNormalized.text
  let blocks: MarkerBlock[] = []
  if (options.markerBlocks === true) {
    try {
      const extracted = extractMarkerBlocks(local, markerName)
      local = extracted.projection
      blocks = extracted.blocks
    } catch (error) {
      return {
        status: 'conflicted',
        content: localText,
        conflicts: [],
        format: { preserved: true, mode: 'verbatim', reason: errorMessage(error) },
      }
    }
  }

  const base = normalizeEol(baseText)
  const remote = normalizeEol(remoteText)
  const regions = diff3Merge(local.split('\n'), base.text.split('\n'), remote.text.split('\n'), {
    excludeFalseConflicts: true,
  })

  const merged: string[] = []
  const conflicts: ConflictRegion[] = []
  for (const region of regions) {
    if (region.ok) {
      merged.push(...region.ok)
      continue
    }
    const conflict = region.conflict
    if (!conflict) continue
    merged.push(...conflict.a)
    conflicts.push({
      baseRange: [conflict.oIndex + 1, conflict.oIndex + conflict.o.length + 1],
      localRange: [conflict.aIndex + 1, conflict.aIndex + conflict.a.length + 1],
      remoteRange: [conflict.bIndex + 1, conflict.bIndex + conflict.b.length + 1],
    })
  }

  let content = merged.join('\n')
  if (blocks.length > 0) content = restoreMarkerBlocks(content, blocks)
  if (localNormalized.crlf) content = content.replace(/\n/g, '\r\n')

  const status = conflicts.length > 0 ? 'conflicted' : content === localText ? 'unchanged' : 'clean'
  return { status, content, conflicts, format: { preserved: true, mode: 'verbatim' } }
}

/** Splits marker blocks out of a working copy. Unclosed, nested, or stray markers throw. */
export function extractMarkerBlocks(
  text: string,
  markerName = DEFAULT_MARKER_NAME,
): MarkerExtraction {
  const startMarker = markerLine(markerName, false)
  const endMarker = markerLine(markerName, true)
  const lines = text.split('\n')
  const kept: string[] = []
  const blocks: MarkerBlock[] = []
  let open: { start: string; body: string[] } | undefined

  for (const line of lines) {
    const normalized = normalizeMarkerLine(line)
    if (normalized === startMarker) {
      if (open) throw new Error(`nested ${markerName} marker block`)
      open = { start: normalized, body: [] }
      kept.push(line)
      continue
    }
    if (normalized === endMarker) {
      if (!open) throw new Error(`unmatched ${markerName} end marker`)
      blocks.push({ startMarker: open.start, endMarker: normalized, body: open.body })
      open = undefined
      kept.push(line)
      continue
    }
    if (open) open.body.push(line)
    else kept.push(line)
  }
  if (open) throw new Error(`unclosed ${markerName} marker block`)
  return { projection: kept.join('\n'), blocks }
}

/**
 * Puts local bodies back between their anchors. A block whose anchor the merge
 * removed is re-appended with its markers instead of being dropped.
 */
export function restoreMarkerBlocks(text: string, blocks: readonly MarkerBlock[]): string {
  let lines = text.split('\n')
  let cursor = 0
  const orphans: MarkerBlock[] = []

  for (const block of blocks) {
    const start = lines.findIndex(
      (line, index) => index >= cursor && normalizeMarkerLine(line) === block.startMarker,
    )
    const end =
      start === -1
        ? -1
        : lines.findIndex(
            (line, index) => index > start && normalizeMarkerLine(line) === block.endMarker,
          )
    if (start === -1 || end === -1) {
      orphans.push(block)
      continue
    }
    lines = [...lines.slice(0, start + 1), ...block.body, ...lines.slice(start + 1)]
    cursor = start + 1 + block.body.length
  }

  if (orphans.length > 0) {
    const insertAt = lines.at(-1) === '' ? lines.length - 1 : lines.length
    const restored = orphans.flatMap((block) => [block.startMarker, ...block.body, block.endMarker])
    lines = [...lines.slice(0, insertAt), ...restored, ...lines.slice(insertAt)]
  }
  return lines.join('\n')
}

/** Git-style unified diff, no index header. */
export function unifiedDiff(
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): string {
  const from = options.from ?? 'before'
  const to = options.to ?? 'after'
  const patch = structuredPatch(from, to, before, after, '', '', { context: options.context ?? 3 })
  if (patch.hunks.length === 0) return ''
  const lines = [`--- ${from}`, `+++ ${to}`]
  for (const hunk of patch.hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
    for (const line of hunk.lines) lines.push(line.replace(/\n$/, ''))
  }
  return `${lines.join('\n')}\n`
}

function markerLine(name: string, closing: boolean): string {
  return `<!-- ${closing ? '/' : ''}${name} -->`
}

function normalizeMarkerLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ')
}

/** CRLF is normalized for comparison and restored when the local file used it throughout. */
function normalizeEol(text: string): { text: string; crlf: boolean } {
  if (!text.includes('\r\n')) return { text, crlf: false }
  const bareLf = /(?<!\r)\n/.test(text)
  return { text: text.replace(/\r\n/g, '\n'), crlf: !bareLf }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
