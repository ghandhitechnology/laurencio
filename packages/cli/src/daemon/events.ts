/**
 * Harness hook integration point. Defined in v1, not wired.
 *
 * How it would plug in: Claude Code, Codex, and OpenCode all run configured
 * shell commands on session start and stop. The install step would add
 * `laurencio daemon event session-start|session-stop` to each harness's hook
 * settings; that command appends one JSON line to `~/.laurencio/daemon.events`,
 * and the running daemon watches that file and calls `runtime.wake()` so a
 * session boundary syncs without waiting out the interval. The daemon contract
 * stays "wake", never "sync now": coalescing and quiescence live in one place.
 *
 * Until then, the watcher plus the cadence interval cover the same ground with
 * one fewer moving part.
 */

import type { HarnessId } from '@laurencio/core'

export type HarnessEventKind = 'session-start' | 'session-stop'

export interface HarnessEvent {
  harness: HarnessId
  kind: HarnessEventKind
  at: string
  sessionId: string | null
}

function isHarnessId(value: unknown): value is HarnessId {
  return value === 'claude' || value === 'codex' || value === 'opencode'
}

export function parseHarnessEvent(value: unknown): HarnessEvent | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (!isHarnessId(record.harness)) return null
  if (record.kind !== 'session-start' && record.kind !== 'session-stop') return null
  if (typeof record.at !== 'string') return null
  return {
    harness: record.harness,
    kind: record.kind,
    at: record.at,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
  }
}

/** A finished session is the useful moment to sync; a start is not. */
export function eventWakesSync(event: HarnessEvent): boolean {
  return event.kind === 'session-stop'
}
