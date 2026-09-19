/**
 * Read-only scan demo: registers the real OpenCode adapter plus inline placeholders for the
 * harnesses whose phases have not shipped, and prints the surface inventory, ownership, and
 * link topology for this machine. Never writes to disk.
 *
 * Usage:
 *   bun run scan:demo
 *   bun run scan:demo -- --json
 *   bun run scan:demo -- --harness opencode --json
 *   bun run scan:demo -- --home /tmp/scratch-home --json
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { builtinAdapters } from '../packages/core/src/adapters/registry'
import { type DetectionReport, detectionReport } from '../packages/core/src/adapters/types'
import { type ScanResult, scan } from '../packages/core/src/scan'
import type {
  AdapterContext,
  HarnessAdapter,
  HarnessId,
  HarnessProbe,
  Surface,
  TreeSurface,
} from '../packages/core/src/types'
import { DeviceId, RevisionId, SurfaceId } from '../packages/protocol/src/ids'

interface DemoOptions {
  json: boolean
  harness: HarnessId | null
  home: string
}

function usage(): never {
  console.error(
    'usage: bun run scan:demo [--json] [--harness claude|codex|opencode] [--home <dir>]',
  )
  process.exit(1)
}

function parseArgs(argv: string[]): DemoOptions {
  let json = false
  let harness: HarnessId | null = null
  let home = os.homedir()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      json = true
      continue
    }
    if (flag === '--harness' || flag === '--home') {
      const value = argv[index + 1]
      if (value === undefined) usage()
      if (flag === '--harness') {
        if (value !== 'claude' && value !== 'codex' && value !== 'opencode') usage()
        harness = value
      } else {
        home = path.resolve(value.replace(/^~(?=\/|$)/, os.homedir()))
      }
      index += 1
      continue
    }
    usage()
  }
  return { json, harness, home }
}

function demoTree(
  harness: HarnessId,
  id: string,
  treePath: string,
  options: { exclude?: string[]; policy?: TreeSurface['policy']; shared?: boolean } = {},
): Surface {
  return {
    id: SurfaceId.parse(`${harness}.${id}`),
    harness,
    kind: 'tree',
    path: treePath,
    policy: options.policy ?? 'sync',
    description: `${harness} ${id} (demo)`,
    format: 'mixed',
    merge: 'text3way',
    exclude: options.exclude ?? [],
    transforms: [],
    secretRules: [],
    ...(options.shared === true ? { shared: true as const } : {}),
  }
}

function demoFile(
  harness: HarnessId,
  id: string,
  filePath: string,
  options: { policy?: Surface['policy']; format?: 'json' | 'markdown' | 'toml' } = {},
): Surface {
  return {
    id: SurfaceId.parse(`${harness}.${id}`),
    harness,
    kind: 'file',
    path: filePath,
    policy: options.policy ?? 'sync',
    description: `${harness} ${id} (demo)`,
    format: options.format ?? 'text',
    merge: 'text3way',
    transforms: [],
    secretRules: [],
  }
}

/** Static detection: the demo adapters do no I/O, so they report what they declare. */
function demoDetection(adapterId: HarnessId, configRoot: string): HarnessAdapter['detect'] {
  return () => ({
    installed: true,
    version: 'demo',
    configRoots: [configRoot],
    notes: [`${adapterId} demo adapter: placeholder surface map`],
  })
}

/** Version probe at the CLI edge; adapters stay pure. */
function commandVersion(command: string): string | null {
  try {
    const result = Bun.spawnSync({
      cmd: [command, '--version'],
      stdout: 'pipe',
      stderr: 'ignore',
    })
    if (result.exitCode !== 0) return null
    const lines = new TextDecoder().decode(result.stdout).split('\n')
    for (const line of lines) {
      const match = /\bv?(\d[\w.-]*)/.exec(line.trim())
      if (match?.[1] !== undefined) return match[1]
    }
    return null
  } catch {
    return null
  }
}

/** Probe: both binaries plus the config-dir file shapes the schema report keys off. */
function opencodeProbe(home: string): HarnessProbe {
  const notes: string[] = []
  let version: string | undefined
  for (const binary of ['opencode', 'opencode2'] as const) {
    const reported = commandVersion(binary)
    if (reported === null) continue
    notes.push(`${binary} ${reported}`)
    if (binary === 'opencode') version = reported
  }
  const configRoot = path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
    'opencode',
  )
  try {
    for (const name of fs.readdirSync(configRoot)) notes.push(`config:${name}`)
  } catch {
    // No config dir: the probe reports absence through the empty notes.
  }
  return {
    installed: notes.length > 0,
    ...(version === undefined ? {} : { version }),
    notes,
  }
}

const adapters: HarnessAdapter[] = [
  ...builtinAdapters,
  {
    id: 'codex',
    displayName: 'Codex CLI (demo)',
    detect: demoDetection('codex', '$HOME/.codex'),
    surfaces: () => [
      demoFile('codex', 'config', '$HOME/.codex/config.toml', { format: 'toml' }),
      demoFile('codex', 'instructions', '$HOME/.codex/AGENTS.md', { format: 'markdown' }),
      demoTree('codex', 'skills', '$HOME/.codex/skills', { exclude: ['**/node_modules/**'] }),
      demoFile('codex', 'auth', '$HOME/.codex/auth.json', { policy: 'never' }),
    ],
  },
]

function report(result: ScanResult, detections: DetectionReport[]): void {
  console.log('Laurencio scan demo (read-only)')
  console.log(`home: ${result.home} (${result.platform})`)
  console.log('')
  console.log('detected:')
  for (const detection of detections) {
    console.log(
      `  ${detection.adapterId.padEnd(10)} ${detection.version ?? 'unknown'}  ${detection.configRoots.join(', ')}`,
    )
  }
  console.log('')
  console.log('surfaces:')
  for (const surface of result.surfaces) {
    const role = surface.role === 'reference' ? `ref->${surface.owner}` : 'owner'
    const state = surface.exists ? `${surface.files}f/${surface.bytes}b` : 'missing'
    console.log(
      `  ${surface.surfaceId.padEnd(28)} ${surface.policy.padEnd(6)} ${role.padEnd(18)} ${state.padEnd(12)} ${surface.declaredPath}`,
    )
    if (surface.links > 0 || surface.excluded > 0 || surface.nested > 0 || surface.errors > 0) {
      console.log(
        `    links=${surface.links} excluded=${surface.excluded} nested=${surface.nested} errors=${surface.errors}`,
      )
    }
  }
  console.log('')
  console.log(`ownership refs: ${result.ownership.length}`)
  for (const ref of result.ownership) {
    console.log(`  ${ref.surfaceId} <- ${ref.referencedBy.join(', ')} (${ref.resolvedPath})`)
  }
  console.log('')
  console.log(`layout links: ${result.layout.entries.length}`)
  for (const entry of result.layout.entries) {
    console.log(`  ${entry.path} -> ${entry.linkTarget ?? ''}`)
  }
  const linked = result.entries.filter((entry) => entry.linkedSurfaceId !== null)
  console.log('')
  console.log(`links into declared surfaces: ${linked.length}`)
  for (const entry of linked) {
    console.log(`  ${entry.localPath} -> ${entry.linkedSurfaceId}`)
  }
  console.log('')
  console.log(
    `manifest: ${result.manifest.entries.length} files, ${result.surfaces.reduce((sum, surface) => sum + surface.bytes, 0)} bytes`,
  )
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const selected =
    options.harness === null
      ? adapters
      : adapters.filter((adapter) => adapter.id === options.harness)
  if (selected.length === 0) usage()
  if (!fs.existsSync(options.home)) {
    console.error(`home does not exist: ${options.home}`)
    process.exit(1)
  }
  const ctx: AdapterContext = {
    home: options.home,
    platform:
      process.platform === 'win32' ? 'win32' : process.platform === 'linux' ? 'linux' : 'darwin',
    env: { ...process.env },
    probes: { opencode: opencodeProbe(options.home) },
  }
  const detections = selected.map((adapter) => detectionReport(adapter, ctx))
  const result = scan({
    adapters: selected,
    ctx,
    deviceId: DeviceId.parse('00000000000000000000000000'),
    revisionId: RevisionId.parse('00000000000000000000000000'),
    createdAt: new Date().toISOString(),
  })
  if (options.json) {
    console.log(JSON.stringify({ detections, ...result }, null, 2))
    return
  }
  report(result, detections)
}

main()
