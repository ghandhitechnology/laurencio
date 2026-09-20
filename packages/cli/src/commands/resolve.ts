import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  Applier,
  acquireLock,
  applyTransforms,
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  type ConflictRecord,
  isWithinRoot,
  parseLocalBlocks,
  releaseLock,
  type Surface,
  usesMarkerBlocks,
} from '@laurencio/core'
import { loadCliConfig } from '../config'
import { adapterContext, type CommandContext } from '../context'
import { cliError } from '../errors'
import { localPathForStorePath } from '../layout'
import { askChoice } from '../prompt'
import { ok } from '../result'
import { openSession, openState, scanInventory } from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'

export interface ResolvedRow {
  sourcePath: string
  copyPath: string
  choice: string
}

export interface ResolveData {
  conflicts: { sourcePath: string; copyPath: string; device: string; createdAt: string }[]
  resolved: ResolvedRow[]
  remaining: { sourcePath: string; copyPath: string }[]
}

function markerText(local: string, remote: string, record: ConflictRecord): string {
  const endsWithNewline = local.endsWith('\n')
  const body = [
    '<<<<<<< local',
    ...local.replace(/\n$/, '').split('\n'),
    '=======',
    ...remote.replace(/\n$/, '').split('\n'),
    `>>>>>>> remote (${record.device}, ${record.createdAt})`,
  ].join('\n')
  return endsWithNewline ? `${body}\n` : body
}

function isBinary(text: string): boolean {
  return text.includes('\u0000')
}

function physicalPath(filePath: string): string | null {
  try {
    return fs.realpathSync(filePath)
  } catch {
    return null
  }
}

export const resolveCommand: CommandSpec = {
  name: 'resolve',
  summary: 'Settle conflict copies by keeping local or remote content',
  usage: 'laurencio resolve [path] [--keep-local|--keep-remote|--editor] [--json]',
  async run(ctx) {
    const selector = ctx.flags.surface ?? ctx.positionals[0] ?? null
    const state = openState(ctx)
    let lock: ReturnType<typeof acquireLock> | undefined
    try {
      lock = acquireLock(ctx.home)
      const ledger = readLedgerFrom(state)
      const all = ledger.records()
      const selected = all.filter(
        (record) =>
          selector === null ||
          record.sourcePath === selector ||
          record.sourcePath.startsWith(`${selector}/`),
      )
      if (selected.length === 0) {
        const data: ResolveData = { conflicts: [], resolved: [], remaining: [] }
        return ok(data, () =>
          all.length === 0 ? 'No conflicts.' : 'No conflicts matched the selector.',
        )
      }
      if (ctx.flags.keepLocal && ctx.flags.keepRemote) {
        throw cliError('bad-flags', 'pass either --keep-local or --keep-remote, not both')
      }
      if (ctx.flags.json && !ctx.flags.keepLocal && !ctx.flags.keepRemote) {
        throw cliError('bad-flags', 'resolve needs --keep-local or --keep-remote in JSON mode')
      }

      const config = loadCliConfig(ctx.home)
      const session = await openSession(ctx)
      const inventory = scanInventory(ctx, { policy: config.policy })
      const planPaths = new Set<string>()
      for (const entry of inventory.scan.entries) planPaths.add(entry.localPath)
      const locations = new Map<
        ConflictRecord,
        { sourcePath: string; copyPath: string; storePath: string; surface: Surface }
      >()
      for (const record of selected) {
        const legacyPath = path.isAbsolute(record.sourcePath)
          ? physicalPath(record.sourcePath)
          : null
        const scanned = inventory.scan.entries.find(
          (entry) =>
            entry.localPath === record.sourcePath ||
            (legacyPath !== null && physicalPath(entry.localPath) === legacyPath),
        )
        const storePath = scanned?.storePath ?? record.sourcePath
        const sourcePath = localPathForStorePath(
          inventory.surfaces,
          inventory.byStorePath,
          ctx,
          storePath,
        )
        const surface =
          scanned === undefined
            ? [...inventory.surfaces.values()].find(
                (item) => storePath === item.path || storePath.startsWith(`${item.path}/`),
              )
            : inventory.surfaces.get(scanned.surfaceId)
        const root =
          surface === undefined
            ? null
            : localPathForStorePath(inventory.surfaces, inventory.byStorePath, ctx, surface.path)
        const suffix = record.path.slice(record.sourcePath.length)
        if (
          sourcePath === null ||
          surface === undefined ||
          surface.policy === 'never' ||
          root === null ||
          !isWithinRoot(sourcePath, root) ||
          !record.path.startsWith(record.sourcePath) ||
          !/^\.conflict-[A-Za-z0-9._-]+-\d{8}T\d{6}Z$/.test(suffix)
        ) {
          throw cliError(
            'unknown-conflict-path',
            `Conflict does not belong to a local surface: ${record.sourcePath}`,
          )
        }
        const copyPath = `${sourcePath}${suffix}`
        locations.set(record, { sourcePath, copyPath, storePath, surface })
        planPaths.add(sourcePath)
        planPaths.add(copyPath)
      }
      const applier = new Applier({
        state,
        planPaths: [...planPaths],
        layout: state.getLayout(session.identity.deviceId),
        platform: ctx.platform,
        now: ctx.now,
      })

      const resolved: ResolvedRow[] = []
      const kept: ConflictRecord[] = []
      for (const record of selected) {
        const choice = await choose(ctx, record)
        if (choice === 'skip') {
          kept.push(record)
          continue
        }
        const location = locations.get(record)
        if (location === undefined) continue
        applyChoice(ctx, applier, record, choice, location)
        // Each settled copy is durable before another prompt or editor can fail.
        state.setMeta(
          CONFLICT_LEDGER_META_KEY,
          new ConflictLedger(
            all.filter(
              (item) => item !== record && !resolved.some((row) => row.copyPath === item.path),
            ),
          ).toJSON(),
        )
        resolved.push({ sourcePath: record.sourcePath, copyPath: record.path, choice })
      }
      for (const record of all) {
        if (!selected.includes(record)) kept.push(record)
      }
      state.setMeta(CONFLICT_LEDGER_META_KEY, new ConflictLedger(kept).toJSON())

      const data: ResolveData = {
        conflicts: all.map((record) => ({
          sourcePath: record.sourcePath,
          copyPath: record.path,
          device: record.device,
          createdAt: record.createdAt,
        })),
        resolved,
        remaining: kept.map((record) => ({ sourcePath: record.sourcePath, copyPath: record.path })),
      }
      const human = (): string => {
        if (resolved.length === 0) return 'No conflicts were resolved.'
        const lines = [`Resolved ${plural(resolved.length, 'conflict')}`]
        for (const row of resolved) {
          lines.push(`  ${displayPath(ctx.home, row.sourcePath)} (${row.choice})`)
        }
        if (kept.length > 0)
          lines.push(`${plural(kept.length, 'conflict')} still open, run resolve again`)
        lines.push('Run `laurencio sync` to publish the resolved content.')
        return lines.join('\n')
      }
      return ok(data, human, kept.length > 0 ? 2 : 0)
    } finally {
      state.close()
      if (lock !== undefined) releaseLock(ctx.home, lock.pid, lock)
    }
  },
}

function readLedgerFrom(state: ReturnType<typeof openState>): ConflictLedger {
  const raw = state.getMeta(CONFLICT_LEDGER_META_KEY)
  if (raw === null) return new ConflictLedger()
  try {
    return ConflictLedger.fromJSON(raw)
  } catch {
    return new ConflictLedger()
  }
}

async function choose(ctx: CommandContext, record: ConflictRecord): Promise<string> {
  if (ctx.flags.keepLocal) return 'keep-local'
  if (ctx.flags.keepRemote) return 'keep-remote'
  if (ctx.flags.editor) return 'editor'
  const choice = await askChoice(
    ctx,
    `Conflict ${displayPath(ctx.home, record.sourcePath)}:`,
    [
      { key: 'l', label: 'keep local' },
      { key: 'r', label: 'keep remote' },
      { key: 'o', label: 'open editor' },
      { key: 's', label: 'skip' },
    ],
    'l',
  )
  return { l: 'keep-local', r: 'keep-remote', o: 'editor', s: 'skip' }[choice] ?? 'skip'
}

function applyChoice(
  ctx: CommandContext,
  applier: Applier,
  record: ConflictRecord,
  choice: string,
  location: { sourcePath: string; copyPath: string; storePath: string; surface: Surface },
): void {
  const { sourcePath, copyPath, storePath, surface } = location
  const copyFingerprint = applier.fingerprint(copyPath)
  const removeCopy = (): void =>
    applier.remove({
      storePath: record.path,
      surfaceId: surface.id,
      declaredPath: copyPath,
      expected: copyFingerprint,
    })
  if (choice === 'keep-local') {
    removeCopy()
    return
  }
  const expected = applier.fingerprint(sourcePath)
  const local = expected === null ? null : fs.readFileSync(sourcePath, 'utf8')
  const remote = applyTransforms({
    surface,
    storePath,
    direction: 'fromStore',
    tokenEnv: adapterContext(ctx),
    content: fs.readFileSync(copyPath, 'utf8'),
    localContent: local,
    localBlocks: usesMarkerBlocks(surface, storePath)
      ? local === null
        ? applier.state.getMarkers(sourcePath)
        : parseLocalBlocks(sourcePath, local)
      : [],
  }).content
  let content = remote
  if (choice === 'editor') {
    if (isBinary(local ?? '') || isBinary(remote))
      throw cliError('binary-conflict', 'Choose keep-local or keep-remote for a binary conflict')
    const dir = fs.mkdtempSync(path.join(path.dirname(applier.state.path), 'resolve-'))
    const draft = path.join(dir, path.basename(sourcePath))
    try {
      fs.writeFileSync(draft, markerText(local ?? '', remote, record), { mode: 0o600 })
      const editor = ctx.env.EDITOR ?? ctx.env.VISUAL ?? 'vi'
      const result = spawnSync(editor, [draft], { stdio: 'inherit' })
      if (result.error !== undefined || result.status !== 0)
        throw cliError('editor-failed', 'The editor did not finish successfully; conflict retained')
      content = fs.readFileSync(draft, 'utf8')
      if (/^(?:<<<<<<< |=======|>>>>>>> )/m.test(content))
        throw cliError(
          'unresolved-conflict',
          'Remove conflict markers before saving; conflict retained',
        )
      applyTransforms({
        surface,
        storePath,
        direction: 'toStore',
        tokenEnv: adapterContext(ctx),
        content,
      })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  applier.write({ storePath, declaredPath: sourcePath, content, expected })
  removeCopy()
}
