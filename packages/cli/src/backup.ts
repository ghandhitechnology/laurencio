/**
 * Automatic backups before enrollment and restore. A backup is a plain copy of
 * the declared roots under `~/.laurencio/backups/<timestamp>/`, with a small
 * index file. The newest five are kept.
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
  const dir = path.join(backupsDir(home), compactTimestamp(now))
  const entries: BackupEntry[] = []
  let copiedAny = false
  for (const [index, root] of roots.entries()) {
    const exists = fs.existsSync(root.path)
    const suffix = `${String(index + 1).padStart(2, '0')}-${slug(root.label)}`
    if (exists) {
      const target = path.join(dir, suffix)
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
      // Keep links as links. Following a link nested inside a surface could copy an
      // unrelated tree that Laurencio neither owns nor intends to replace.
      fs.cpSync(root.path, target, {
        recursive: true,
        dereference: false,
        preserveTimestamps: true,
      })
      copiedAny = true
    }
    entries.push({ label: root.label, path: root.path, copied: exists })
  }
  if (copiedAny) {
    fs.writeFileSync(
      path.join(dir, 'backup.json'),
      `${JSON.stringify({ createdAt: now.toISOString(), entries }, null, 2)}\n`,
      { mode: 0o600 },
    )
    pruneBackups(home)
  }
  return { dir, entries }
}

export function pruneBackups(home: string, keep: number = BACKUP_KEEP): string[] {
  const root = backupsDir(home)
  let names: string[]
  try {
    names = fs.readdirSync(root).sort()
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const target = path.join(root, name)
    fs.rmSync(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}
