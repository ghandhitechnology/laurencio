/**
 * The deferral rule around live harness writers. A file may only be replaced
 * when its mtime is older than the window and it has not changed between the
 * plan read and the apply read. Anything else is deferred and re-queued so a
 * harness mid-write is never clobbered.
 */

export const DEFAULT_QUIESCENCE_WINDOW_MS = 1500

export type QuiescenceVerdict = 'quiescent' | 'deferred' | 'pending'

export interface QuiescenceOptions {
  /** A file younger than this is never applied. Zero disables deferral. */
  windowMs?: number
  now?: () => number
}

/** Pure rule: old enough to be safe to replace. */
export function isQuiescent(mtimeMs: number, nowMs: number, windowMs: number): boolean {
  return nowMs - mtimeMs >= windowMs
}

/**
 * Tracks the first read of each path for one run. The engine observes at plan
 * time and again at apply time; only the second read on an unchanged, old
 * enough file is quiescent.
 */
export class QuiescenceGate {
  readonly windowMs: number
  #now: () => number
  #seen: Map<string, number>

  constructor(options: QuiescenceOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_QUIESCENCE_WINDOW_MS
    this.#now = options.now ?? (() => Date.now())
    this.#seen = new Map()
  }

  observe(filePath: string, mtimeMs: number): QuiescenceVerdict {
    const now = this.#now()
    const previous = this.#seen.get(filePath)
    this.#seen.set(filePath, mtimeMs)
    if (previous === undefined) return 'pending'
    if (previous !== mtimeMs) return 'pending'
    return isQuiescent(mtimeMs, now, this.windowMs) ? 'quiescent' : 'deferred'
  }

  /** Records a first reading without deciding, for files seen during planning. */
  prime(filePath: string, mtimeMs: number): void {
    if (!this.#seen.has(filePath)) this.#seen.set(filePath, mtimeMs)
  }

  forget(filePath: string): void {
    this.#seen.delete(filePath)
  }
}
