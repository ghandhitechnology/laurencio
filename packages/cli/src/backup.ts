/**
 * Automatic backups before enrollment and restore. A backup is a plain copy of
 * the declared roots under `~/.laurencio/backups/<timestamp>/`, with a small
 * index file. The first snapshot and newest five are kept.
 */

import fs from 'node:fs'
import path from 'node:path'
import { secrets } from '@laurencio/core'

export const BACKUP_KEEP = 5

export interface BackupRoot {
  label: string
  path: string
}

export interface BackupEntry {
  label: string
  path: string
  copied: boolean
  /** Original root link, while the snapshot holds independent target bytes. */
  linkTarget?: string
}

export interface BackupResult {
  dir: string
  entries: BackupEntry[]
}

export function backupsDir(home: string): string {
  return path.join(home, secrets.LAURENCIO_DIR, 'backups')
}

function compactTimestamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}

function slug(label: string): string {
  const cleaned = label.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return cleaned === '' ? 'root' : cleaned
}

export function createBackup(home: string, roots: readonly BackupRoot[], now: Date): BackupResult {
  const base = path.join(backupsDir(home), compactTimestamp(now))
  let dir = base
  let sequence = 0
  fs.mkdirSync(backupsDir(home), { recursive: true, mode: 0o700 })
  for (;;) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 })
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      dir = `${base}-${String(++sequence).padStart(4, '0')}`
    }
  }
  const entries: BackupEntry[] = []
  let copiedAny = false
  for (const [index, root] of roots.entries()) {
    let stat: fs.Stats | undefined
    try {
      stat = fs.lstatSync(root.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const exists = stat !== undefined
    const linkTarget = stat?.isSymbolicLink() ? fs.readlinkSync(root.path) : undefined
    const suffix = `${String(index + 1).padStart(2, '0')}-${slug(root.label)}`
    if (exists) {
      const target = path.join(dir, suffix)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      // Keep links as links. Following a link nested inside a surface could copy an
      // unrelated tree that Laurencio neither owns nor intends to replace.
      fs.cpSync(
        linkTarget !== undefined && fs.existsSync(root.path)
          ? fs.realpathSync(root.path)
          : root.path,
        target,
        {
          recursive: true,
          dereference: false,
          preserveTimestamps: true,
        },
      )
      copiedAny = true
    }
    entries.push({
      label: root.label,
      path: root.path,
      copied: exists,
      ...(linkTarget === undefined ? {} : { linkTarget }),
    })
  }
  if (copiedAny) {
    fs.writeFileSync(
      path.join(dir, 'backup.json'),
      `${JSON.stringify({ createdAt: now.toISOString(), entries }, null, 2)}\n`,
      { mode: 0o600 },
    )
    flushSnapshot(dir)
    flushDirectory(backupsDir(home))
    pruneBackups(home)
  } else fs.rmdirSync(dir)
  return { dir, entries }
}

function flushDirectory(directory: string): void {
  if (process.platform === 'win32') return
  const fd = fs.openSync(directory, 'r')
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

/** Never follow nested links while making the backup durable. */
function flushSnapshot(target: string): void {
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) return
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) flushSnapshot(path.join(target, name))
    flushDirectory(target)
    return
  }
  if (stat.isFile()) {
    const fd = fs.openSync(target, 'r')
    try {
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  }
}

export function pruneBackups(home: string, keep: number = BACKUP_KEEP): string[] {
  const root = backupsDir(home)
  let names: string[]
  try {
    names = fs
      .readdirSync(root)
      .filter((name) => {
        if (!/^\d{8}T\d{6}Z(?:-\d+)?$/.test(name)) return false
        const snapshot = path.join(root, name)
        return (
          fs.lstatSync(snapshot).isDirectory() && fs.existsSync(path.join(snapshot, 'backup.json'))
        )
      })
      .sort()
  } catch {
    return []
  }
  const removed: string[] = []
  // The oldest complete snapshot is the permanent enrollment baseline. Other
  // backup families (file preimages and terminal settings) have their own policy.
  for (const name of names.slice(1, Math.max(1, names.length - keep))) {
    const target = path.join(root, name)
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}
