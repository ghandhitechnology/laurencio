import fs from 'node:fs'
import path from 'node:path'
import { Applier, acquireLock, hashContent, releaseLock } from '@laurencio/core'
import { backupsDir } from '../backup'
import { cliError } from '../errors'
import { writePause } from '../pause'
import { askYesNo } from '../prompt'
import { ok } from '../result'
import { openState } from '../session'
import { displayPath, table } from '../ui'
import type { CommandSpec } from './command'

interface FileBackup {
  id: string
  targetPath: string
  declaredPath: string
  hash: string
  mode: number
  size: number
  savedAt: string
  contentPath: string
}

function listBackups(home: string): FileBackup[] {
  const root = path.join(backupsDir(home), 'files')
  if (!fs.existsSync(root)) return []
  const backups: FileBackup[] = []
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^[a-f0-9]{64}$/.test(directory.name)) continue
    const folder = path.join(root, directory.name)
    for (const file of fs.readdirSync(folder, { withFileTypes: true })) {
      if (!file.isFile() || !/^[a-f0-9]{64}-[a-f0-9]{16}\.json$/.test(file.name)) continue
      const metadataPath = path.join(folder, file.name)
      const metadata = fs.readFileSync(metadataPath, 'utf8')
      if (hashContent(metadata.trimEnd()).slice(0, 16) !== file.name.slice(65, 81))
        throw cliError(
          'invalid-backup',
          `Backup metadata failed its integrity check: ${metadataPath}`,
        )
      const data = JSON.parse(metadata)
      if (
        typeof data.targetPath !== 'string' ||
        !path.isAbsolute(data.targetPath) ||
        typeof data.declaredPath !== 'string' ||
        !path.isAbsolute(data.declaredPath) ||
        typeof data.hash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(data.hash) ||
        !file.name.startsWith(`${data.hash}-`) ||
        hashContent(data.targetPath) !== directory.name ||
        !Number.isSafeInteger(data.mode) ||
        data.mode < 0 ||
        data.mode > 0o777 ||
        !Number.isSafeInteger(data.size) ||
        data.size < 0
      )
        throw cliError('invalid-backup', `Invalid backup metadata: ${metadataPath}`)
      backups.push({
        id: `${directory.name.slice(0, 12)}-${file.name.slice(0, 12)}-${file.name.slice(65, 81)}`,
        targetPath: data.targetPath,
        declaredPath: data.declaredPath,
        hash: data.hash,
        mode: data.mode,
        size: data.size,
        savedAt: fs.statSync(metadataPath).mtime.toISOString(),
        contentPath: path.join(folder, `${data.hash}.content`),
      })
    }
  }
  return backups.sort((a, b) => b.savedAt.localeCompare(a.savedAt))
}

/** Follow existing links even when their final file was deleted. Never creates links. */
function recoveryTarget(declaredPath: string): string {
  let candidate = path.resolve(declaredPath)
  for (let hop = 0; hop < 40; hop += 1) {
    const root = path.parse(candidate).root
    const parts = candidate.slice(root.length).split(path.sep).filter(Boolean)
    let current = root
    let followed = false
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part)
      let stat: fs.Stats
      try {
        stat = fs.lstatSync(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return candidate
        throw error
      }
      if (!stat.isSymbolicLink()) continue
      candidate = path.resolve(
        path.dirname(current),
        fs.readlinkSync(current),
        ...parts.slice(index + 1),
      )
      followed = true
      break
    }
    if (!followed) return candidate
  }
  throw cliError('backup-path-changed', 'The configuration contains a symbolic-link loop.')
}

export const backupsCommand: CommandSpec = {
  name: 'backups',
  summary: 'Browse or recover local configuration backups offline',
  usage: 'laurencio backups [restore <id>] [--yes] [--json]',
  async run(ctx) {
    const backups = listBackups(ctx.home)
    if (ctx.positionals.length === 0) {
      return ok({ backups }, () =>
        backups.length === 0
          ? 'No file backups yet. Backups are saved before configuration is changed.'
          : `${table(
              backups.map((item) => [
                item.id,
                item.savedAt,
                displayPath(ctx.home, item.declaredPath),
              ]),
              { header: ['ID', 'SAVED', 'FILE'] },
            )}\nRestore with: laurencio backups restore <id>`,
      )
    }
    if (ctx.positionals[0] !== 'restore' || ctx.positionals.length !== 2)
      throw cliError('bad-arguments', 'Usage: laurencio backups [restore <id>]')
    const matches = backups.filter((item) => item.id === ctx.positionals[1])
    if (matches.length !== 1)
      throw cliError('unknown-backup', 'Choose a backup ID from `laurencio backups`.')
    const backup = matches[0] as FileBackup
    const content = fs.readFileSync(backup.contentPath)
    if (hashContent(content) !== backup.hash || content.byteLength !== backup.size)
      throw cliError(
        'invalid-backup',
        'The backup failed its integrity check; no files were changed.',
      )
    if (!ctx.flags.yes) {
      if (ctx.flags.json)
        throw cliError('confirmation-required', 'Restore needs --yes in JSON mode.')
      if (
        !(await askYesNo(
          ctx,
          `Restore ${displayPath(ctx.home, backup.declaredPath)} and pause background sync?`,
          false,
        ))
      )
        return ok({ restored: false }, () => 'Restore cancelled.')
    }
    const holder = acquireLock(ctx.home)
    try {
      const state = openState(ctx)
      try {
        const applier = new Applier({
          state,
          planPaths: [backup.declaredPath, backup.targetPath],
          platform: ctx.platform,
          now: ctx.now,
        })
        const physicalPath = recoveryTarget(backup.declaredPath)
        if (physicalPath !== backup.targetPath)
          throw cliError(
            'backup-path-changed',
            'The configuration link now points elsewhere. Restore its original link before recovery.',
          )
        writePause(ctx.home, { pausedAt: ctx.now().toISOString(), by: 'backup-restore' })
        applier.write({
          storePath: backup.declaredPath,
          // A deleted symlink target leaves its link dangling. Write its checked
          // physical destination so the link itself survives recovery.
          declaredPath: physicalPath,
          content,
          mode: backup.mode,
          expected: applier.fingerprint(backup.targetPath),
        })
        return ok(
          { restored: true, path: backup.declaredPath, paused: true },
          () =>
            `Restored ${displayPath(ctx.home, backup.declaredPath)}. Background sync is paused. Run \`laurencio resume\` when ready.`,
        )
      } finally {
        state.close()
      }
    } finally {
      releaseLock(ctx.home, holder.pid, holder)
    }
  },
}
