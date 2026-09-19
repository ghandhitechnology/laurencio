/**
 * Local sync state: revisions the device has seen, the base manifest used for
 * three-way merges, layouts, marker blocks, the pending-op queue, and the write
 * journal. SQLite at `~/.laurencio/state.db`, one file per device.
 *
 * The journal is the crash-safety contract: every filesystem write is preceded
 * by an intent row, and startup reconciliation adopts a write that landed or
 * rolls back the one that did not.
 */

import { Database } from 'bun:sqlite'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { BlobId, BlobRef, DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import type { LocalBlock } from './markers'
import type { LocalLayout, Manifest, ManifestEntry, SurfaceDigest } from './model'
import { LAURENCIO_DIR } from './secrets/scan'

export const STATE_DB_NAME = 'state.db'
export const LOCK_FILE_NAME = 'state.lock'

export function laurencioDir(home: string): string {
  return path.join(home, LAURENCIO_DIR)
}

export function stateDbPath(home: string): string {
  return path.join(laurencioDir(home), STATE_DB_NAME)
}

export function lockFilePath(home: string): string {
  return path.join(laurencioDir(home), LOCK_FILE_NAME)
}

export interface LockInfo {
  pid: number
  /** Process start time, not the lock write time, so a reused PID is detectable. */
  startedAt: string
}

export class LockHeldError extends Error {
  readonly holder: LockInfo

  constructor(filePath: string, holder: LockInfo) {
    super(`sync lock held by pid ${holder.pid} since ${holder.startedAt} (${filePath})`)
    this.name = 'LockHeldError'
    this.holder = holder
  }
}

function readLock(filePath: string): LockInfo | null {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pid !== 'number' || typeof record.startedAt !== 'string') return null
    return { pid: record.pid, startedAt: record.startedAt }
  } catch {
    return null
  }
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user; treat as alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function truncateToSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString()
}

/** Queries the process start time, the evidence that a live PID is not a reuse. */
export function processStartTime(pid: number): string | null {
  try {
    const raw = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' })
    const parsed = Date.parse(raw.trim())
    if (!Number.isNaN(parsed)) return truncateToSecond(parsed)
  } catch {
    // Fall through to the arithmetic form; ps is absent on some minimal hosts.
  }
  if (pid !== process.pid) return null
  return truncateToSecond(Date.now() - process.uptime() * 1000)
}

function matchesHolderStart(
  holder: LockInfo,
  processStart: (pid: number) => string | null,
): boolean {
  const actual = processStart(holder.pid)
  // A probe that cannot read a start time leaves the lock held: never steal on doubt.
  return actual === null || actual === holder.startedAt
}

function isStaleLock(
  holder: LockInfo,
  isAlive: (pid: number) => boolean,
  processStart: (pid: number) => string | null,
): boolean {
  return !isAlive(holder.pid) || !matchesHolderStart(holder, processStart)
}

/**
 * Removes a lock whose process is gone or whose PID was reused by a different
 * process, the state a kill -9 during an apply leaves behind. Returns the
 * removed lock, or null when the lock is live.
 */
export function clearStaleLock(
  home: string,
  isAlive: (pid: number) => boolean = defaultIsAlive,
  processStart: (pid: number) => string | null = processStartTime,
): LockInfo | null {
  const filePath = lockFilePath(home)
  const holder = readLock(filePath)
  if (holder === null) return null
  if (!isStaleLock(holder, isAlive, processStart)) return null
  fs.rmSync(filePath, { force: true })
  return holder
}

export interface AcquireLockOptions {
  isAlive?: (pid: number) => boolean
  processStart?: (pid: number) => string | null
  pid?: number
  /** Overrides the recorded start time; tests use it with a matching probe. */
  startedAt?: string
}

/**
 * Takes the device-wide sync lock. Creation is atomic (`O_EXCL`), so two
 * racing processes cannot both win; a lock whose owner is dead or whose PID
 * was reused by a new process is replaced.
 */
export function acquireLock(home: string, options: AcquireLockOptions = {}): LockInfo {
  const filePath = lockFilePath(home)
  const isAlive = options.isAlive ?? defaultIsAlive
  const processStart = options.processStart ?? processStartTime
  const pid = options.pid ?? process.pid
  const startedAt = options.startedAt ?? processStart(pid) ?? truncateToSecond(Date.now())
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  for (;;) {
    const holder: LockInfo = { pid, startedAt }
    try {
      const fd = fs.openSync(filePath, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, JSON.stringify(holder))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      return holder
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const existing = readLock(filePath)
    if (existing === null) {
      // An empty or malformed file can be a create that has not written yet.
      const age = Date.now() - fs.statSync(filePath).mtimeMs
      if (age < 1000) throw new LockHeldError(filePath, { pid: 0, startedAt: 'unknown' })
      fs.rmSync(filePath, { force: true })
      continue
    }
    if (!isStaleLock(existing, isAlive, processStart)) throw new LockHeldError(filePath, existing)
    fs.rmSync(filePath, { force: true })
  }
}

/** Releases the lock only when this process still owns it. */
export function releaseLock(home: string, pid: number = process.pid, holder?: LockInfo): void {
  const filePath = lockFilePath(home)
  const existing = readLock(filePath)
  if (existing === null) return
  if (holder !== undefined) {
    if (existing.pid !== holder.pid || existing.startedAt !== holder.startedAt) return
  } else if (existing.pid !== pid) {
    return
  }
  fs.rmSync(filePath, { force: true })
}

export interface RevisionRecord {
  id: RevisionId
  deviceId: DeviceId
  parents: RevisionId[]
  createdAt: string
  manifest: BlobRef
  digest: SurfaceDigest[]
  role: 'base' | 'local' | 'remote'
}

export type JournalOp = 'write' | 'delete' | 'link' | 'mkdir'
export type JournalState = 'intent' | 'applied'

export interface JournalRow {
  opId: string
  op: JournalOp
  targetPath: string
  state: JournalState
  tempPath: string | null
  resultHash: string | null
  startedAt: string
}

export interface PendingOp {
  opId: string
  kind: string
  payload: string
  createdAt: string
}

export interface ReconcileReport {
  adopted: string[]
  rolledBack: string[]
  cleared: string[]
  staleLockRemoved: LockInfo | null
}

export interface SyncStateOptions {
  /** Explicit database path, for tests. Defaults to `<home>/.laurencio/state.db`. */
  path?: string
  home?: string
  now?: () => Date
}

interface RevisionRow {
  revision_id: string
  device_id: string
  parents: string
  created_at: string
  manifest_blob_id: string
  manifest_size: number
  digest: string
  role: string
}

interface ManifestRow {
  surface_id: string
  path: string
  kind: string
  hash: string
  size: number
  mode: number
  blob_id: string | null
  blob_size: number | null
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function hashFile(filePath: string): string | null {
  try {
    return sha256Hex(fs.readFileSync(filePath))
  } catch {
    return null
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

function compareEntries(a: ManifestEntry, b: ManifestEntry): number {
  return a.surfaceId.localeCompare(b.surfaceId) || a.path.localeCompare(b.path)
}

export class SyncState {
  readonly path: string
  #db: Database

  private constructor(db: Database, dbPath: string) {
    this.#db = db
    this.path = dbPath
    this.#migrate()
  }

  static open(options: SyncStateOptions = {}): SyncState {
    const dbPath = options.path ?? stateDbPath(options.home ?? process.env.HOME ?? process.cwd())
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 })
    return new SyncState(new Database(dbPath, { create: true }), dbPath)
  }

  #migrate(): void {
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS revisions (
        revision_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        parents TEXT NOT NULL,
        created_at TEXT NOT NULL,
        manifest_blob_id TEXT NOT NULL,
        manifest_size INTEGER NOT NULL,
        digest TEXT NOT NULL,
        role TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS base_manifest (
        revision_id TEXT NOT NULL,
        surface_id TEXT NOT NULL,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mode INTEGER NOT NULL,
        blob_id TEXT,
        blob_size INTEGER,
        PRIMARY KEY (revision_id, path)
      );
      CREATE TABLE IF NOT EXISTS layouts (
        device_id TEXT PRIMARY KEY,
        entries TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS markers (
        path TEXT PRIMARY KEY,
        blocks TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_ops (
        op_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal (
        op_id TEXT PRIMARY KEY,
        op TEXT NOT NULL,
        target_path TEXT NOT NULL,
        state TEXT NOT NULL,
        temp_path TEXT,
        result_hash TEXT,
        started_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  close(): void {
    this.#db.close()
  }

  putRevision(record: RevisionRecord): void {
    this.#db
      .query(
        `INSERT INTO revisions (revision_id, device_id, parents, created_at, manifest_blob_id, manifest_size, digest, role)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(revision_id) DO UPDATE SET role = excluded.role`,
      )
      .run(
        record.id,
        record.deviceId,
        JSON.stringify(record.parents),
        record.createdAt,
        record.manifest.id,
        record.manifest.size,
        JSON.stringify(record.digest),
        record.role,
      )
  }

  getRevision(revisionId: RevisionId): RevisionRecord | null {
    const row = this.#db
      .query<RevisionRow, [string]>('SELECT * FROM revisions WHERE revision_id = ?')
      .get(revisionId)
    if (row === null) return null
    return {
      id: row.revision_id as RevisionId,
      deviceId: row.device_id as DeviceId,
      parents: parseStringArray(row.parents) as RevisionId[],
      createdAt: row.created_at,
      manifest: { id: row.manifest_blob_id as BlobId, size: row.manifest_size },
      digest: this.#parseDigest(row.digest),
      role: row.role === 'base' ? 'base' : row.role === 'local' ? 'local' : 'remote',
    }
  }

  #parseDigest(raw: string): SurfaceDigest[] {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (item): item is SurfaceDigest =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as SurfaceDigest).surfaceId === 'string' &&
          typeof (item as SurfaceDigest).files === 'number' &&
          typeof (item as SurfaceDigest).bytes === 'number',
      )
    } catch {
      return []
    }
  }

  setBaseRevision(revisionId: RevisionId): void {
    this.#db
      .query(
        `INSERT INTO meta (key, value) VALUES ('base_revision', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(revisionId)
    this.#db.query("UPDATE revisions SET role = 'local' WHERE role = 'base'").run()
    this.#db.query("UPDATE revisions SET role = 'base' WHERE revision_id = ?").run(revisionId)
  }

  getBaseRevision(): RevisionId | null {
    const row = this.#db
      .query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'base_revision'")
      .get()
    return row === null ? null : (row.value as RevisionId)
  }

  getMeta(key: string): string | null {
    const row = this.#db
      .query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
      .get(key)
    return row === null ? null : row.value
  }

  setMeta(key: string, value: string): void {
    this.#db
      .query(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  }

  /** Stores a revision and replaces its manifest rows in one transaction. */
  saveManifest(record: RevisionRecord, entries: ManifestEntry[]): void {
    this.#db.run('BEGIN')
    try {
      this.putRevision(record)
      this.#db.query('DELETE FROM base_manifest WHERE revision_id = ?').run(record.id)
      const insert = this.#db.query(
        `INSERT INTO base_manifest (revision_id, surface_id, path, kind, hash, size, mode, blob_id, blob_size)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      for (const entry of entries) {
        insert.run(
          record.id,
          entry.surfaceId,
          entry.path,
          entry.kind,
          entry.hash,
          entry.size,
          entry.mode,
          entry.blob?.id ?? null,
          entry.blob?.size ?? null,
        )
      }
      this.#db.run('COMMIT')
    } catch (error) {
      this.#db.run('ROLLBACK')
      throw error
    }
  }

  getManifest(revisionId: RevisionId): Manifest | null {
    const revision = this.getRevision(revisionId)
    if (revision === null) return null
    const rows = this.#db
      .query<ManifestRow, [string]>(
        'SELECT surface_id, path, kind, hash, size, mode, blob_id, blob_size FROM base_manifest WHERE revision_id = ? ORDER BY surface_id, path',
      )
      .all(revisionId)
    const entries: ManifestEntry[] = rows.map((row) => {
      const entry: ManifestEntry = {
        surfaceId: row.surface_id as SurfaceId,
        path: row.path,
        kind: row.kind === 'tombstone' ? 'tombstone' : 'file',
        hash: row.hash,
        size: row.size,
        mode: row.mode,
      }
      if (row.blob_id !== null && row.blob_size !== null) {
        entry.blob = { id: row.blob_id as BlobId, size: row.blob_size }
      }
      return entry
    })
    return {
      revisionId: revision.id,
      deviceId: revision.deviceId,
      createdAt: revision.createdAt,
      entries: entries.sort(compareEntries),
    }
  }

  /** Records a local deletion so the next plan uploads a tombstone. */
  recordTombstone(revisionId: RevisionId, surfaceId: SurfaceId, storePath: string): void {
    const existing = this.getManifest(revisionId)
    if (existing === null) return
    const entries = existing.entries.filter((entry) => entry.path !== storePath)
    entries.push({
      surfaceId,
      path: storePath,
      kind: 'tombstone',
      hash: '',
      size: 0,
      mode: 0,
    })
    this.saveManifest(
      { ...this.#requireRevision(revisionId), role: 'base' },
      entries.sort(compareEntries),
    )
  }

  #requireRevision(revisionId: RevisionId): RevisionRecord {
    const revision = this.getRevision(revisionId)
    if (revision === null) throw new Error(`unknown revision: ${revisionId}`)
    return revision
  }

  saveLayout(layout: LocalLayout): void {
    this.#db
      .query(
        `INSERT INTO layouts (device_id, entries) VALUES (?, ?)
         ON CONFLICT(device_id) DO UPDATE SET entries = excluded.entries`,
      )
      .run(layout.deviceId, JSON.stringify(layout.entries))
  }

  getLayout(deviceId: DeviceId): LocalLayout | null {
    const row = this.#db
      .query<{ entries: string }, [string]>('SELECT entries FROM layouts WHERE device_id = ?')
      .get(deviceId)
    if (row === null) return null
    try {
      const parsed: unknown = JSON.parse(row.entries)
      if (!Array.isArray(parsed)) return null
      const entries = parsed.filter(
        (entry): entry is LocalLayout['entries'][number] =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof (entry as LocalLayout['entries'][number]).path === 'string' &&
          ((entry as LocalLayout['entries'][number]).mode === 'direct' ||
            (entry as LocalLayout['entries'][number]).mode === 'symlink'),
      )
      return { deviceId, entries }
    } catch {
      return null
    }
  }

  saveMarkers(filePath: string, blocks: readonly LocalBlock[]): void {
    if (blocks.length === 0) {
      this.clearMarkers(filePath)
      return
    }
    this.#db
      .query(
        `INSERT INTO markers (path, blocks) VALUES (?, ?)
         ON CONFLICT(path) DO UPDATE SET blocks = excluded.blocks`,
      )
      .run(filePath, JSON.stringify(blocks))
  }

  getMarkers(filePath: string): LocalBlock[] {
    const row = this.#db
      .query<{ blocks: string }, [string]>('SELECT blocks FROM markers WHERE path = ?')
      .get(filePath)
    if (row === null) return []
    try {
      const parsed: unknown = JSON.parse(row.blocks)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (block): block is LocalBlock =>
          typeof block === 'object' &&
          block !== null &&
          typeof (block as LocalBlock).content === 'string' &&
          typeof (block as LocalBlock).range === 'object' &&
          (block as LocalBlock).range !== null,
      )
    } catch {
      return []
    }
  }

  clearMarkers(filePath: string): void {
    this.#db.query('DELETE FROM markers WHERE path = ?').run(filePath)
  }

  enqueueOp(op: { kind: string; payload: string; createdAt: string }): string {
    const opId = `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
    this.#db
      .query('INSERT INTO pending_ops (op_id, kind, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(opId, op.kind, op.payload, op.createdAt)
    return opId
  }

  listPendingOps(): PendingOp[] {
    return this.#db
      .query<{ op_id: string; kind: string; payload: string; created_at: string }, []>(
        'SELECT op_id, kind, payload, created_at FROM pending_ops ORDER BY created_at, op_id',
      )
      .all()
      .map((row) => ({
        opId: row.op_id,
        kind: row.kind,
        payload: row.payload,
        createdAt: row.created_at,
      }))
  }

  removePendingOp(opId: string): void {
    this.#db.query('DELETE FROM pending_ops WHERE op_id = ?').run(opId)
  }

  /**
   * Removes queued ops, returning them. A deferred path's row is consumed by
   * the next run: the scan rediscovers anything still outstanding, so rows
   * must not pile up run after run.
   */
  drainPendingOps(kind?: string): PendingOp[] {
    const ops = this.listPendingOps().filter((op) => kind === undefined || op.kind === kind)
    for (const op of ops) this.removePendingOp(op.opId)
    return ops
  }

  beginOp(row: {
    opId: string
    op: JournalOp
    targetPath: string
    startedAt: string
    tempPath?: string
    resultHash?: string
  }): void {
    this.#db
      .query(
        `INSERT INTO journal (op_id, op, target_path, state, temp_path, result_hash, started_at)
         VALUES (?, ?, ?, 'intent', ?, ?, ?)`,
      )
      .run(
        row.opId,
        row.op,
        row.targetPath,
        row.tempPath ?? null,
        row.resultHash ?? null,
        row.startedAt,
      )
  }

  markApplied(opId: string, resultHash: string): void {
    this.#db
      .query("UPDATE journal SET state = 'applied', result_hash = ? WHERE op_id = ?")
      .run(resultHash, opId)
  }

  finishOp(opId: string): void {
    this.#db.query('DELETE FROM journal WHERE op_id = ?').run(opId)
  }

  listJournal(): JournalRow[] {
    return this.#db
      .query<
        {
          op_id: string
          op: string
          target_path: string
          state: string
          temp_path: string | null
          result_hash: string | null
          started_at: string
        },
        []
      >('SELECT * FROM journal ORDER BY started_at, op_id')
      .all()
      .map((row) => ({
        opId: row.op_id,
        op: row.op as JournalOp,
        targetPath: row.target_path,
        state: row.state === 'applied' ? 'applied' : 'intent',
        tempPath: row.temp_path,
        resultHash: row.result_hash,
        startedAt: row.started_at,
      }))
  }

  /**
   * Startup repair. A write whose target already holds the intended hash is
   * adopted; a leftover temp file for the same content is removed; anything
   * else is left for the next plan to redo. A stale process lock is cleared.
   */
  reconcile(isAlive?: (pid: number) => boolean): ReconcileReport {
    const report: ReconcileReport = {
      adopted: [],
      rolledBack: [],
      cleared: [],
      staleLockRemoved: null,
    }
    const home = path.dirname(path.dirname(this.path))
    report.staleLockRemoved = clearStaleLock(home, isAlive)
    for (const row of this.listJournal()) {
      if (row.op === 'write') {
        const targetHash = hashFile(row.targetPath)
        if (row.resultHash !== null && targetHash === row.resultHash) {
          if (row.tempPath !== null) fs.rmSync(row.tempPath, { force: true })
          report.adopted.push(row.opId)
          this.finishOp(row.opId)
          continue
        }
        const tempHash = row.tempPath === null ? null : hashFile(row.tempPath)
        if (tempHash !== null) {
          fs.rmSync(row.tempPath ?? '', { force: true })
          report.rolledBack.push(row.opId)
          this.finishOp(row.opId)
          continue
        }
        report.cleared.push(row.opId)
        this.finishOp(row.opId)
        continue
      }
      if (row.op === 'delete') {
        if (!fs.existsSync(row.targetPath)) report.adopted.push(row.opId)
        else report.cleared.push(row.opId)
        this.finishOp(row.opId)
        continue
      }
      if (row.tempPath !== null) fs.rmSync(row.tempPath, { force: true })
      report.cleared.push(row.opId)
      this.finishOp(row.opId)
    }
    return report
  }
}
