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
  /** Test lever for crash injection: the rename landed, the journal is not updated yet. */
  afterRename?(op: { opId: string; op: JournalOp; targetPath: string; tempPath: string }): void
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

/**
 * Resolved realpath plus inode of a target and its parent. Compared before the
 * rename so a symlink swapped after the read cannot redirect the write.
 */
interface SlotIdentity {
  targetRealPath: string | null
  targetDev: number | null
  targetIno: number | null
  parentRealPath: string | null
  parentDev: number | null
  parentIno: number | null
}

function slotIdentity(targetPath: string): SlotIdentity {
  const identity: SlotIdentity = {
    targetRealPath: tryRealpath(targetPath),
    targetDev: null,
    targetIno: null,
    parentRealPath: tryRealpath(path.dirname(targetPath)),
    parentDev: null,
    parentIno: null,
  }
  try {
    const stat = fs.statSync(targetPath)
    identity.targetDev = stat.dev
    identity.targetIno = stat.ino
  } catch {
    // Missing target: absence is captured by targetRealPath staying null.
  }
  try {
    const parent = fs.statSync(path.dirname(targetPath))
    identity.parentDev = parent.dev
    identity.parentIno = parent.ino
  } catch {
    // The parent identity remains null; the realpath comparison still applies.
  }
  return identity
}

function sameSlot(a: SlotIdentity, b: SlotIdentity): boolean {
  return (
    a.targetRealPath === b.targetRealPath &&
    a.targetDev === b.targetDev &&
    a.targetIno === b.targetIno &&
    a.parentRealPath === b.parentRealPath &&
    a.parentDev === b.parentDev &&
    a.parentIno === b.parentIno
  )
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

  /** Atomic replace with the CAS guard applied to every path. Returns the new hash. */
  write(op: ApplyWrite): ApplyResult {
    const target = this.resolve(op.declaredPath)
    if (target.linkMissing) ensureLayoutLink(target)
    const expected = op.expected
    const declaredResolved = path.resolve(target.declaredPath)
    const hash = hashContent(op.content)
    const mode = op.mode ?? 0o644
    const baseOpId = `write_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    // When the declared path itself is written, its slot check already covers
    // it; the extra guard exists for writes that go through a link chain.
    const declaredIsPlanned = target.writePaths.some(
      (writePath) => path.resolve(writePath) === declaredResolved,
    )
    // Two passes over every write path: validate them all, then write. A mirror
    // that moved must refuse before either copy is touched.
    const prepared = target.writePaths.map((writePath, index) => {
      if (!this.isAllowed(writePath)) throw new NotInPlanError(writePath)
      ensureParentDirectories(writePath)
      if (expected !== undefined) {
        const actual = this.fingerprint(writePath)
        const matches =
          expected === null
            ? actual === null
            : actual !== null &&
              actual.hash === expected.hash &&
              (index > 0 || actual.mtimeMs === expected.mtimeMs)
        if (!matches) throw new StaleWriteError(writePath, expected, actual)
      }
      return {
        writePath,
        index,
        slot: slotIdentity(writePath),
        declared:
          declaredIsPlanned || path.resolve(writePath) === declaredResolved
            ? null
            : slotIdentity(target.declaredPath),
      }
    })
    for (const item of prepared) {
      const verify = (): void => {
        if (!sameSlot(slotIdentity(item.writePath), item.slot)) {
          throw new StaleWriteError(item.writePath, null, this.fingerprint(item.writePath))
        }
        if (item.declared !== null && !sameSlot(slotIdentity(target.declaredPath), item.declared)) {
          throw new StaleWriteError(
            target.declaredPath,
            null,
            this.fingerprint(target.declaredPath),
          )
        }
        if (
          expected !== undefined &&
          !this.#unchanged(item.writePath, expected, item.index === 0)
        ) {
          throw new StaleWriteError(item.writePath, expected, this.fingerprint(item.writePath))
        }
      }
      this.#writeOne(`${baseOpId}_${item.index}`, item.writePath, op.content, mode, hash, verify)
    }
    return { physicalPaths: [...target.writePaths], hash }
  }

  #unchanged(writePath: string, expected: FileFingerprint | null, strictMtime: boolean): boolean {
    const actual = this.fingerprint(writePath)
    if (expected === null) return actual === null
    return (
      actual !== null &&
      actual.hash === expected.hash &&
      (!strictMtime || actual.mtimeMs === expected.mtimeMs)
    )
  }

  #writeOne(
    opId: string,
    targetPath: string,
    content: string | Uint8Array,
    mode: number,
    hash: string,
    verify: () => void,
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
    try {
      verify()
    } catch (error) {
      // The target or its symlink chain moved under us: roll the temp back and
      // let the engine re-plan rather than rename into a different file.
      fs.rmSync(tempPath, { force: true })
      this.state.finishOp(opId)
      throw error
    }
    fs.renameSync(tempPath, targetPath)
    this.#hooks.afterRename?.({ opId, op: 'write', targetPath, tempPath })
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
