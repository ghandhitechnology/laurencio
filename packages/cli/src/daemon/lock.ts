/**
 * The daemon's single-instance lock, `~/.laurencio/daemon.lock`. Separate from
 * the engine's `state.lock`, which is only held during one sync run: a daemon
 * that held that file would deadlock its own syncs. Stale detection follows the
 * engine rule, a dead PID or a PID reused by a different process is not a
 * holder.
 */

import fs from 'node:fs'
import path from 'node:path'
import { LockHeldError, type LockInfo, processStartTime, secrets } from '@laurencio/core'

export type DaemonLockInfo = LockInfo

export function daemonLockPath(home: string): string {
  return path.join(home, secrets.LAURENCIO_DIR, 'daemon.lock')
}

function truncateToSecond(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString()
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

function readLock(filePath: string): DaemonLockInfo | null {
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

export interface DaemonLockOptions {
  isAlive?: (pid: number) => boolean
  processStart?: (pid: number) => string | null
  pid?: number
  startedAt?: string
}

function lockIsStale(holder: DaemonLockInfo, options: DaemonLockOptions): boolean {
  const isAlive = options.isAlive ?? defaultIsAlive
  if (!isAlive(holder.pid)) return true
  const processStart = options.processStart ?? processStartTime
  const actual = processStart(holder.pid)
  // A probe that cannot read a start time leaves the lock held: never steal on doubt.
  return actual !== null && actual !== holder.startedAt
}

/**
 * Takes the daemon lock. Creation is atomic (`O_EXCL`), and a lock whose owner
 * is gone or whose PID was reused is replaced.
 */
export function acquireDaemonLock(home: string, options: DaemonLockOptions = {}): DaemonLockInfo {
  const filePath = daemonLockPath(home)
  const processStart = options.processStart ?? processStartTime
  const pid = options.pid ?? process.pid
  const startedAt = options.startedAt ?? processStart(pid) ?? truncateToSecond(Date.now())
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  for (;;) {
    const holder: DaemonLockInfo = { pid, startedAt }
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
    if (!lockIsStale(existing, options)) throw new LockHeldError(filePath, existing)
    fs.rmSync(filePath, { force: true })
  }
}

export function readDaemonLock(home: string): DaemonLockInfo | null {
  return readLock(daemonLockPath(home))
}

/** The holder when it is a live process, null when the lock is absent or stale. */
export function liveDaemonLock(
  home: string,
  options: DaemonLockOptions = {},
): DaemonLockInfo | null {
  const holder = readDaemonLock(home)
  if (holder === null) return null
  return lockIsStale(holder, options) ? null : holder
}

/** Releases the lock only when this process still owns it. */
export function releaseDaemonLock(
  home: string,
  pid: number = process.pid,
  holder?: DaemonLockInfo,
): boolean {
  const filePath = daemonLockPath(home)
  const existing = readDaemonLock(home)
  if (existing === null) return false
  if (holder !== undefined) {
    if (existing.pid !== holder.pid || existing.startedAt !== holder.startedAt) return false
  } else if (existing.pid !== pid) {
    return false
  }
  fs.rmSync(filePath, { force: true })
  return true
}
