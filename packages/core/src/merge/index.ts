import type { FormatReport, MergeResult } from '../model'
import type { MergeStrategy } from '../types'
import { mergeJsonc } from './jsonMerge'
import { mergeText3Way } from './text3way'
import { mergeToml } from './tomlMerge'

export * from './conflict'
export * from './jsonMerge'
export * from './text3way'
export * from './tomlMerge'
export * from './treeMerge'

export interface MergeRequest {
  strategy: MergeStrategy
  base: string
  local: string
  remote: string
  /** ISO timestamps for `binaryNewestWins`; required there, ignored elsewhere. */
  localTimestamp?: string
  remoteTimestamp?: string
}

export interface MergeOptions {
  /** Dot-joined key paths whose arrays merge by union. */
  unionArrays?: readonly string[]
  /** TOML only: allow canonical re-serialization when the line patcher cannot apply. */
  allowReserialize?: boolean
  /** Text only: strip local marker blocks before merging and re-insert them after. */
  markerBlocks?: boolean
  markerName?: string
}

export interface MergeOutcome extends MergeResult {
  format: FormatReport
}

/** Dispatch on the surface's declared strategy. Never loses an edit silently. */
export function merge(request: MergeRequest, options: MergeOptions = {}): MergeOutcome {
  switch (request.strategy) {
    case 'text3way': {
      const result = mergeText3Way(request.base, request.local, request.remote, {
        ...(options.markerBlocks !== undefined ? { markerBlocks: options.markerBlocks } : {}),
        ...(options.markerName !== undefined ? { markerName: options.markerName } : {}),
      })
      return result
    }
    case 'jsonKeyMerge':
      return mergeJsonc(request.base, request.local, request.remote, {
        ...(options.unionArrays !== undefined ? { unionArrays: options.unionArrays } : {}),
      })
    case 'tomlKeyMerge':
      return mergeToml(request.base, request.local, request.remote, {
        ...(options.unionArrays !== undefined ? { unionArrays: options.unionArrays } : {}),
        ...(options.allowReserialize !== undefined
          ? { allowReserialize: options.allowReserialize }
          : {}),
      })
    case 'appendUnion':
      return mergeAppendUnion(request.base, request.local, request.remote)
    case 'binaryNewestWins':
      return mergeNewestWins(request)
    case 'none':
      return {
        status: request.local === request.base ? 'unchanged' : 'clean',
        content: request.local,
        conflicts: [],
        format: { preserved: true, mode: 'verbatim' },
      }
  }
}

/**
 * Union merge for append-only text: base order, then local additions, then
 * remote additions. A side that drops base lines makes the merge conflicted.
 */
export function mergeAppendUnion(
  baseText: string,
  localText: string,
  remoteText: string,
): MergeOutcome {
  const base = splitLines(baseText)
  const local = splitLines(localText)
  const remote = splitLines(remoteText)
  const localAdded = local.lines.filter((line) => !base.lines.includes(line))
  const remoteAdded = remote.lines.filter(
    (line) => !base.lines.includes(line) && !localAdded.includes(line),
  )
  const lines = [...base.lines, ...localAdded, ...remoteAdded]
  const content = lines.join('\n') + (base.trailingNewline ? '\n' : '')

  const localRemoved = base.lines.filter((line) => !local.lines.includes(line))
  const remoteRemoved = base.lines.filter((line) => !remote.lines.includes(line))
  if (localRemoved.length > 0 || remoteRemoved.length > 0) {
    return {
      status: 'conflicted',
      content,
      conflicts: [],
      format: {
        preserved: true,
        mode: 'verbatim',
        reason: 'append-only union saw a deletion',
      },
    }
  }
  return {
    status: content === localText ? 'unchanged' : 'clean',
    content,
    conflicts: [],
    format: { preserved: true, mode: 'verbatim' },
  }
}

function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  const lines = text.split('\n')
  const trailingNewline = lines.length > 1 && lines.at(-1) === ''
  if (trailingNewline) lines.pop()
  return { lines, trailingNewline }
}

function mergeNewestWins(request: MergeRequest): MergeOutcome {
  const { base, local, remote, localTimestamp, remoteTimestamp } = request
  if (local === remote) {
    return {
      status: local === base ? 'unchanged' : 'clean',
      content: local,
      conflicts: [],
      format: { preserved: true, mode: 'verbatim' },
    }
  }
  if (local === base) {
    return {
      status: 'clean',
      content: remote,
      conflicts: [],
      format: { preserved: true, mode: 'verbatim' },
    }
  }
  if (remote === base) {
    return {
      status: 'clean',
      content: local,
      conflicts: [],
      format: { preserved: true, mode: 'verbatim' },
    }
  }
  const localTime = timestampMs(localTimestamp)
  const remoteTime = timestampMs(remoteTimestamp)
  if (localTime !== undefined && remoteTime !== undefined && localTime !== remoteTime) {
    return {
      status: 'clean',
      content: remoteTime > localTime ? remote : local,
      conflicts: [],
      format: { preserved: true, mode: 'verbatim' },
    }
  }
  // Same instant or no timestamps: newest-wins cannot decide, so surface it.
  return {
    status: 'conflicted',
    content: local,
    conflicts: [],
    format: {
      preserved: true,
      mode: 'verbatim',
      reason: 'both sides changed with no ordering evidence',
    },
  }
}

function timestampMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
