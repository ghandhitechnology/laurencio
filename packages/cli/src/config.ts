/**
 * `~/.laurencio/config.toml`: the device-local policy plus the CLI settings the
 * CLI owns (the server URL). The file is never a sync surface. Policy fields are
 * parsed by the core parser so both readers agree on the shape.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  activeAdapters,
  type DevicePolicy,
  defaultPolicy,
  type HarnessAdapter,
  parsePolicyToml,
  type Surface,
  secrets,
} from '@laurencio/core'
import { parse, stringify, type TomlTable } from 'smol-toml'
import { cliError } from './errors'

export const CONFIG_FILE_NAME = 'config.toml'
/** Public beta service used when a device has no explicit server configuration. */
export const DEFAULT_SERVER_URL = 'https://laurencio-server-production.up.railway.app'

export interface CliConfig {
  server: string | null
  policy: DevicePolicy
}

export function configPath(home: string): string {
  return path.join(home, secrets.LAURENCIO_DIR, CONFIG_FILE_NAME)
}

/** The CLI's opt-in rule: an opt-in surface is off until its toggle says `on`. */
export function surfaceEnabled(policy: DevicePolicy, surface: Surface): boolean {
  const toggle = policy.harnesses[surface.harness]?.surfaces[surface.id]
  if (toggle === 'on') return true
  if (toggle === 'off') return false
  return surface.policy !== 'opt-in'
}

/** Policy filtering plus the opt-in default, applied wherever surfaces are read. */
export function effectiveAdapters(
  adapters: readonly HarnessAdapter[],
  policy: DevicePolicy,
): HarnessAdapter[] {
  return activeAdapters(adapters, policy).map((adapter) => ({
    ...adapter,
    surfaces: (ctx) => adapter.surfaces(ctx).filter((surface) => surfaceEnabled(policy, surface)),
  }))
}

export function loadCliConfig(home: string): CliConfig {
  const filePath = configPath(home)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { server: null, policy: defaultPolicy() }
    }
    throw error
  }
  let table: TomlTable
  try {
    table = parse(raw)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw cliError('bad-config', `${filePath} is not valid TOML: ${reason}`)
  }
  const server =
    typeof table.server === 'string' && table.server.trim() !== '' ? table.server.trim() : null
  return { server, policy: parsePolicyToml(raw, filePath) }
}

export function saveCliConfig(home: string, config: CliConfig): string {
  const filePath = configPath(home)
  const harnesses: TomlTable = {}
  for (const [id, harness] of Object.entries(config.policy.harnesses)) {
    if (harness === undefined) continue
    harnesses[id] = { enabled: harness.enabled, surfaces: { ...harness.surfaces } }
  }
  const body = stringify({
    ...(config.server === null ? {} : { server: config.server }),
    ignore: [...config.policy.ignore],
    ...(config.policy.prune ? { prune: true } : {}),
    cadence: {
      watch: config.policy.cadence.watch,
      intervalSeconds: config.policy.cadence.intervalSeconds,
    },
    harnesses,
  })
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, body, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
  return filePath
}
