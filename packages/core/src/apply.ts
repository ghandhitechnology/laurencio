/**
 * The only module that writes to a synced surface. Every write is atomic
 * (temp file, fsync, rename), every replace is guarded by a compare-and-swap
 * on the target's mtime and hash, and every path must have been declared by
 * the plan. Deletions go through the journal too and become tombstones, and a
 * non-empty directory is never removed.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RevisionId, SurfaceId } from '@laurencio/protocol'
import {
  ensureLayoutLink,
  ensureParentDirectories,
  type LayoutTarget,
  resolveLayoutTarget,
} from './materialize'
import type { LocalLayout } from './model'
import type { JournalOp, SyncState } from './state'
import type { Platform } from './types'

export interface FileFingerprint {
  mtimeMs: number
  size: number
  hash: string
}

export class NotInPlanError extends Error {
  readonly targetPath: string

  constructor(targetPath: string) {
    super(`refusing to write outside the plan: ${targetPath}`)
    this.name = 'NotInPlanError'
    this.targetPath = targetPath
  }
}

export class StaleWriteError extends Error {
  readonly targetPath: string
  readonly expected: FileFingerprint | null
  readonly actual: FileFingerprint | null

  constructor(
    targetPath: string,
    expected: FileFingerprint | null,
    actual: FileFingerprint | null,
  ) {
    super(`target changed since it was read: ${targetPath}`)
    this.name = 'StaleWriteError'
    this.targetPath = targetPath
    this.expected = expected
    this.actual = actual
  }
}

export class NonEmptyDirectoryError extends Error {
  readonly targetPath: string

  constructor(targetPath: string) {
    super(`refusing to delete a non-empty directory: ${targetPath}`)
    this.name = 'NonEmptyDirectoryError'
    this.targetPath = targetPath
  }
}

export interface ApplyHooks {
  /** Test lever for crash injection: called with the journal row still open. */
  beforeRename?(op: { opId: string; op: JournalOp; targetPath: string; tempPath: string }): void
}

export interface ApplierOptions {
  state: SyncState
  /** Absolute declared paths the plan may touch. */
  planPaths: readonly string[]
  layout?: LocalLayout | null
  platform?: Platform
  copyMode?: boolean
  hooks?: ApplyHooks
  now?: () => Date
}

export interface ApplyWrite {
  storePath: string
  declaredPath: string
  content: string | Uint8Array
  mode?: number
  /** Pre-read fingerprint; null asserts the path does not exist yet. */
  expected?: FileFingerprint | null
}

export interface ApplyDelete {
  storePath: string
  surfaceId: SurfaceId
  declaredPath: string
  /** Base revision whose manifest gets the tombstone. */
  baseRevision?: RevisionId | null
}

export interface ApplyResult {
  physicalPaths: string[]
  hash: string
}

export function hashContent(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex')
}

const TEMP_NAME_PATTERN = /^\.laurencio-[A-Za-z0-9_-]+\.tmp$/

function tryRealpath(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

/** Plan paths plus their physical spellings, so symlinked homes stay writable. */
function allowlist(paths: readonly string[]): string[] {
  const out = new Set<string>()
  for (const entry of paths) {
    const resolved = path.resolve(entry)
    out.add(resolved)
    const real = tryRealpath(resolved)
    if (real !== null) {
      out.add(real)
      continue
    }
    const parentReal = tryRealpath(path.dirname(resolved))
    if (parentReal !== null) out.add(path.join(parentReal, path.basename(resolved)))
  }
  return [...out]
}

export class Applier {
  readonly state: SyncState
  readonly platform: Platform
  readonly copyMode: boolean
  readonly layout: LocalLayout | null
  #allowed: string[]
  #hooks: ApplyHooks
  #now: () => Date

  constructor(options: ApplierOptions) {
    this.state = options.state
    this.platform = options.platform ?? 'darwin'
    this.copyMode = options.copyMode ?? this.platform === 'win32'
    this.layout = options.layout ?? null
    this.#allowed = allowlist(options.planPaths)
    this.#hooks = options.hooks ?? {}
    this.#now = options.now ?? (() => new Date())
  }

  isAllowed(candidate: string): boolean {
    const resolved = path.resolve(candidate)
    if (this.#allowed.includes(resolved)) return true
    if (TEMP_NAME_PATTERN.test(path.basename(resolved))) {
      return this.#allowed.some((allowed) => path.dirname(allowed) === path.dirname(resolved))
    }
    return this.#allowed.some((allowed) => resolved.startsWith(`${allowed}.conflict-`))
  }

  resolve(declaredPath: string): LayoutTarget {
    return resolveLayoutTarget({
      declaredPath,
      layout: this.layout,
      platform: this.platform,
      copyMode: this.copyMode,
    })
  }

  fingerprint(localPath: string): FileFingerprint | null {
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(localPath)
    } catch {
      return null
    }
    if (!stat.isFile()) return null
    let data: Buffer
    try {
      data = fs.readFileSync(localPath)
    } catch {
      return null
    }
    return { mtimeMs: stat.mtimeMs, size: stat.size, hash: hashContent(data) }
  }

  /** Atomic replace with the CAS guard already applied. Returns the new hash. */
  write(op: ApplyWrite): ApplyResult {
    const target = this.resolve(op.declaredPath)
    if (target.linkMissing) ensureLayoutLink(target)
    const expected = op.expected
    if (expected !== undefined) {
      const actual = this.fingerprint(target.writePaths[0] ?? target.declaredPath)
      const matches =
        expected === null
          ? actual === null
          : actual !== null && actual.mtimeMs === expected.mtimeMs && actual.hash === expected.hash
      if (!matches) {
        throw new StaleWriteError(target.writePaths[0] ?? target.declaredPath, expected, actual)
      }
    }

    const hash = hashContent(op.content)
    const mode = op.mode ?? 0o644
    const baseOpId = `write_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    for (const [index, writePath] of target.writePaths.entries()) {
      if (!this.isAllowed(writePath)) throw new NotInPlanError(writePath)
      this.#writeOne(`${baseOpId}_${index}`, writePath, op.content, mode, hash)
    }
    return { physicalPaths: [...target.writePaths], hash }
  }

  #writeOne(
    opId: string,
    targetPath: string,
    content: string | Uint8Array,
    mode: number,
    hash: string,
  ): void {
    ensureParentDirectories(targetPath)
    const tempPath = path.join(path.dirname(targetPath), `.laurencio-${opId}.tmp`)
    this.state.beginOp({
      opId,
      op: 'write',
      targetPath,
      tempPath,
      resultHash: hash,
      startedAt: this.#now().toISOString(),
    })
    const fd = fs.openSync(tempPath, 'w', mode)
    try {
      fs.writeFileSync(fd, content)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.chmodSync(tempPath, mode)
    this.#hooks.beforeRename?.({ opId, op: 'write', targetPath, tempPath })
    fs.renameSync(tempPath, targetPath)
    this.state.markApplied(opId, hash)
    this.state.finishOp(opId)
  }

  /**
   * Removes one planned path and records a tombstone so the deletion travels.
   * Directories are only removed when empty.
   */
  remove(op: ApplyDelete): void {
    const target = this.resolve(op.declaredPath)
    const tombstoned = op.baseRevision !== undefined && op.baseRevision !== null
    for (const [index, writePath] of target.writePaths.entries()) {
      if (!this.isAllowed(writePath)) throw new NotInPlanError(writePath)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(writePath)
      } catch {
        continue
      }
      const opId = `delete_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}_${index}`
      if (stat.isDirectory()) {
        this.state.beginOp({
          opId,
          op: 'delete',
          targetPath: writePath,
          startedAt: this.#now().toISOString(),
        })
        try {
          fs.rmdirSync(writePath)
        } catch (error) {
          this.state.finishOp(opId)
          if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') {
            throw new NonEmptyDirectoryError(writePath)
          }
          throw error
        }
        this.state.markApplied(opId, '')
        this.state.finishOp(opId)
        continue
      }
      this.state.beginOp({
        opId,
        op: 'delete',
        targetPath: writePath,
        startedAt: this.#now().toISOString(),
      })
      fs.unlinkSync(writePath)
      this.state.markApplied(opId, '')
      this.state.finishOp(opId)
    }
    if (tombstoned && op.baseRevision !== undefined && op.baseRevision !== null) {
      this.state.recordTombstone(op.baseRevision, op.surfaceId, op.storePath)
    }
  }
}
