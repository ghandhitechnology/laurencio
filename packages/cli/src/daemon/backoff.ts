/**
 * Exponential backoff for failed daemon runs. One failure is not a reason to
 * stop trying, and a server that stays down for hours must not be hammered.
 * The wait doubles per consecutive failure and stops at a ceiling.
 */

import type { SyncRunStatus } from '@laurencio/core'

export const DEFAULT_BACKOFF_BASE_MS = 5_000
export const DEFAULT_BACKOFF_MAX_MS = 10 * 60_000

export interface BackoffOptions {
  baseMs?: number
  maxMs?: number
}

/** Wait before retry number `attempt` (1 is the first retry after a failure). */
export function nextBackoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS
  const safeAttempt = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1
  // Cap the exponent before the shift so a long outage cannot overflow.
  const doublings = Math.min(safeAttempt - 1, 32)
  return Math.min(base * 2 ** doublings, max)
}

export function shouldBackoff(status: SyncRunStatus): boolean {
  return status === 'failed' || status === 'offline'
}
