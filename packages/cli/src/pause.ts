/**
 * The daemon pause flag: `~/.laurencio/paused.json`. Device-local and inert on
 * its own; the daemon (phase 14) reads it to skip runs. A manual `sync` ignores
 * it, because the user asked for that run directly.
 */

import fs from 'node:fs'
import path from 'node:path'
import { secrets } from '@laurencio/core'

export interface PauseState {
  pausedAt: string
  by: string
}

export function pauseFilePath(home: string): string {
  return path.join(home, secrets.LAURENCIO_DIR, 'paused.json')
}

export function readPause(home: string): PauseState | null {
  let raw: string
  try {
    raw = fs.readFileSync(pauseFilePath(home), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (typeof record.pausedAt !== 'string' || typeof record.by !== 'string') return null
    return { pausedAt: record.pausedAt, by: record.by }
  } catch {
    return null
  }
}

export function writePause(home: string, state: PauseState): string {
  const filePath = pauseFilePath(home)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
  return filePath
}

/** Removes the flag. Returns false when the daemon was not paused. */
export function clearPause(home: string): boolean {
  const filePath = pauseFilePath(home)
  if (!fs.existsSync(filePath)) return false
  fs.rmSync(filePath, { force: true })
  return true
}
