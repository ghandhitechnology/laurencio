import fs from 'node:fs'
import {
  Applier,
  type ApplyWrite,
  acquireLock,
  applyTransforms,
  crypto,
  hashContent,
  isWithinRoot,
  type ManifestEntry,
  parseLocalBlocks,
  releaseLock,
  usesMarkerBlocks,
} from '@laurencio/core'
import { PROTOCOL_VERSION } from '@laurencio/protocol'
import { type BackupRoot, createBackup } from '../backup'
import { loadCliConfig } from '../config'
import { adapterContext } from '../context'
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
      const surface = inventory.surfaces.get(entry.surfaceId)
      const root =
        surface === undefined
          ? null
          : localPathForStorePath(inventory.surfaces, inventory.byStorePath, ctx, surface.path)
      if (
        localPath === null ||
        root === null ||
        surface?.policy === 'never' ||
        !isWithinRoot(localPath, root)
      ) {
        skipped.push(entry.path)
        continue
      }
      targets.push({ entry, localPath })
    }

    const state = openState(ctx)
    let lock: ReturnType<typeof acquireLock> | undefined
    try {
      lock = acquireLock(ctx.home)
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

      // Prepare every projection before the first write. A corrupt revision or
      // malformed native config must not leave a partially restored profile.
      const writes: ApplyWrite[] = []
      for (const { entry, localPath } of targets) {
        if (entry.blob === undefined) continue
        const surface = inventory.surfaces.get(entry.surfaceId)
        if (surface === undefined) {
          skipped.push(entry.path)
          continue
        }
        const expected = applier.fingerprint(localPath)
        const localContent = expected === null ? null : fs.readFileSync(localPath, 'utf8')
        const bytes = await session.remote.getBlob(entry.blob.id)
        const projection = crypto.openText(session.credentials.key, 'content', bytes, {
          storeId: session.credentials.storeId,
          blobType: 'file',
          protocolVersion: PROTOCOL_VERSION,
        })
        if (hashContent(projection) !== entry.hash) {
          throw cliError(
            'restore-integrity',
            `Stored content does not match the revision: ${entry.path}`,
          )
        }
        const content = applyTransforms({
          surface,
          storePath: entry.path,
          direction: 'fromStore',
          tokenEnv: adapterContext(ctx),
          content: projection,
          localContent,
          localBlocks: usesMarkerBlocks(surface, entry.path)
            ? localContent === null
              ? state.getMarkers(localPath)
              : parseLocalBlocks(localPath, localContent)
            : [],
        }).content
        writes.push({
          storePath: entry.path,
          declaredPath: localPath,
          content,
          mode: entry.mode,
          expected,
        })
      }
      const roots: BackupRoot[] = writes
        .filter((write) => fs.existsSync(write.declaredPath))
        .map((write) => ({ label: write.storePath, path: write.declaredPath }))
      const backup = roots.length === 0 ? null : createBackup(ctx.home, roots, ctx.now()).dir
      const restored: { storePath: string; localPath: string }[] = []
      for (const write of writes) {
        applier.write(write)
        restored.push({ storePath: write.storePath, localPath: write.declaredPath })
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
      if (lock !== undefined) releaseLock(ctx.home, lock.pid, lock)
    }
  },
}
