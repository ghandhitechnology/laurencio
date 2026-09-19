import fs from 'node:fs'
import { Applier, crypto, type ManifestEntry } from '@laurencio/core'
import { PROTOCOL_VERSION } from '@laurencio/protocol'
import { type BackupRoot, createBackup } from '../backup'
import { loadCliConfig } from '../config'
import { cliError } from '../errors'
import { fetchManifestAt, resolveRevisionId } from '../history'
import { localPathForStorePath, selectorMatches } from '../layout'
import { askYesNo } from '../prompt'
import { fail, ok } from '../result'
import { adaptersFor, identityFor, openSession, openState, scanInventory } from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'

export interface RestoreData {
  revision: string
  selector: string | null
  restored: { storePath: string; localPath: string }[]
  skipped: string[]
  backup: string | null
}

function usable(entry: ManifestEntry): boolean {
  return entry.kind === 'file' && entry.blob !== undefined
}

export const restoreCommand: CommandSpec = {
  name: 'restore',
  summary: 'Restore a file, a surface, or everything from a revision',
  usage: 'laurencio restore <revision> [path] [--yes] [--json]',
  async run(ctx) {
    const revisionPrefix = ctx.positionals[0]
    if (revisionPrefix === undefined || revisionPrefix === '') {
      throw cliError('missing-argument', 'restore needs a revision id', {
        hint: 'Usage: laurencio restore <revision> [path]',
      })
    }
    const selector = ctx.positionals[1] ?? ctx.flags.surface ?? null
    const session = await openSession(ctx)
    const revisionId = await resolveRevisionId(session, revisionPrefix)
    const manifest = await fetchManifestAt(session, revisionId)
    const entries = manifest.entries.filter((entry) => {
      if (!usable(entry)) return false
      if (selector === null) return true
      if (selectorMatches(selector, entry.path)) return true
      return entry.surfaceId === selector
    })
    if (entries.length === 0) {
      throw cliError('nothing-to-restore', 'that revision has no files matching the selector')
    }
    const label = selector === null ? 'everything' : selector
    if (!ctx.flags.yes) {
      if (ctx.flags.json) {
        return fail(
          'confirmation-required',
          'restore needs --yes in JSON mode',
          1,
          `Confirm with: laurencio restore ${revisionId.slice(0, 10)} ${selector ?? ''} --yes`,
        )
      }
      const confirmed = await askYesNo(
        ctx,
        `Restore ${plural(entries.length, 'file')} (${label}) from revision ${revisionId.slice(0, 10)}?`,
        false,
      )
      if (!confirmed) {
        const data: RestoreData = {
          revision: revisionId,
          selector,
          restored: [],
          skipped: [],
          backup: null,
        }
        return ok(data, () => 'Restore cancelled.')
      }
    }

    const config = loadCliConfig(ctx.home)
    const identity = identityFor(ctx) ?? session.identity
    const inventory = scanInventory(ctx, { policy: config.policy })
    const targets: { entry: ManifestEntry; localPath: string }[] = []
    const skipped: string[] = []
    for (const entry of entries) {
      const localPath = localPathForStorePath(
        inventory.surfaces,
        inventory.byStorePath,
        ctx,
        entry.path,
      )
      if (localPath === null) {
        skipped.push(entry.path)
        continue
      }
      targets.push({ entry, localPath })
    }

    const state = openState(ctx)
    try {
      const planPaths = new Set<string>()
      for (const entry of inventory.scan.entries) planPaths.add(entry.localPath)
      for (const adapter of adaptersFor(ctx, config.policy)) {
        for (const surface of adapter.surfaces({
          home: ctx.home,
          platform: ctx.platform,
          env: ctx.env,
        })) {
          const root = localPathForStorePath(
            inventory.surfaces,
            inventory.byStorePath,
            ctx,
            surface.path,
          )
          if (root !== null) planPaths.add(root)
        }
      }
      for (const target of targets) planPaths.add(target.localPath)

      const applier = new Applier({
        state,
        planPaths: [...planPaths],
        layout: state.getLayout(identity.deviceId),
        platform: ctx.platform,
        now: ctx.now,
      })

      const roots: BackupRoot[] = targets
        .filter((target) => fs.existsSync(target.localPath))
        .map((target) => ({ label: target.entry.path, path: target.localPath }))
      const backup = roots.length === 0 ? null : createBackup(ctx.home, roots, ctx.now()).dir

      const restored: { storePath: string; localPath: string }[] = []
      for (const { entry, localPath } of targets) {
        if (entry.blob === undefined) continue
        const bytes = await session.remote.getBlob(entry.blob.id)
        const content = crypto.openText(session.credentials.key, 'content', bytes, {
          storeId: session.credentials.storeId,
          blobType: 'file',
          protocolVersion: PROTOCOL_VERSION,
        })
        applier.write({
          storePath: entry.path,
          declaredPath: localPath,
          content,
          mode: entry.mode,
          expected: applier.fingerprint(localPath),
        })
        restored.push({ storePath: entry.path, localPath })
      }

      const data: RestoreData = { revision: revisionId, selector, restored, skipped, backup }
      const human = (): string => {
        const lines = [
          `Restored ${plural(restored.length, 'file')} from ${revisionId.slice(0, 10)}`,
        ]
        if (backup !== null) lines.push(`Backup: ${displayPath(ctx.home, backup)}`)
        for (const item of restored.slice(0, 20)) {
          lines.push(`  ${displayPath(ctx.home, item.localPath)}`)
        }
        if (restored.length > 20) lines.push(`  and ${restored.length - 20} more`)
        for (const item of skipped) lines.push(`  skipped (no local path): ${item}`)
        lines.push('Run `laurencio sync` to publish the restored content.')
        return lines.join('\n')
      }
      return ok(data, human)
    } finally {
      state.close()
    }
  },
}
