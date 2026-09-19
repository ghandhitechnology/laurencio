/**
 * Daemon state persisted in `state.db` under one meta key, so `laurencio
 * status` and `laurencio daemon status` read the same record the running
 * daemon writes. A missing or malformed record means "never ran", never a
 * crash.
 */

import type { SyncRunStatus, SyncState } from '@laurencio/core'

const DAEMON_STATE_META_KEY = 'daemon_state'

export interface DaemonState {
  pid: number
  startedAt: string
  paused: boolean
  lastSync: string | null
  lastResult: SyncRunStatus | null
}

function isRunStatus(value: unknown): value is SyncRunStatus {
  return value === 'synced' || value === 'idle' || value === 'offline' || value === 'failed'
}

export function readDaemonState(state: SyncState): DaemonState | null {
  const raw = state.getMeta(DAEMON_STATE_META_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || typeof record.startedAt !== 'string') return null
    if (typeof record.paused !== 'boolean') return null
    return {
      pid: record.pid,
      startedAt: record.startedAt,
      paused: record.paused,
      lastSync: typeof record.lastSync === 'string' ? record.lastSync : null,
      lastResult: isRunStatus(record.lastResult) ? record.lastResult : null,
    }
  } catch {
    return null
  }
}

export function writeDaemonState(state: SyncState, value: DaemonState): void {
  state.setMeta(DAEMON_STATE_META_KEY, JSON.stringify(value))
}
