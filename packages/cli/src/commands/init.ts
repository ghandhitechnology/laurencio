import fs from 'node:fs'
import os from 'node:os'
import { crypto, type DevicePolicy, loginWithDeviceCode, SyncLoop } from '@laurencio/core'
import { type BackupRoot, createBackup } from '../backup'
import { DEFAULT_SERVER_URL, loadCliConfig, saveCliConfig } from '../config'
import { adapterContext, type CommandContext, remoteDirFlag } from '../context'
import { syncSessionCredentials } from '../credential-sync'
import { deviceApproved, presentDeviceAuthorization } from '../device-auth'
import { enrollMcpSecrets } from '../mcp-enrollment'
import { setStoreKey } from '../passphrase'
import { createTransferProgress } from '../progress'
import { askChoice, askYesNo, readPassphrase } from '../prompt'
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
import { chooseSetupScope, type SetupScope } from '../setup-scope'
import { provisionManagedTools } from '../tools/managed'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'
import { installBackgroundSync } from './daemon'
import { serverReachable } from './login'
import { collectSurfaces, type SurfaceRow, type SurfacesData } from './surfaces'

export interface InitData {
  home: string
  server: string | null
  selection: SetupScope
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
  background?: {
    installed: boolean
    started: boolean
    path: string
    notes: string[]
  }
  managedTools?: { name: string; version: string }[]
}

function surfaceToggle(policy: DevicePolicy, surface: SurfaceRow): 'on' | 'off' {
  const harness = policy.harnesses[surface.harness as 'claude' | 'codex' | 'opencode']
  const existing = harness?.surfaces[surface.id]
  if (existing === 'on' || existing === 'off') return existing
  return surface.policy === 'opt-in' ? 'off' : 'on'
}

function setToggle(
  policy: DevicePolicy,
  surface: Pick<SurfaceRow, 'id' | 'harness'>,
  toggle: 'on' | 'off',
): void {
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
  const lines: string[] = [
    `Laurencio ${ctx.command === 'enroll' ? 'enroll' : 'init'}`,
    `Server: ${data.server ?? 'none'}`,
  ]
  const selections: Record<SetupScope, string> = {
    existing: 'current device choices',
    skills: 'skills only',
    portable: 'portable config; instructions stay local',
    custom: 'custom surfaces',
  }
  lines.push(`Sync selection: ${selections[data.selection]}`)
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
  if (data.background !== undefined) {
    lines.push(
      data.background.started
        ? `Background sync: running (${displayPath(ctx.home, data.background.path)})`
        : `Background sync: installation needs attention (${displayPath(ctx.home, data.background.path)})`,
    )
    lines.push(...data.background.notes.map((note) => `  ${note}`))
  }
  if (data.managedTools !== undefined) {
    lines.push(
      `Managed runtimes: ${data.managedTools.map((tool) => `${tool.name} ${tool.version}`).join(', ') || 'none for this platform'}`,
    )
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
  details: ['Deprecated: use `laurencio enroll` for full-mode setup.'],
  usage:
    'laurencio init [--server <url>] [--device-name <name>] [--passphrase-file <path>] [--yes] [--json]',
  async run(ctx) {
    ctx = withProbes(ctx)
    const config = loadCliConfig(ctx.home)
    const surfacesData: SurfacesData = await collectSurfaces(ctx)
    let identity = identityFor(ctx)
    const selection = await chooseSetupScope(
      ctx,
      config.policy,
      surfacesData.surfaces,
      identity !== null,
    )

    const server =
      ctx.flags.server ??
      ctx.env.LAURENCIO_SERVER ??
      config.server ??
      (remoteDirFlag(ctx) === null ? DEFAULT_SERVER_URL : null)

    let loginStatus: InitData['login']
    let token: string | null = null
    if (identity !== null) {
      loginStatus = 'already-enrolled'
    } else if (server === null || server === '' || !(await serverReachable(ctx, server))) {
      const optIn = await applyOptIn(ctx, selection.policy, surfacesData.surfaces, false)
      const policyPath = saveCliConfig(ctx.home, { server, policy: optIn.policy })
      const data: InitData = {
        home: ctx.home,
        server,
        selection: selection.scope,
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
        onPrompt: (prompt) => presentDeviceAuthorization(ctx, deviceName, prompt),
      })
      deviceApproved(ctx, result.identity.name)
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

    const optIn = await applyOptIn(ctx, selection.policy, surfacesData.surfaces, false)
    const policy = optIn.policy
    const policyPath = saveCliConfig(ctx.home, { server, policy })

    const session = await openSession(ctx)
    const state = openState(ctx)
    let progress: ReturnType<typeof createTransferProgress> | undefined
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
    let managedTools: NonNullable<InitData['managedTools']> | undefined
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
        const replaceRoots: string[] = []
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
          if (choice === 's') setToggle(policy, surface, 'off')
          if (choice === 'r' && report.role === 'owner') {
            replaceRoots.push(report.resolvedPath)
          }
        }

        // A deferred surface stays off after enrollment. Re-scan the effective surfaces so
        // link ownership reflects the policy that this enrollment run will use.
        saveCliConfig(ctx.home, { server, policy })
        const activeInventory = scanInventory(ctx, { policy })
        const roots: BackupRoot[] = activeInventory.scan.surfaces
          .filter(
            (report) =>
              report.exists &&
              report.role === 'owner' &&
              (report.policy === 'sync' || report.policy === 'opt-in'),
          )
          .map((report) => ({ label: report.surfaceId, path: report.resolvedPath }))
        if (roots.length > 0) backup = createBackup(ctx.home, roots, ctx.now()).dir
        for (const root of replaceRoots) fs.rmSync(root, { recursive: true, force: true })
      }

      await enrollMcpSecrets(ctx, session)
      progress = createTransferProgress(ctx.io, ctx.flags.json)
      const loop = new SyncLoop({
        onProgress: progress.update,
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
      progress.finish(result)
      syncData.status = result.status
      syncData.revisionId = result.report?.revisionId ?? null
      syncData.uploaded = result.report?.uploaded ?? 0
      syncData.downloaded = result.report?.downloaded ?? 0
      syncData.changed = result.report?.changed.length ?? 0
      syncData.conflicts = result.report?.conflicts.map((conflict) => conflict.path) ?? []
      syncData.blocked = result.report?.blocked ?? []
      if (result.status === 'synced' || result.status === 'idle') {
        await syncSessionCredentials(ctx, session, state)
        if (ctx.command === 'enroll' && syncData.conflicts.length === 0) {
          managedTools = (await provisionManagedTools(ctx, session)).map((tool) => ({
            name: tool.name,
            version: tool.version,
          }))
        }
      }
    } finally {
      progress?.finish()
      state.close()
    }

    const background =
      ctx.command === 'enroll' &&
      (syncData.status === 'synced' || syncData.status === 'idle') &&
      syncData.conflicts.length === 0
        ? installBackgroundSync(ctx)
        : null
    const data: InitData = {
      home: ctx.home,
      server,
      selection: selection.scope,
      login: loginStatus,
      device: { id: identity.deviceId, name: identity.name },
      key: keyInfo,
      policyPath,
      surfaces: surfacesData.surfaces,
      optIn: { enabled: optIn.enabled, disabled: optIn.disabled },
      backup,
      enrollment,
      sync: syncData,
      ...(managedTools === undefined ? {} : { managedTools }),
      ...(background === null
        ? {}
        : {
            background: {
              installed: background.service.installed,
              started: background.started,
              path: background.service.path,
              notes: background.notes,
            },
          }),
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
