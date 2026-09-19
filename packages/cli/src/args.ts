/**
 * Argument parsing. One flat option table over `node:util` parseArgs keeps the
 * dependency count at zero; each command validates the flags it owns and the
 * help text documents only those.
 */

import { parseArgs } from 'node:util'
import { cliError } from './errors'

export interface Flags {
  json: boolean
  verbose: boolean
  home: string | undefined
  help: boolean
  version: boolean
  server: string | undefined
  harness: string[]
  surface: string | undefined
  dryRun: boolean
  yes: boolean
  out: string | undefined
  plaintext: boolean
  limit: string | undefined
  name: string | undefined
  keepLocal: boolean
  keepRemote: boolean
  editor: boolean
  passphraseFile: string | undefined
  remoteDir: string | undefined
  deviceName: string | undefined
  resume: boolean
}

export interface ParsedArgs {
  command: string | null
  /** The first argument after the command, when a command treats it as one. */
  subcommand: string | null
  /** Every argument after the command, in order. */
  positionals: string[]
  flags: Flags
}

const OPTIONS = {
  json: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v' },
  home: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  server: { type: 'string' },
  harness: { type: 'string', multiple: true },
  surface: { type: 'string' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean', short: 'y' },
  out: { type: 'string' },
  plaintext: { type: 'boolean' },
  limit: { type: 'string' },
  name: { type: 'string' },
  'keep-local': { type: 'boolean' },
  'keep-remote': { type: 'boolean' },
  editor: { type: 'boolean' },
  'passphrase-file': { type: 'string' },
  'remote-dir': { type: 'string' },
  'device-name': { type: 'string' },
  resume: { type: 'boolean' },
} as const

function booleanFlag(values: Record<string, unknown>, key: string): boolean {
  return values[key] === true
}

export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw cliError('bad-flags', message, { hint: 'Run `laurencio --help` for usage.' })
  }
  const values = parsed.values
  const flags: Flags = {
    json: booleanFlag(values, 'json'),
    verbose: booleanFlag(values, 'verbose'),
    home: typeof values.home === 'string' ? values.home : undefined,
    help: booleanFlag(values, 'help'),
    version: booleanFlag(values, 'version'),
    server: typeof values.server === 'string' ? values.server : undefined,
    harness: Array.isArray(values.harness)
      ? values.harness.filter((item): item is string => typeof item === 'string')
      : [],
    surface: typeof values.surface === 'string' ? values.surface : undefined,
    dryRun: booleanFlag(values, 'dry-run'),
    yes: booleanFlag(values, 'yes'),
    out: typeof values.out === 'string' ? values.out : undefined,
    plaintext: booleanFlag(values, 'plaintext'),
    limit: typeof values.limit === 'string' ? values.limit : undefined,
    name: typeof values.name === 'string' ? values.name : undefined,
    keepLocal: booleanFlag(values, 'keep-local'),
    keepRemote: booleanFlag(values, 'keep-remote'),
    editor: booleanFlag(values, 'editor'),
    passphraseFile:
      typeof values['passphrase-file'] === 'string' ? values['passphrase-file'] : undefined,
    remoteDir: typeof values['remote-dir'] === 'string' ? values['remote-dir'] : undefined,
    deviceName: typeof values['device-name'] === 'string' ? values['device-name'] : undefined,
    resume: booleanFlag(values, 'resume'),
  }
  const args = parsed.positionals.slice(1)
  const command = parsed.positionals[0] ?? null
  const subcommand = args[0] ?? null
  return { command, subcommand, positionals: args, flags }
}

export function requirePositional(
  positionals: readonly string[],
  index: number,
  name: string,
  usage: string,
): string {
  const value = positionals[index]
  if (value === undefined || value === '') {
    throw cliError('missing-argument', `missing ${name}`, { hint: `Usage: ${usage}` })
  }
  return value
}

export function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw cliError('bad-flags', `--limit must be a positive integer, got ${raw}`)
  }
  return value
}
