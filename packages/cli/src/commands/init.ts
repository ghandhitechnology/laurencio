import fs from 'node:fs'
import os from 'node:os'
import { crypto, type DevicePolicy, loginWithDeviceCode, SyncLoop } from '@laurencio/core'
import { type BackupRoot, createBackup } from '../backup'
import { loadCliConfig, saveCliConfig } from '../config'
import { adapterContext, type CommandContext, remoteDirFlag } from '../context'
import { setStoreKey } from '../passphrase'
import { askChoice, askLine, askYesNo, interactive, readPassphrase } from '../prompt'
import { ok } from '../result'
import {
  adaptersFor,
  deviceToken,
  identityFor,
  keyCached,
  keychainOptions,
  loadRemoteManifest,
  openRemote,
  openSession,
  openState,
  scanInventory,
  withProbes,
} from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'
import { serverReachable } from './login'
import { collectSurfaces, type SurfaceRow, type SurfacesData } from './surfaces'

export interface InitData {
  home: string
  server: string | null
  login: 'signed-in' | 'already-enrolled' | 'skipped-offline'
  device: { id: string; name: string } | null
  key: { backend: string; cached: boolean } | null
  policyPath: string
  surfaces: SurfaceRow[]
  optIn: { enabled: string[]; disabled: string[] }
  backup: string | null
  enrollment: { surfaceId: string; choice: string }[]
  sync: {
    status: string
    revisionId: string | null
    uploaded: number
    downloaded: number
    changed: number
    conflicts: string[]
    blocked: string[]
  } | null
}

function surfaceToggle(policy: DevicePolicy, surface: SurfaceRow): 'on' | 'off' {
  const harness = policy.harnesses[surface.harness as 'claude' | 'codex' | 'opencode']
  const existing = harness?.surfaces[surface.id]
  if (existing === 'on' || existing === 'off') return existing
  return surface.policy === 'opt-in' ? 'off' : 'on'
}

function setToggle(policy: DevicePolicy, surface: SurfaceRow, toggle: 'on' | 'off'): void {
  const id = surface.harness as 'claude' | 'codex' | 'opencode'
  const existing = policy.harnesses[id] ?? { enabled: true, surfaces: {} }
  existing.surfaces[surface.id] = toggle
  policy.harnesses[id] = existing
}

function copyPolicy(policy: DevicePolicy): DevicePolicy {
  const harnesses: DevicePolicy['harnesses'] = {}
  for (const [id, harness] of Object.entries(policy.harnesses)) {
    if (harness === undefined) continue
    harnesses[id as 'claude' | 'codex' | 'opencode'] = {
      enabled: harness.enabled,
      surfaces: { ...harness.surfaces },
    }
  }
  return {
    version: policy.version,
    harnesses,
    ignore: [...policy.ignore],
    prune: policy.prune,
    cadence: { ...policy.cadence },
  }
}

/**
 * Writes an explicit toggle for every opt-in surface, and for sync surfaces
 * that already carry one. Explicit toggles are what makes opt-in genuinely
 * opt-in for the engine, which otherwise treats opt-in as syncable.
 */
async function applyOptIn(
  ctx: CommandContext,
  policy: DevicePolicy,
  surfaces: readonly SurfaceRow[],
  ask: boolean,
): Promise<{ policy: DevicePolicy; enabled: string[]; disabled: string[] }> {
  const next = copyPolicy(policy)
  const enabled: string[] = []
  const disabled: string[] = []
  for (const surface of surfaces) {
    const hasToggle =
      policy.harnesses[surface.harness as 'claude' | 'codex' | 'opencode']?.surfaces[surface.id] !==
      undefined
    if (surface.policy !== 'opt-in' && !hasToggle) continue
    let toggle = surfaceToggle(policy, surface)
    if (surface.policy === 'opt-in' && ask) {
      const wants = await askYesNo(
        ctx,
        `Enable opt-in surface ${surface.id} (${surface.description})?`,
        toggle === 'on',
      )
      toggle = wants ? 'on' : 'off'
    }
    setToggle(next, surface, toggle)
    if (surface.policy === 'opt-in') {
      if (toggle === 'on') enabled.push(surface.id)
      else disabled.push(surface.id)
    }
  }
  return { policy: next, enabled, disabled }
}

function remoteCountsBySurface(
  manifest: { entries: { surfaceId: string; kind: string }[] } | null,
): Map<string, number> {
  const counts = new Map<string, number>()
  for (const entry of manifest?.entries ?? []) {
    if (entry.kind !== 'file') continue
    counts.set(entry.surfaceId, (counts.get(entry.surfaceId) ?? 0) + 1)
  }
  return counts
}

function inventorySummary(surfaces: readonly SurfaceRow[]): string {
  const counts = { sync: 0, 'opt-in': 0, never: 0 }
  for (const surface of surfaces) counts[surface.policy as 'sync' | 'opt-in' | 'never'] += 1
  return `${plural(surfaces.length, 'surface')}: ${counts.sync} sync, ${counts['opt-in']} opt-in, ${counts.never} never`
}

function harnessInventory(surfaces: readonly SurfaceRow[]): string[] {
  const byHarness = new Map<string, { total: number; sync: number; optIn: number; never: number }>()
  for (const surface of surfaces) {
    const counts = byHarness.get(surface.harness) ?? { total: 0, sync: 0, optIn: 0, never: 0 }
    counts.total += 1
    if (surface.policy === 'sync') counts.sync += 1
    else if (surface.policy === 'opt-in') counts.optIn += 1
    else counts.never += 1
    byHarness.set(surface.harness, counts)
  }
  return [...byHarness.entries()].map(
    ([harness, counts]) =>
      `  ${harness}: ${counts.total} surfaces, ${counts.sync} sync, ${counts.optIn} opt-in, ${counts.never} never`,
  )
}

function humanInit(ctx: CommandContext, data: InitData): string {
  const lines: string[] = ['Laurencio init', `Server: ${data.server ?? 'none'}`]
  lines.push('Surfaces')
  lines.push(...harnessInventory(data.surfaces))
  lines.push(`  Total: ${inventorySummary(data.surfaces)}`)
  if (data.optIn.enabled.length > 0) lines.push(`Opt-in on: ${data.optIn.enabled.join(', ')}`)
  if (data.optIn.disabled.length > 0) lines.push(`Opt-in off: ${data.optIn.disabled.join(', ')}`)
  lines.push(
    `Sign-in: ${
      data.login === 'signed-in'
        ? 'signed in with the device flow'
        : data.login === 'already-enrolled'
          ? 'this device is already signed in'
          : 'skipped, the server is not reachable'
    }`,
  )
  if (data.device !== null) lines.push(`Device: ${data.device.name} (${data.device.id})`)
  if (data.key !== null) lines.push(`Store key: cached in the ${data.key.backend}`)
  lines.push(`Policy: ${displayPath(ctx.home, data.policyPath)}`)
  if (data.backup !== null) lines.push(`Backup: ${displayPath(ctx.home, data.backup)}`)
  if (data.enrollment.length > 0) {
    lines.push(
      `Enrollment: ${data.enrollment.map((row) => `${row.surfaceId} ${row.choice}`).join(', ')}`,
    )
  }
  if (data.sync === null) {
    lines.push('', 'Login skipped. Run `laurencio login` when the server is reachable.')
    return lines.join('\n')
  }
  lines.push('')
  if (data.sync.status === 'idle') {
    lines.push('Sync: already up to date')
  } else {
    lines.push(
      `Sync ${data.sync.status}: ${data.sync.uploaded} uploaded, ${data.sync.downloaded} downloaded, ${plural(data.sync.changed, 'file')} changed`,
    )
  }
  if (data.sync.conflicts.length > 0) {
    lines.push(`Conflicts: ${data.sync.conflicts.length}, run \`laurencio resolve\``)
  }
  if (data.sync.blocked.length > 0) {
    lines.push(`Blocked by the secret scan: ${data.sync.blocked.length}`)
  }
  lines.push('', 'Next: `laurencio status`')
  return lines.join('\n')
}

export const initCommand: CommandSpec = {
  name: 'init',
  summary: 'Set up this device: sign in, select surfaces, and push',
  usage:
    'laurencio init [--server <url>] [--device-name <name>] [--passphrase-file <path>] [--yes] [--json]',
  async run(ctx) {
    ctx = withProbes(ctx)
    const config = loadCliConfig(ctx.home)
    const surfacesData: SurfacesData = await collectSurfaces(ctx)

    let server = ctx.flags.server ?? ctx.env.LAURENCIO_SERVER ?? config.server
    if ((server === null || server === '') && interactive(ctx) && remoteDirFlag(ctx) === null) {
      server = (await askLine(ctx, 'Server URL:', '')).trim()
      if (server === '') server = null
    }

    let identity = identityFor(ctx)
    let loginStatus: InitData['login']
    let token: string | null = null
    if (identity !== null) {
      loginStatus = 'already-enrolled'
    } else if (server === null || server === '' || !(await serverReachable(ctx, server))) {
      const optIn = await applyOptIn(ctx, config.policy, surfacesData.surfaces, false)
      const policyPath = saveCliConfig(ctx.home, { server, policy: optIn.policy })
      const data: InitData = {
        home: ctx.home,
        server,
        login: 'skipped-offline',
        device: null,
        key: null,
        policyPath,
        surfaces: surfacesData.surfaces,
        optIn: { enabled: optIn.enabled, disabled: optIn.disabled },
        backup: null,
        enrollment: [],
        sync: null,
      }
      return ok(data, () => humanInit(ctx, data), 0)
    } else {
      const deviceName = ctx.flags.deviceName ?? ctx.flags.name ?? os.hostname()
      const result = await loginWithDeviceCode({
        ...keychainOptions(ctx),
        baseUrl: server,
        deviceName,
        platform: ctx.platform,
        ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
        onPrompt: (prompt) => {
          const line = `Open ${prompt.verificationUri} and enter code ${prompt.userCode}`
          if (ctx.flags.json) ctx.io.err(line)
          else ctx.io.out(line)
        },
      })
      identity = result.identity
      token = result.token
      loginStatus = 'signed-in'
    }
    saveCliConfig(ctx.home, { ...config, server })

    // Passphrase setup: cache the store key when this device has none.
    let keyInfo: InitData['key'] = null
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    if (await keyCached(ctx, identity.storeId)) {
      keyInfo = { backend: cache.backend, cached: true }
    } else {
      token = token ?? (await deviceToken(ctx, identity.deviceId))
      const remote = await openRemote(ctx, { storeId: identity.storeId, token, baseUrl: server })
      const existingKdf = await remote.getKdfParams()
      const passphrase = await readPassphrase(ctx, { confirm: existingKdf === null })
      const setup = await setStoreKey(ctx, {
        remote,
        storeId: identity.storeId,
        token,
        baseUrl: server,
        passphrase,
      })
      keyInfo = { backend: setup.backend, cached: true }
    }

    const optIn = await applyOptIn(ctx, config.policy, surfacesData.surfaces, interactive(ctx))
    const policy = optIn.policy
    const policyPath = saveCliConfig(ctx.home, { server, policy })

    const session = await openSession(ctx)
    const state = openState(ctx)
    let backup: string | null = null
    const enrollment: InitData['enrollment'] = []
    const syncData: NonNullable<InitData['sync']> = {
      status: 'idle',
      revisionId: null,
      uploaded: 0,
      downloaded: 0,
      changed: 0,
      conflicts: [],
      blocked: [],
    }
    try {
      const page = await session.remote.listRevisions()
      const firstEnrollment = page.head !== null && state.getBaseRevision() === null
      const view = firstEnrollment ? await loadRemoteManifest(session, null) : { manifest: null }
      const remoteCounts = remoteCountsBySurface(view.manifest)
      const inventory = scanInventory(ctx, { policy: optIn.policy, mode: 'all' })
      const activeIds = new Set(
        adaptersFor(ctx, optIn.policy).flatMap((adapter) =>
          adapter.surfaces(adapterContext(ctx)).map((surface) => surface.id),
        ),
      )
      if (firstEnrollment) {
        const roots: BackupRoot[] = inventory.scan.surfaces
          .filter((report) => report.exists && activeIds.has(report.surfaceId))
          .map((report) => ({ label: report.surfaceId, path: report.resolvedPath }))
        if (roots.length > 0) backup = createBackup(ctx.home, roots, ctx.now()).dir
        for (const surface of inventory.surfaces.values()) {
          if (!activeIds.has(surface.id)) continue
          const report = inventory.scan.surfaces.find((item) => item.surfaceId === surface.id)
          if (report === undefined || !report.exists || report.files + report.links === 0) continue
          if ((remoteCounts.get(surface.id) ?? 0) === 0) continue
          const choice = await askChoice(
            ctx,
            `Enroll ${surface.id}:`,
            [
              { key: 'm', label: 'merge with remote' },
              { key: 'r', label: 'replace this device' },
              { key: 's', label: 'decide later' },
            ],
            'm',
          )
          enrollment.push({ surfaceId: surface.id, choice })
          if (choice === 'r' && report.role === 'owner') {
            fs.rmSync(report.resolvedPath, { recursive: true, force: true })
          }
        }
      }

      const loop = new SyncLoop({
        adapters: adaptersFor(ctx, optIn.policy),
        ctx: adapterContext(ctx),
        deviceId: identity.deviceId,
        storeId: session.credentials.storeId,
        key: session.credentials.key,
        state,
        remote: session.remote,
        policy: optIn.policy,
        ...(ctx.deps.quiescence === undefined ? {} : { quiescence: ctx.deps.quiescence }),
        ...(ctx.deps.createRevisionId === undefined
          ? {}
          : { createRevisionId: ctx.deps.createRevisionId }),
        now: ctx.now,
      })
      const result = await loop.runOnce()
      syncData.status = result.status
      syncData.revisionId = result.report?.revisionId ?? null
      syncData.uploaded = result.report?.uploaded ?? 0
      syncData.downloaded = result.report?.downloaded ?? 0
      syncData.changed = result.report?.changed.length ?? 0
      syncData.conflicts = result.report?.conflicts.map((conflict) => conflict.path) ?? []
      syncData.blocked = result.report?.blocked ?? []
    } finally {
      state.close()
    }

    const data: InitData = {
      home: ctx.home,
      server,
      login: loginStatus,
      device: { id: identity.deviceId, name: identity.name },
      key: keyInfo,
      policyPath,
      surfaces: surfacesData.surfaces,
      optIn: { enabled: optIn.enabled, disabled: optIn.disabled },
      backup,
      enrollment,
      sync: syncData,
    }
    const exitCode =
      syncData.conflicts.length > 0
        ? 2
        : syncData.status === 'failed' || syncData.status === 'offline'
          ? 1
          : 0
    return ok(data, () => humanInit(ctx, data), exitCode)
  },
}
