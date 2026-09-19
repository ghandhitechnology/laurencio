import { effectiveAdapters, loadCliConfig, surfaceEnabled } from '../config'
import { adapterContext, type CommandContext } from '../context'
import { ok } from '../result'
import { scanInventory, withProbes } from '../session'
import { displayPath, plural, table } from '../ui'
import type { CommandSpec } from './command'

export interface SurfaceRow {
  id: string
  harness: string
  policy: string
  enabled: boolean
  kind: string
  declaredPath: string
  description: string
  exists: boolean
  files: number
  bytes: number
  role: string
  owner: string
  linkedBy: string[]
}

export interface HarnessRow {
  id: string
  displayName: string
  installed: boolean
  version: string | null
  configRoots: string[]
  notes: string[]
}

export interface SurfacesData {
  harnesses: HarnessRow[]
  surfaces: SurfaceRow[]
}

export async function collectSurfaces(ctx: CommandContext): Promise<SurfacesData> {
  ctx = withProbes(ctx)
  const config = loadCliConfig(ctx.home)
  const all = scanInventory(ctx, { policy: config.policy, mode: 'all' })
  const effective = effectiveAdapters(all.adapters, config.policy)
  const enabledIds = new Set<string>()
  for (const adapter of effective) {
    for (const surface of adapter.surfaces(adapterContext(ctx))) enabledIds.add(surface.id)
  }

  const reportById = new Map<string, (typeof all.scan.surfaces)[number]>(
    all.scan.surfaces.map((report) => [String(report.surfaceId), report]),
  )
  const surfaces: SurfaceRow[] = []
  for (const surface of all.surfaces.values()) {
    const report = reportById.get(surface.id)
    surfaces.push({
      id: surface.id,
      harness: surface.harness,
      policy: surface.policy,
      enabled: enabledIds.has(surface.id) && surfaceEnabled(config.policy, surface),
      kind: surface.kind,
      declaredPath: surface.path,
      description: surface.description,
      exists: report?.exists ?? false,
      files: report?.files ?? 0,
      bytes: report?.bytes ?? 0,
      role: report?.role ?? 'owner',
      owner: report?.owner ?? surface.id,
      linkedBy: report?.linkedBy ?? [],
    })
  }
  surfaces.sort((a, b) => a.id.localeCompare(b.id))

  const harnesses: HarnessRow[] = all.adapters.map((adapter) => {
    const detection = adapter.detect(adapterContext(ctx))
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      installed: detection.installed,
      version: detection.version ?? null,
      configRoots: detection.configRoots,
      notes: detection.notes,
    }
  })
  return { harnesses, surfaces }
}

function policySummary(surfaces: readonly SurfaceRow[]): string {
  const counts = { sync: 0, 'opt-in': 0, never: 0 }
  for (const surface of surfaces) {
    if (surface.policy === 'sync') counts.sync += 1
    else if (surface.policy === 'opt-in') counts['opt-in'] += 1
    else counts.never += 1
  }
  const enabled = surfaces.filter((surface) => surface.enabled).length
  return `${plural(surfaces.length, 'surface')}: ${counts.sync} sync, ${counts['opt-in']} opt-in, ${counts.never} never, ${enabled} enabled`
}

export function humanSurfaces(ctx: CommandContext, data: SurfacesData): string {
  const lines: string[] = []
  for (const harness of data.harnesses) {
    const version = harness.version === null ? '' : ` ${harness.version}`
    const state = harness.installed ? 'installed' : 'not found'
    lines.push(`${harness.displayName} (${harness.id})${version}  ${state}`)
    for (const note of harness.notes) lines.push(`  ${note}`)
    const rows = data.surfaces
      .filter((surface) => surface.harness === harness.id)
      .map((surface) => [
        surface.id,
        surface.policy,
        surface.enabled ? 'on' : 'off',
        displayPath(ctx.home, surface.declaredPath),
        surface.exists ? String(surface.files) : '-',
      ])
    if (rows.length > 0) {
      lines.push(
        table(rows, { header: ['SURFACE', 'POLICY', 'STATE', 'PATH', 'FILES'], indent: '  ' }),
      )
    }
    lines.push('')
  }
  lines.push(policySummary(data.surfaces))
  return lines.join('\n')
}

export const surfacesCommand: CommandSpec = {
  name: 'surfaces',
  summary: 'Show the surface inventory with policies',
  usage: 'laurencio surfaces [--harness <id>] [--json]',
  async run(ctx) {
    const data = await collectSurfaces(ctx)
    return ok(data, () => humanSurfaces(ctx, data))
  },
}
