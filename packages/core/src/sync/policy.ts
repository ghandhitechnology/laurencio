/**
 * Device-local sync policy, loaded from `~/.laurencio/config.toml`. The file is
 * never a sync surface: harness and surface toggles, the ignore list, and the
 * cadence describe this machine only and must not travel to another one.
 */

import fs from 'node:fs'
import path from 'node:path'
import { parse, stringify, type TomlTable, type TomlValue } from 'smol-toml'
import { type DevicePolicy, defaultPolicy, type HarnessPolicy } from '../model'
import { LAURENCIO_DIR } from '../secrets/scan'
import type { HarnessAdapter, HarnessId } from '../types'

export const POLICY_FILE_NAME = 'config.toml'

export class PolicyError extends Error {
  readonly path: string

  constructor(filePath: string, message: string) {
    super(`invalid policy at ${filePath}: ${message}`)
    this.name = 'PolicyError'
    this.path = filePath
  }
}

export function policyPath(home: string): string {
  return path.join(home, LAURENCIO_DIR, POLICY_FILE_NAME)
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isTable(value: TomlValue | undefined): value is TomlTable {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  )
}

function booleanValue(table: TomlTable, key: string, source: string, fallback: boolean): boolean {
  const value = table[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new PolicyError(source, `${key} must be a boolean`)
  return value
}

function positiveInteger(table: TomlTable, key: string, source: string, fallback: number): number {
  const value = table[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new PolicyError(source, `${key} must be a positive integer`)
  }
  return value
}

function parseIgnore(table: TomlTable, source: string, fallback: string[]): string[] {
  const value = table.ignore
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    throw new PolicyError(source, 'ignore must be an array of glob strings')
  }
  const patterns: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item.trim() === '') {
      throw new PolicyError(source, 'every ignore entry must be a non-empty string')
    }
    patterns.push(item)
  }
  return patterns
}

function parseSurfaces(table: TomlTable, source: string): Record<string, 'on' | 'off'> {
  const value = table.surfaces
  if (value === undefined) return {}
  if (!isTable(value)) throw new PolicyError(source, 'surfaces must be a table of on/off values')
  const surfaces: Record<string, 'on' | 'off'> = {}
  for (const [id, toggle] of Object.entries(value)) {
    if (toggle !== 'on' && toggle !== 'off') {
      throw new PolicyError(source, `surfaces.${id} must be "on" or "off"`)
    }
    surfaces[id] = toggle
  }
  return surfaces
}

/** Parses the config.toml body. Unknown keys are ignored so the file can grow. */
export function parsePolicyToml(raw: string, source = POLICY_FILE_NAME): DevicePolicy {
  let table: TomlTable
  try {
    table = parse(raw)
  } catch (error) {
    throw new PolicyError(source, `not valid TOML: ${reasonFor(error)}`)
  }
  const base = defaultPolicy()

  const cadenceValue = table.cadence
  let cadence = base.cadence
  if (cadenceValue !== undefined) {
    if (!isTable(cadenceValue)) throw new PolicyError(source, 'cadence must be a table')
    cadence = {
      watch: booleanValue(cadenceValue, 'watch', source, base.cadence.watch),
      intervalSeconds: positiveInteger(
        cadenceValue,
        'intervalSeconds',
        source,
        base.cadence.intervalSeconds,
      ),
    }
  }

  const harnesses: DevicePolicy['harnesses'] = {}
  const harnessesValue = table.harnesses
  if (harnessesValue !== undefined) {
    if (!isTable(harnessesValue)) throw new PolicyError(source, 'harnesses must be a table')
    for (const [id, value] of Object.entries(harnessesValue)) {
      if (!isTable(value)) throw new PolicyError(source, `harnesses.${id} must be a table`)
      const policy: HarnessPolicy = {
        enabled: booleanValue(value, 'enabled', source, true),
        surfaces: parseSurfaces(value, source),
      }
      harnesses[id as HarnessId] = policy
    }
  }

  return {
    version: 1,
    harnesses,
    ignore: parseIgnore(table, source, base.ignore),
    cadence,
  }
}

/** Loads the device policy, falling back to defaults when the file is absent. */
export function loadPolicy(home: string): DevicePolicy {
  const filePath = policyPath(home)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      const code = (error as { code?: string }).code
      if (code === 'ENOENT') return defaultPolicy()
    }
    throw error
  }
  return parsePolicyToml(raw, filePath)
}

/** Writes the policy back atomically enough for a device-local file. */
export function savePolicy(home: string, policy: DevicePolicy): string {
  const filePath = policyPath(home)
  const harnesses: TomlTable = {}
  for (const [id, harness] of Object.entries(policy.harnesses)) {
    if (harness === undefined) continue
    harnesses[id] = { enabled: harness.enabled, surfaces: { ...harness.surfaces } }
  }
  const body = stringify({
    ignore: [...policy.ignore],
    cadence: { watch: policy.cadence.watch, intervalSeconds: policy.cadence.intervalSeconds },
    harnesses,
  })
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, body, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
  return filePath
}

/**
 * Wraps adapters so disabled harnesses and surfaces never reach the engine's
 * surface map, which excludes them from scanning, planning, and applying.
 */
export function activeAdapters(
  adapters: readonly HarnessAdapter[],
  policy: DevicePolicy,
): HarnessAdapter[] {
  return adapters.map((adapter) => {
    const harness = policy.harnesses[adapter.id]
    if (harness === undefined) return adapter
    if (!harness.enabled) return { ...adapter, surfaces: () => [] }
    const off = new Set(
      Object.entries(harness.surfaces)
        .filter(([, toggle]) => toggle === 'off')
        .map(([id]) => id),
    )
    if (off.size === 0) return adapter
    return {
      ...adapter,
      surfaces: (ctx) => adapter.surfaces(ctx).filter((surface) => !off.has(surface.id)),
    }
  })
}

/** Watcher cadence for phase 14; null means watch mode is off. */
export function nextRunDelayMs(policy: DevicePolicy): number | null {
  if (!policy.cadence.watch) return null
  return Math.floor(policy.cadence.intervalSeconds) * 1000
}
