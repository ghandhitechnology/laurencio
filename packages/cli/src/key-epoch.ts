/**
 * Local key-epoch bookkeeping. The cached master key belongs to one KDF
 * generation, and the state database records which, so `doctor` can tell a
 * device whose key lags the store. A rotation that committed but could not
 * publish leaves a pending record here for `laurencio rotate --resume`.
 */

import { crypto, type SyncState } from '@laurencio/core'
import { RevisionId } from '@laurencio/protocol'

export const KEY_EPOCH_META_KEY = 'key_epoch'
export const PENDING_ROTATION_META_KEY = 'rotation_pending_publish'

export interface KeyEpochRecord {
  epoch: number
  /** Hex salt of the KDF parameters this epoch's key was derived from. */
  salt: string
  createdAt: string
}

export interface PendingRotation {
  epoch: number
  /** Generation the parameters must publish at. */
  generation: number
  /** Store generation read before the rotation; the compare-and-set input. */
  expectedGeneration: number
  revisionId: RevisionId
  kdf: crypto.KdfParams
  createdAt: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readJsonMeta(state: SyncState, key: string): Record<string, unknown> | null {
  const raw = state.getMeta(key)
  if (raw === null || raw === '') return null
  try {
    return asRecord(JSON.parse(raw))
  } catch {
    return null
  }
}

export function readKeyEpoch(state: SyncState): KeyEpochRecord | null {
  const record = readJsonMeta(state, KEY_EPOCH_META_KEY)
  if (record === null) return null
  if (typeof record.epoch !== 'number' || !Number.isInteger(record.epoch) || record.epoch < 1) {
    return null
  }
  if (typeof record.salt !== 'string' || typeof record.createdAt !== 'string') return null
  return { epoch: record.epoch, salt: record.salt, createdAt: record.createdAt }
}

export function writeKeyEpoch(state: SyncState, record: KeyEpochRecord): void {
  state.setMeta(KEY_EPOCH_META_KEY, JSON.stringify(record))
}

export function readPendingRotation(state: SyncState): PendingRotation | null {
  const record = readJsonMeta(state, PENDING_ROTATION_META_KEY)
  if (record === null) return null
  const revision = RevisionId.safeParse(record.revisionId)
  if (!revision.success) return null
  if (typeof record.epoch !== 'number' || !Number.isInteger(record.epoch)) return null
  if (typeof record.generation !== 'number' || !Number.isInteger(record.generation)) return null
  if (typeof record.expectedGeneration !== 'number') return null
  if (typeof record.createdAt !== 'string') return null
  let kdf: crypto.KdfParams
  try {
    kdf = crypto.parseKdfParams(record.kdf)
  } catch {
    return null
  }
  return {
    epoch: record.epoch,
    generation: record.generation,
    expectedGeneration: record.expectedGeneration,
    revisionId: revision.data,
    kdf,
    createdAt: record.createdAt,
  }
}

export function writePendingRotation(state: SyncState, pending: PendingRotation): void {
  state.setMeta(PENDING_ROTATION_META_KEY, JSON.stringify(pending))
}

export function clearPendingRotation(state: SyncState): void {
  state.removeMeta(PENDING_ROTATION_META_KEY)
}
