import { type DevicePolicy, type FileResolution, SyncLoop } from '@laurencio/core'
import { loadCliConfig } from '../config'
import { adapterContext, type CommandContext } from '../context'
import { readPause } from '../pause'
import { buildPlan, planSummary } from '../plan'
import { ok } from '../result'
import { adaptersFor, openSession, openState, scanInventory } from '../session'
import { displayPath, plural, table } from '../ui'
import type { CommandSpec } from './command'

export interface SyncData {
  dryRun: boolean
  status: string
  revisionId: string | null
  changed: string[]
  uploaded: number
  downloaded: number
  conflicts: string[]
  blocked: string[]
  deferred: string[]
  queue: { replayed: number; failed: number; pending: number; offline: boolean }
  plan: {
    counts: Record<FileResolution, number>
    files: { storePath: string; resolution: string; surfaceId: string }[]
  } | null
  error: { name: string; message: string; code: string | null } | null
}

function renderPlan(ctx: CommandContext, data: SyncData): string {
  const plan = data.plan
  if (plan === null) return ''
  const lines: string[] = []
  const counts = Object.entries(plan.counts).filter(([, value]) => value > 0)
  lines.push(
    `Plan: ${counts.map(([kind, value]) => `${value} ${kind}`).join(', ') || 'nothing to do'}`,
  )
  const rows = plan.files
    .filter((file) => file.resolution !== 'unchanged')
    .slice(0, 50)
    .map((file) => [file.resolution, file.surfaceId, displayPath(ctx.home, file.storePath)])
  if (rows.length > 0) {
    lines.push(table(rows, { header: ['ACTION', 'SURFACE', 'PATH'] }))
  }
  if (plan.files.filter((file) => file.resolution !== 'unchanged').length > 50) {
    lines.push('  and more, JSON output lists every file')
  }
  return lines.join('\n')
}

function renderSync(ctx: CommandContext, data: SyncData): string {
  const lines: string[] = []
  if (data.dryRun) {
    lines.push('Dry run, nothing was written.')
    lines.push(renderPlan(ctx, data))
    return lines.join('\n').trimEnd()
  }
  const revision = data.revisionId === null ? '' : ` revision ${data.revisionId}`
  lines.push(`Sync ${data.status}${revision}`)
  lines.push(
    `${data.uploaded} uploaded, ${data.downloaded} downloaded, ${plural(data.changed.length, 'file')} changed`,
  )
  if (data.conflicts.length > 0) {
    lines.push(`Conflicts: ${data.conflicts.length}`)
    for (const path of data.conflicts) lines.push(`  ${displayPath(ctx.home, path)}`)
    lines.push('  Run `laurencio resolve` to settle them.')
  }
  if (data.blocked.length > 0) {
    lines.push(`Blocked by the secret scan: ${data.blocked.length}`)
    for (const path of data.blocked.slice(0, 10)) lines.push(`  ${path}`)
  }
  if (data.deferred.length > 0) {
    lines.push(`Deferred while files are busy: ${data.deferred.length}`)
  }
  if (data.queue.pending > 0) lines.push(`Queued operations: ${data.queue.pending}`)
  if (data.error !== null) lines.push(`Error: ${data.error.message}`)
  const paused = readPause(ctx.home)
  if (paused !== null) lines.push('Note: the daemon is paused; this manual run still applied.')
  return lines.join('\n')
}

export const syncCommand: CommandSpec = {
  name: 'sync',
  summary: 'Run one sync pass',
  usage: 'laurencio sync [--dry-run] [--prune] [--harness <id>]... [--json]',
  async run(ctx) {
    const session = await openSession(ctx)
    const policy = loadCliConfig(ctx.home).policy
    // `--prune` is a run-level override of the device policy, never persisted.
    const runPolicy: DevicePolicy = ctx.flags.prune ? { ...policy, prune: true } : policy
    const state = openState(ctx)
    try {
      if (ctx.flags.dryRun) {
        const inventory = scanInventory(ctx, { policy: runPolicy })
        const bundle = await buildPlan(session, inventory, {
          state,
          ignore: runPolicy.ignore,
          prune: runPolicy.prune,
        })
        const counts = planSummary(bundle.plan)
        const data: SyncData = {
          dryRun: true,
          status: 'planned',
          revisionId: null,
          changed: [],
          uploaded: 0,
          downloaded: 0,
          conflicts: [],
          blocked: [],
          deferred: [],
          queue: { replayed: 0, failed: 0, pending: state.listPendingOps().length, offline: false },
          plan: {
            counts,
            files: bundle.plan.files.map((file) => ({
              storePath: file.storePath,
              resolution: file.resolution,
              surfaceId: file.surfaceId,
            })),
          },
          error: null,
        }
        return ok(data, () => renderSync(ctx, data))
      }

      const loop = new SyncLoop({
        adapters: adaptersFor(ctx, runPolicy),
        ctx: adapterContext(ctx),
        deviceId: session.identity.deviceId,
        storeId: session.credentials.storeId,
        key: session.credentials.key,
        state,
        remote: session.remote,
        policy: runPolicy,
        ...(ctx.deps.quiescence === undefined ? {} : { quiescence: ctx.deps.quiescence }),
        ...(ctx.deps.createRevisionId === undefined
          ? {}
          : { createRevisionId: ctx.deps.createRevisionId }),
        now: ctx.now,
      })
      const result = await loop.runOnce()
      const data: SyncData = {
        dryRun: false,
        status: result.status,
        revisionId: result.report?.revisionId ?? null,
        changed: result.report?.changed ?? [],
        uploaded: result.report?.uploaded ?? 0,
        downloaded: result.report?.downloaded ?? 0,
        conflicts: result.report?.conflicts.map((conflict) => conflict.path) ?? [],
        blocked: result.report?.blocked ?? [],
        deferred: result.report?.deferred ?? [],
        queue: {
          replayed: result.queue.replayed.length,
          failed: result.queue.failed.length,
          pending: result.queue.pending,
          offline: result.queue.offline,
        },
        plan: null,
        error: result.error,
      }
      const exitCode =
        data.conflicts.length > 0
          ? 2
          : result.status === 'synced' || result.status === 'idle'
            ? 0
            : 1
      return ok(data, () => renderSync(ctx, data), exitCode)
    } finally {
      state.close()
    }
  },
}
