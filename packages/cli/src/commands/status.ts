import { type LastSyncRecord, listQueue, readLastSync, secrets } from '@laurencio/core'
import { loadCliConfig } from '../config'
import type { CommandContext } from '../context'
import { readPause } from '../pause'
import { computeDrift, type DriftEntry, localManifestWithProjections, readLedger } from '../plan'
import { ok } from '../result'
import { identityFor, openSession, openState, scanInventory } from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'

export interface StatusData {
  enrolled: boolean
  device: { id: string; name: string } | null
  server: string | null
  daemon: { paused: boolean; pausedAt: string | null }
  lastSync: LastSyncRecord | null
  pending: { count: number; kinds: Record<string, number> }
  conflicts: { count: number; paths: string[] }
  secretOverrides: number
  drift: DriftEntry[] | null
}

function humanStatus(ctx: CommandContext, data: StatusData): string {
  const lines: string[] = []
  if (data.device === null) {
    lines.push('Device: not signed in')
    lines.push('Run `laurencio init` to sign in and select surfaces.')
    return lines.join('\n')
  }
  lines.push(`Device: ${data.device.name} (${data.device.id})`)
  lines.push(`Server: ${data.server ?? 'none configured'}`)
  if (data.lastSync === null) {
    lines.push('Last sync: never')
  } else {
    const record = data.lastSync
    const detail =
      record.status === 'synced'
        ? `${record.changed} changed, ${record.uploaded} uploaded, ${record.downloaded} downloaded`
        : record.status
    lines.push(`Last sync: ${record.at} (${detail})`)
    if (record.error !== null) lines.push(`  error: ${record.error.message}`)
  }
  lines.push(`Pending: ${plural(data.pending.count, 'operation')}`)
  if (data.conflicts.count > 0) {
    lines.push(`Conflicts: ${data.conflicts.count}`)
    for (const path of data.conflicts.paths) lines.push(`  ${displayPath(ctx.home, path)}`)
    lines.push('  Run `laurencio resolve` to settle them.')
  } else {
    lines.push('Conflicts: none')
  }
  if (data.secretOverrides > 0) lines.push(`Secret overrides: ${data.secretOverrides}`)
  if (data.drift === null) {
    lines.push('Drift: unknown')
  } else if (data.drift.length === 0) {
    lines.push('Drift: none')
  } else {
    lines.push(`Drift: ${plural(data.drift.length, 'file')} changed since the last sync`)
    for (const entry of data.drift.slice(0, 20)) {
      lines.push(`  ${entry.status} ${displayPath(ctx.home, entry.storePath)}`)
    }
    if (data.drift.length > 20) lines.push(`  and ${data.drift.length - 20} more`)
  }
  lines.push(`Daemon: ${data.daemon.paused ? `paused since ${data.daemon.pausedAt}` : 'running'}`)
  return lines.join('\n')
}

export const statusCommand: CommandSpec = {
  name: 'status',
  summary: 'Show device, sync, queue, conflict, and drift state',
  usage: 'laurencio status [--json]',
  async run(ctx) {
    const identity = identityFor(ctx)
    const paused = readPause(ctx.home)
    const config = loadCliConfig(ctx.home)
    const server = ctx.flags.server ?? ctx.env.LAURENCIO_SERVER ?? config.server
    const state = openState(ctx)
    try {
      const pending = listQueue(state)
      const kinds: Record<string, number> = {}
      for (const entry of pending) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1
      const ledger = readLedger(state)
      const conflicts = ledger.records().map((record) => record.sourcePath)
      const secretOverrides = secrets.readOverrideLog(ctx.home).length
      const daemon = { paused: paused !== null, pausedAt: paused?.pausedAt ?? null }

      if (identity === null) {
        const data: StatusData = {
          enrolled: false,
          device: null,
          server,
          daemon,
          lastSync: null,
          pending: { count: pending.length, kinds },
          conflicts: { count: conflicts.length, paths: [] },
          secretOverrides,
          drift: null,
        }
        return ok(data, () => humanStatus(ctx, data), 1)
      }

      const session = await openSession(ctx)
      const lastSync = readLastSync(state)
      const baseId = state.getBaseRevision()
      const base = baseId === null ? null : state.getManifest(baseId)
      const inventory = scanInventory(ctx, { policy: config.policy })
      const drift = computeDrift(localManifestWithProjections(inventory), base)
      const data: StatusData = {
        enrolled: true,
        device: { id: identity.deviceId, name: identity.name },
        server: session.baseUrl ?? server,
        daemon,
        lastSync,
        pending: { count: pending.length, kinds },
        conflicts: { count: conflicts.length, paths: conflicts },
        secretOverrides,
        drift,
      }
      const exitCode =
        conflicts.length > 0 ? 2 : lastSync !== null && lastSync.status === 'failed' ? 1 : 0
      return ok(data, () => humanStatus(ctx, data), exitCode)
    } finally {
      state.close()
    }
  },
}
