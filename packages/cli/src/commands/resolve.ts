import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import {
  Applier,
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  type ConflictRecord,
} from '@laurencio/core'
import { loadCliConfig } from '../config'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
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

export const resolveCommand: CommandSpec = {
  name: 'resolve',
  summary: 'Settle conflict copies by keeping local or remote content',
  usage: 'laurencio resolve [path] [--keep-local|--keep-remote|--editor] [--json]',
  async run(ctx) {
    const selector = ctx.flags.surface ?? ctx.positionals[0] ?? null
    const state = openState(ctx)
    try {
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
      for (const record of all) {
        planPaths.add(record.sourcePath)
        planPaths.add(record.path)
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
        applyChoice(ctx, applier, record, choice)
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
  return askChoice(
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
}

function applyChoice(
  ctx: CommandContext,
  applier: Applier,
  record: ConflictRecord,
  choice: string,
): void {
  const remote = fs.readFileSync(record.path, 'utf8')
  if (choice === 'keep-local') {
    fs.rmSync(record.path, { force: true })
    return
  }
  if (choice === 'keep-remote') {
    applier.write({
      storePath: record.sourcePath,
      declaredPath: record.sourcePath,
      content: remote,
      expected: applier.fingerprint(record.sourcePath),
    })
    fs.rmSync(record.path, { force: true })
    return
  }
  if (choice === 'editor') {
    const local = fs.existsSync(record.sourcePath) ? fs.readFileSync(record.sourcePath, 'utf8') : ''
    if (!isBinary(local) && !isBinary(remote)) {
      applier.write({
        storePath: record.sourcePath,
        declaredPath: record.sourcePath,
        content: markerText(local, remote, record),
        expected: applier.fingerprint(record.sourcePath),
      })
    }
    const editor = ctx.env.EDITOR ?? ctx.env.VISUAL ?? 'vi'
    const result = spawnSync(editor, [record.sourcePath], { stdio: 'inherit' })
    if (result.error !== undefined) {
      throw cliError('editor-failed', `could not open ${editor}: ${result.error.message}`)
    }
    // Whatever the editor left in the file is the local side; the copy is settled.
    fs.rmSync(record.path, { force: true })
    return
  }
}
