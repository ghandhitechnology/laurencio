import type { AdapterContext, HarnessProbe } from '../../types'

export type OpenCodeSchemaVersion = 1 | 2

/**
 * One file or directory under the global OpenCode config root, and the schema versions that
 * read it. OpenCode 1.18.x and the 2.x beta share the directory with different schemas, so
 * "which version owns this" is a property of each file.
 */
export interface OpenCodeSchemaFile {
  name: string
  owners: OpenCodeSchemaVersion[]
  description: string
}

export const OPENCODE_SCHEMA_FILES: readonly OpenCodeSchemaFile[] = [
  { name: 'opencode.json', owners: [1, 2], description: 'shared config document' },
  { name: 'opencode.jsonc', owners: [1, 2], description: 'shared config document, JSONC' },
  { name: 'tui.json', owners: [1], description: 'v1 TUI preferences' },
  { name: 'cli.json', owners: [2], description: 'v2 CLI preferences' },
  { name: 'AGENTS.md', owners: [1, 2], description: 'global instructions' },
  { name: 'agents', owners: [1, 2], description: 'global agent definitions' },
  { name: 'commands', owners: [1, 2], description: 'global command definitions' },
  { name: 'skills', owners: [1, 2], description: 'global skills' },
  { name: 'themes', owners: [1, 2], description: 'global themes' },
  { name: 'plugins', owners: [1, 2], description: 'local plugins and dependencies' },
  { name: 'tools', owners: [1], description: 'v1 custom tools' },
  { name: 'service.json', owners: [1, 2], description: 'generated local service password; never' },
]

export function schemasForFile(name: string): OpenCodeSchemaVersion[] {
  const declared = OPENCODE_SCHEMA_FILES.find((file) => file.name === name)
  return declared === undefined ? [] : [...declared.owners]
}

/** Convention for the CLI probe: note lines like `opencode2 0.0.0-beta-19059` and `config:cli.json`. */
const BINARY_NOTE = /^(opencode2?)\s+v?(\d+\S*)/
const CONFIG_NOTE = 'config:'

export interface OpenCodeBinary {
  name: string
  version: string
}

export interface OpenCodeProbeReport {
  installed: boolean
  version: string | null
  binaries: OpenCodeBinary[]
  /** Schema presence: a binary, or a config file shape that only one schema writes. */
  schemas: { v1: boolean; v2: boolean }
  /** Config root entries observed by the probe, with the schemas that read each. */
  files: { name: string; owners: OpenCodeSchemaVersion[] }[]
  configRoots: string[]
  notes: string[]
}

/** Tokenized config root; `$XDG_CONFIG_HOME` expands to `~/.config` by default. */
const braced = (name: string): string => `\${${name}}`

export const OPENCODE_CONFIG_ROOT = `${braced('XDG_CONFIG_HOME')}/opencode`

function parseBinaries(probe: HarnessProbe | undefined): OpenCodeBinary[] {
  if (probe === undefined) return []
  const binaries: OpenCodeBinary[] = []
  const add = (name: string, version: string): void => {
    if (!binaries.some((binary) => binary.name === name)) binaries.push({ name, version })
  }
  if (probe.version !== undefined) {
    const match = BINARY_NOTE.exec(probe.version.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) add(match[1], match[2])
    else add('opencode', probe.version)
  }
  for (const note of probe.notes) {
    const match = BINARY_NOTE.exec(note.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) add(match[1], match[2])
  }
  return binaries
}

function parseObservedFiles(probe: HarnessProbe | undefined): string[] {
  if (probe === undefined) return []
  const names = new Set<string>()
  for (const note of probe.notes) {
    if (!note.startsWith(CONFIG_NOTE)) continue
    const name = note.slice(CONFIG_NOTE.length).split('/')[0]
    if (name !== undefined && name !== '') names.add(name)
  }
  return [...names].sort()
}

/**
 * Pure schema detection. Presence comes from the probe binaries and the config-dir file shapes
 * the probe reports; adapters never read the filesystem themselves.
 */
export function detectOpenCode(ctx: AdapterContext): OpenCodeProbeReport {
  const probe = ctx.probes?.opencode
  const binaries = parseBinaries(probe)
  const observed = parseObservedFiles(probe)
  const files = observed.map((name) => ({ name, owners: schemasForFile(name) }))

  const v1FromBinary = binaries.some((binary) => binary.name === 'opencode')
  const v2FromBinary = binaries.some((binary) => binary.name === 'opencode2')
  const v1FromShape = observed.includes('tui.json') || observed.includes('tools')
  const v2FromShape = observed.includes('cli.json')
  const schemas = { v1: v1FromBinary || v1FromShape, v2: v2FromBinary || v2FromShape }

  const primary = binaries.find((binary) => binary.name === 'opencode') ?? binaries[0]
  const notes: string[] = []
  if (probe === undefined) {
    notes.push('no opencode probe supplied; reporting declared file shapes only')
  } else if (!probe.installed) {
    notes.push('probe reports opencode is not installed')
  }
  for (const binary of binaries) notes.push(`${binary.name} ${binary.version}`)
  notes.push(
    `v1 schema ${schemas.v1 ? 'present' : 'absent'}; v2 schema ${schemas.v2 ? 'present' : 'absent'}`,
  )
  for (const file of files) {
    const owners =
      file.owners.length === 0
        ? 'no declared schema'
        : `read by ${file.owners.map((v) => `v${v}`).join(', ')}`
    notes.push(`config:${file.name} is ${owners}`)
  }

  return {
    installed: probe?.installed === true,
    version: primary?.version ?? null,
    binaries,
    schemas,
    files,
    configRoots: [OPENCODE_CONFIG_ROOT],
    notes,
  }
}
