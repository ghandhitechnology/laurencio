import { createHash } from 'node:crypto'
import type { MarkerRange } from './model'

export type MarkerErrorCode = 'unclosed' | 'nested' | 'orphan-close'

export class MarkerError extends Error {
  readonly code: MarkerErrorCode
  readonly path: string
  readonly line: number

  constructor(code: MarkerErrorCode, path: string, line: number) {
    super(`${code} marker block at ${path}:${line}`)
    this.name = 'MarkerError'
    this.code = code
    this.path = path
    this.line = line
  }
}

export interface LocalBlock {
  range: MarkerRange
  /** Lines between the markers, joined with newlines. Never uploaded. */
  content: string
}

const openPattern = /^[ \t]*<!--\s*laurencio:local\s*-->[ \t]*\r?$/
const closePattern = /^[ \t]*<!--\s*\/\s*laurencio:local\s*-->[ \t]*\r?$/

function sha256Hex(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

function splitLines(text: string): string[] {
  return text.split('\n')
}

/** Parse every `<!-- laurencio:local -->` block. Unclosed, nested, or orphan markers throw. */
export function parseLocalBlocks(filePath: string, text: string): LocalBlock[] {
  const lines = splitLines(text)
  const blocks: LocalBlock[] = []
  let open = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (openPattern.test(line)) {
      if (open !== -1) throw new MarkerError('nested', filePath, index + 1)
      open = index
      continue
    }
    if (!closePattern.test(line)) continue
    if (open === -1) throw new MarkerError('orphan-close', filePath, index + 1)
    const content = lines.slice(open + 1, index).join('\n')
    blocks.push({
      range: {
        path: filePath,
        startLine: open + 1,
        endLine: index + 1,
        contentHash: sha256Hex(content),
      },
      content,
    })
    open = -1
  }
  if (open !== -1) throw new MarkerError('unclosed', filePath, open + 1)
  return blocks
}

export function markerRanges(blocks: readonly LocalBlock[]): MarkerRange[] {
  return blocks.map((block) => block.range)
}

/** Upload projection: local content leaves, markers stay as anchors. */
export function stripLocalBlocks(filePath: string, text: string): string {
  const blocks = parseLocalBlocks(filePath, text)
  if (blocks.length === 0) return text
  const lines = splitLines(text)
  const dropped = new Set<number>()
  for (const block of blocks) {
    for (let line = block.range.startLine + 1; line < block.range.endLine; line += 1) {
      dropped.add(line)
    }
  }
  return lines.filter((_, index) => !dropped.has(index + 1)).join('\n')
}

/**
 * Apply projection: put local content back at its markers, matched by order. A projection
 * damaged by a remote edit (anchor deleted) still receives its block, at the end instead of
 * at the missing anchor; a missing close marker is restored after the inserted content.
 */
export function reinsertLocalBlocks(projection: string, blocks: readonly LocalBlock[]): string {
  if (blocks.length === 0) return projection
  const lines = splitLines(projection)
  const anchors: { open: number; close: number }[] = []
  let open = -1
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (openPattern.test(line)) {
      open = index
      continue
    }
    if (!closePattern.test(line)) continue
    if (open === -1) continue
    anchors.push({ open, close: index })
    open = -1
  }
  if (open !== -1) anchors.push({ open, close: -1 })
  const paired = anchors.slice(0, blocks.length)

  const output: string[] = []
  let anchorIndex = 0
  for (let index = 0; index < lines.length; index += 1) {
    const anchor = paired[anchorIndex]
    const block = blocks[anchorIndex]
    if (anchor !== undefined && block !== undefined) {
      if (anchor.close === -1 && index === anchor.open) {
        output.push(lines[index] ?? '')
        if (block.content !== '') output.push(...block.content.split('\n'))
        output.push('<!-- /laurencio:local -->')
        anchorIndex += 1
        continue
      }
      if (anchor.close === index) {
        if (block.content !== '') output.push(...block.content.split('\n'))
        anchorIndex += 1
      }
    }
    output.push(lines[index] ?? '')
  }

  const leftovers = blocks.slice(paired.length)
  if (leftovers.length > 0) {
    const trailingNewline = output[output.length - 1] === ''
    if (trailingNewline) output.pop()
    for (const block of leftovers) {
      if (output.length > 0 && output[output.length - 1] !== '') output.push('')
      output.push('<!-- laurencio:local -->')
      if (block.content !== '') output.push(...block.content.split('\n'))
      output.push('<!-- /laurencio:local -->')
    }
    if (trailingNewline) output.push('')
  }
  return output.join('\n')
}
