import fs from 'node:fs'
import { crypto, openTokenStore, secrets } from '@laurencio/core'
import { PROTOCOL_VERSION, type StoreId } from '@laurencio/protocol'
import { loadCliConfig } from '../config'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
import { readKeyEpoch, readPendingRotation } from '../key-epoch'
import { hasMarkerBlocks, projectedContent } from '../layout'
import { readPause } from '../pause'
import { ok } from '../result'
import {
  baseUrlFor,
  deviceToken,
  identityFor,
  keychainOptions,
  type LocalInventory,
  openRemote,
  openState,
  scanInventory,
  withProbes,
} from '../session'
import { displayPath, plural } from '../ui'
import { CLI_VERSION } from '../version'
import type { CommandSpec } from './command'
import { collectSurfaces, type HarnessRow, type SurfacesData } from './surfaces'

export interface TopologyRow {
  surfaceId: string
  role: string
  owner: string
  declaredPath: string
  resolvedPath: string
  linkedBy: string[]
  exists: boolean
}

export interface NeverRow {
  surfaceId: string
  declaredPath: string
  reason: string
  files: number
}

export interface SecretRow {
  path: string
  rule: string
  severity: string
  line: number | null
}

export interface KdfDoctorRow {
  /** Store generation from the remote, or null when it cannot be read. */
  generation: number | null
  /** Generation this device's cached key was derived from, when recorded. */
  localEpoch: number | null
  /** A committed rotation whose parameters are not published yet. */
  pendingPublish: boolean
}

export interface DoctorData {
  version: string
  protocolVersion: number
  platform: string
  home: string
  server: string | null
  enrolled: boolean
  deviceId: string | null
  deviceName: string | null
  daemonPaused: boolean
  keychain: string
  keyCached: boolean | null
  kdf: KdfDoctorRow
  harnesses: HarnessRow[]
  topology: TopologyRow[]
  neverSync: NeverRow[]
  secrets: { scannedFiles: number; findings: SecretRow[]; truncated: boolean }
}

const SECRET_SCAN_MAX_BYTES = 20 * 1024 * 1024
const SECRET_SCAN_MAX_FILES = 2000

function collectTopology(inventory: LocalInventory): TopologyRow[] {
  const reports = new Map<string, LocalInventory['scan']['surfaces'][number]>(
    inventory.scan.surfaces.map((report) => [String(report.surfaceId), report]),
  )
  const rows: TopologyRow[] = []
  for (const [surfaceId, surface] of inventory.surfaces) {
    const report = reports.get(surfaceId)
    if (report === undefined) continue
    rows.push({
      surfaceId,
      role: report.role,
      owner: report.owner,
      declaredPath: surface.path,
      resolvedPath: report.resolvedPath,
      linkedBy: report.linkedBy,
      exists: report.exists,
    })
  }
  return rows.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
}

function collectNeverSync(inventory: LocalInventory): NeverRow[] {
  const bySurface = new Map<string, number>()
  for (const entry of inventory.scan.entries) {
    if (entry.classification !== 'never') continue
    if (entry.kind !== 'file') continue
    bySurface.set(entry.surfaceId, (bySurface.get(entry.surfaceId) ?? 0) + 1)
  }
  const rows: NeverRow[] = []
  for (const [surfaceId, surface] of inventory.surfaces) {
    if (surface.policy !== 'never') continue
    rows.push({
      surfaceId,
      declaredPath: surface.path,
      reason: surface.description,
      files: bySurface.get(surfaceId) ?? 0,
    })
  }
  return rows.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
}

interface ScanHit {
  path: string
  content: string
}

function secretScan(inventory: LocalInventory): DoctorData['secrets'] {
  const hits: ScanHit[] = []
  let bytes = 0
  let truncated = false
  for (const entry of inventory.scan.entries) {
    if (entry.storePath === null) continue
    if (entry.classification !== 'sync' && entry.classification !== 'opt-in') continue
    if (entry.kind !== 'file') continue
    if (hits.length >= SECRET_SCAN_MAX_FILES || bytes >= SECRET_SCAN_MAX_BYTES) {
      truncated = true
      break
    }
    const surface = inventory.surfaces.get(entry.surfaceId)
    let raw: string
    try {
      raw = fs.readFileSync(entry.localPath, 'utf8')
    } catch {
      continue
    }
    const content = hasMarkerBlocks(surface, entry.localPath)
      ? projectedContent(surface, entry.localPath, raw)
      : raw
    bytes += Buffer.byteLength(content)
    hits.push({ path: entry.storePath, content })
  }
  const findings: secrets.SecretFinding[] = []
  for (const hit of hits) findings.push(...secrets.scanText(hit.path, hit.content))
  const rows: SecretRow[] = findings.map((finding) => ({
    path: finding.path,
    rule: finding.rule,
    severity: finding.severity,
    line: finding.line ?? null,
  }))
  rows.sort((a, b) => a.path.localeCompare(b.path) || (a.line ?? 0) - (b.line ?? 0))
  return { scannedFiles: hits.length, findings: rows, truncated }
}

async function keychainStatus(
  ctx: CommandContext,
  storeId: StoreId | null,
): Promise<{ backend: string; cached: boolean | null }> {
  let backend: string
  try {
    const store = await openTokenStore(keychainOptions(ctx))
    backend = store.backend
  } catch {
    backend = 'unavailable'
  }
  if (storeId === null) return { backend, cached: null }
  try {
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const key = await cache.load(storeId)
    if (key === null) return { backend: cache.backend, cached: false }
    key.zeroize()
    return { backend: cache.backend, cached: true }
  } catch {
    return { backend, cached: null }
  }
}

async function kdfStatus(
  ctx: CommandContext,
  identity: ReturnType<typeof identityFor>,
): Promise<KdfDoctorRow> {
  const state = openState(ctx)
  let localEpoch: number | null = null
  let pendingPublish = false
  try {
    localEpoch = readKeyEpoch(state)?.epoch ?? null
    pendingPublish = readPendingRotation(state) !== null
  } finally {
    state.close()
  }
  let generation: number | null = null
  if (identity !== null) {
    try {
      const config = loadCliConfig(ctx.home)
      const token = await deviceToken(ctx, identity.deviceId)
      const remote = await openRemote(ctx, {
        storeId: identity.storeId,
        token,
        baseUrl: baseUrlFor(ctx, config),
      })
      const published = await remote.getKdfParams()
      generation = published?.generation ?? null
    } catch {
      generation = null
    }
  }
  return { generation, localEpoch, pendingPublish }
}

export async function collectDoctor(ctx: CommandContext): Promise<DoctorData> {
  ctx = withProbes(ctx)
  const identity = identityFor(ctx)
  const surfaces: SurfacesData = await collectSurfaces(ctx)
  const config = loadCliConfig(ctx.home)
  const inventory = scanInventory(ctx, { policy: config.policy, mode: 'all' })
  const keychain = await keychainStatus(ctx, identity?.storeId ?? null)
  const kdf = await kdfStatus(ctx, identity)
  const paused = readPause(ctx.home) !== null
  return {
    version: CLI_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform: ctx.platform,
    home: ctx.home,
    server: config.server,
    enrolled: identity !== null,
    deviceId: identity?.deviceId ?? null,
    deviceName: identity?.name ?? null,
    daemonPaused: paused,
    keychain: keychain.backend,
    keyCached: keychain.cached,
    kdf,
    harnesses: surfaces.harnesses,
    topology: collectTopology(inventory),
    neverSync: collectNeverSync(inventory),
    secrets: secretScan(inventory),
  }
}

function section(title: string, body: string[]): string[] {
  if (body.length === 0) return []
  return [title, ...body, '']
}

export function humanDoctor(ctx: CommandContext, data: DoctorData): string {
  const lines: string[] = []
  const device = data.enrolled
    ? `${data.deviceName} (${data.deviceId})`
    : 'not signed in (run `laurencio enroll`)'
  lines.push(
    `Version: ${data.version}  Protocol: v${data.protocolVersion}  Platform: ${data.platform}`,
  )
  lines.push(`Home: ${displayPath(ctx.home, data.home)}`)
  lines.push(`Server: ${data.server ?? 'none configured'}`)
  lines.push(`Device: ${device}`)
  lines.push(
    `Keychain: ${data.keychain}${data.keyCached === null ? '' : data.keyCached ? ', store key cached' : ', store key not cached'}`,
  )
  const localEpoch = data.kdf.localEpoch === null ? 'unknown' : String(data.kdf.localEpoch)
  lines.push(
    data.kdf.generation === null
      ? `KDF: store generation unknown, local epoch ${localEpoch}`
      : `KDF: store generation ${data.kdf.generation}, local epoch ${localEpoch}`,
  )
  if (
    data.kdf.generation !== null &&
    data.kdf.localEpoch !== null &&
    data.kdf.localEpoch < data.kdf.generation
  ) {
    lines.push(
      `Warning: this device key is at epoch ${data.kdf.localEpoch}, the store is at generation ${data.kdf.generation}; run \`laurencio unlock\` with the current passphrase.`,
    )
  }
  if (data.kdf.pendingPublish) {
    lines.push(
      'Warning: a rotation is committed but not published; run `laurencio rotate --resume`.',
    )
  }
  lines.push(`Daemon: ${data.daemonPaused ? 'paused' : 'running'}`)
  lines.push('')

  lines.push(
    ...section(
      'Harnesses',
      data.harnesses.flatMap((harness) => {
        const state = harness.installed
          ? `installed${harness.version === null ? '' : ` ${harness.version}`}`
          : 'not found'
        return [`  ${harness.id}: ${state}`, ...harness.notes.map((note) => `    ${note}`)]
      }),
    ),
  )

  const linked = data.topology.filter((row) => row.role === 'reference')
  lines.push(
    ...section(
      'Link topology',
      linked.length === 0
        ? ['  no surfaces resolve through another surface']
        : linked.map(
            (row) =>
              `  ${row.surfaceId} -> ${row.owner} (${displayPath(ctx.home, row.resolvedPath)})`,
          ),
    ),
  )

  lines.push(
    ...section(
      'Never sync',
      data.neverSync.length === 0
        ? ['  nothing declared']
        : data.neverSync.map(
            (row) =>
              `  ${row.surfaceId} (${row.files} files) ${displayPath(ctx.home, row.declaredPath)}`,
          ),
    ),
  )

  const secretLines =
    data.secrets.findings.length === 0
      ? [`  ${plural(data.secrets.scannedFiles, 'file')} scanned, no findings`]
      : data.secrets.findings
          .slice(0, 20)
          .map(
            (finding) =>
              `  ${finding.path}${finding.line === null ? '' : `:${finding.line}`} ${finding.rule} (${finding.severity})`,
          )
  if (data.secrets.findings.length > 20) {
    secretLines.push(`  and ${data.secrets.findings.length - 20} more`)
  }
  if (data.secrets.truncated) secretLines.push('  scan stopped at the size cap')
  lines.push(...section('Secrets', secretLines))

  return lines.join('\n').trimEnd()
}

export const doctorCommand: CommandSpec = {
  name: 'doctor',
  summary: 'Check harnesses, links, secrets, keychain, and protocol',
  usage: 'laurencio doctor [--json]',
  async run(ctx) {
    try {
      const data = await collectDoctor(ctx)
      return ok(data, () => humanDoctor(ctx, data))
    } catch (error) {
      if (error instanceof Error && error.name === 'PolicyError') {
        throw cliError('bad-config', error.message)
      }
      throw error
    }
  },
}
