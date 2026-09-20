/**
 * One live sync pass: pull, plan, apply, push, and record. The local files are
 * the durable source of truth while offline, so reconnecting simply runs the
 * same pass again instead of replaying stale serialized operations.
 */

import type { DeviceId, RevisionId, StoreId } from '@laurencio/protocol'
import type { ApplyHooks } from '../apply'
import { EnvelopeError } from '../crypto/aead'
import type { KeyMaterial } from '../crypto/kdf'
import {
  RemoteForkError,
  RemoteRollbackError,
  type SyncOptions,
  type SyncProgress,
  sync,
} from '../engine'
import type { DevicePolicy, SyncReport } from '../model'
import { defaultPolicy } from '../model'
import type { QuiescenceOptions } from '../quiescence'
import { HttpRemoteError, isOfflineError } from '../remote/http'
import type { Remote } from '../remote/types'
import { ManifestError, RemoteError } from '../remote/types'
import { LockHeldError, type SyncState } from '../state'
import type { AdapterContext, HarnessAdapter } from '../types'
import { activeAdapters } from './policy'

export const LAST_SYNC_META_KEY = 'last_sync'

export type SyncRunStatus = 'synced' | 'idle' | 'offline' | 'failed'

export interface SyncRunError {
  name: string
  message: string
  code: string | null
}

export interface SyncRunResult {
  status: SyncRunStatus
  /** Full report for this run, absent when the run never reached the engine. */
  report: SyncReport | null
  error: SyncRunError | null
  finishedAt: string
}

/** Compact form of a run, persisted for `status` and the daemon. */
export interface LastSyncRecord {
  at: string
  status: SyncRunStatus
  revisionId: RevisionId | null
  changed: number
  uploaded: number
  downloaded: number
  conflicts: string[]
  blocked: string[]
  deferred: string[]
  error: SyncRunError | null
}

export interface SyncLoopOptions {
  adapters: readonly HarnessAdapter[]
  ctx: AdapterContext
  deviceId: DeviceId
  storeId: StoreId
  key: KeyMaterial
  state: SyncState
  remote: Remote
  policy?: DevicePolicy
  quiescence?: QuiescenceOptions
  hooks?: ApplyHooks
  now?: () => Date
  createRevisionId?: () => RevisionId
  onProgress?: (progress: SyncProgress) => void
}

function describeError(error: unknown): SyncRunError {
  if (error instanceof Error) {
    const code =
      'code' in error && typeof (error as { code?: unknown }).code === 'string'
        ? (error as { code: string }).code
        : null
    return { name: error.name, message: error.message, code }
  }
  return { name: 'Error', message: String(error), code: null }
}

/** Errors the CLI can explain without a stack trace. */
function isKnownSyncError(error: unknown): boolean {
  return (
    error instanceof EnvelopeError ||
    error instanceof RemoteError ||
    error instanceof ManifestError ||
    error instanceof RemoteRollbackError ||
    error instanceof RemoteForkError ||
    error instanceof LockHeldError ||
    error instanceof HttpRemoteError
  )
}

function isIdle(report: SyncReport): boolean {
  return (
    report.changed.length === 0 &&
    report.uploaded === 0 &&
    report.downloaded === 0 &&
    report.conflicts.length === 0
  )
}

function recordLastSync(state: SyncState, result: SyncRunResult): LastSyncRecord {
  const report = result.report
  const record: LastSyncRecord = {
    at: result.finishedAt,
    status: result.status,
    revisionId: report?.revisionId ?? null,
    changed: report?.changed.length ?? 0,
    uploaded: report?.uploaded ?? 0,
    downloaded: report?.downloaded ?? 0,
    conflicts: report?.conflicts.map((conflict) => conflict.path) ?? [],
    blocked: report?.blocked ?? [],
    deferred: report?.deferred ?? [],
    error: result.error,
  }
  state.setMeta(LAST_SYNC_META_KEY, JSON.stringify(record))
  return record
}

export function readLastSync(state: SyncState): LastSyncRecord | null {
  const raw = state.getMeta(LAST_SYNC_META_KEY)
  if (raw === null) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.at !== 'string' || typeof record.status !== 'string') return null
    if (typeof record.changed !== 'number' || typeof record.uploaded !== 'number') return null
    if (typeof record.downloaded !== 'number') return null
    if (!Array.isArray(record.conflicts) || !Array.isArray(record.blocked)) return null
    if (!Array.isArray(record.deferred)) return null
    const errorRecord =
      typeof record.error === 'object' && record.error !== null
        ? (record.error as Record<string, unknown>)
        : null
    const status: SyncRunStatus =
      record.status === 'synced' ||
      record.status === 'idle' ||
      record.status === 'offline' ||
      record.status === 'failed'
        ? record.status
        : 'failed'
    return {
      at: record.at,
      status,
      revisionId: typeof record.revisionId === 'string' ? (record.revisionId as RevisionId) : null,
      changed: record.changed,
      uploaded: record.uploaded,
      downloaded: record.downloaded,
      conflicts: record.conflicts.filter((item): item is string => typeof item === 'string'),
      blocked: record.blocked.filter((item): item is string => typeof item === 'string'),
      deferred: record.deferred.filter((item): item is string => typeof item === 'string'),
      error:
        errorRecord !== null &&
        typeof errorRecord.name === 'string' &&
        typeof errorRecord.message === 'string'
          ? {
              name: errorRecord.name,
              message: errorRecord.message,
              code: typeof errorRecord.code === 'string' ? errorRecord.code : null,
            }
          : null,
    }
  } catch {
    return null
  }
}

export class SyncLoop {
  readonly options: SyncLoopOptions

  constructor(options: SyncLoopOptions) {
    this.options = options
  }

  get policy(): DevicePolicy {
    return this.options.policy ?? defaultPolicy()
  }

  async runOnce(): Promise<SyncRunResult> {
    const now = this.options.now ?? (() => new Date())
    const state = this.options.state

    let report: SyncReport
    try {
      const syncOptions: SyncOptions = {
        adapters: activeAdapters(this.options.adapters, this.policy),
        ctx: this.options.ctx,
        deviceId: this.options.deviceId,
        storeId: this.options.storeId,
        key: this.options.key,
        state,
        remote: this.options.remote,
        policy: this.policy,
        ...(this.options.onProgress === undefined ? {} : { onProgress: this.options.onProgress }),
        ...(this.options.quiescence !== undefined ? { quiescence: this.options.quiescence } : {}),
        ...(this.options.hooks !== undefined ? { hooks: this.options.hooks } : {}),
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
        ...(this.options.createRevisionId !== undefined
          ? { createRevisionId: this.options.createRevisionId }
          : {}),
      }
      report = await sync(syncOptions)
    } catch (error) {
      const finishedAt = now().toISOString()
      if (isOfflineError(error)) {
        const result: SyncRunResult = {
          status: 'offline',
          report: null,
          error: describeError(error),
          finishedAt,
        }
        recordLastSync(state, result)
        return result
      }
      if (!isKnownSyncError(error)) throw error
      const result: SyncRunResult = {
        status: 'failed',
        report: null,
        error: describeError(error),
        finishedAt,
      }
      recordLastSync(state, result)
      return result
    }

    const result: SyncRunResult = {
      status: isIdle(report) ? 'idle' : 'synced',
      report,
      error: null,
      finishedAt: now().toISOString(),
    }
    recordLastSync(state, result)
    return result
  }
}

/** True when follow-up configuration work can safely build on this pass. */
export function isCleanSyncResult(result: SyncRunResult): boolean {
  if (result.status !== 'synced' && result.status !== 'idle') return false
  const report = result.report
  return (
    report !== null &&
    report.conflicts.length === 0 &&
    report.blocked.length === 0 &&
    report.deferred.length === 0
  )
}
