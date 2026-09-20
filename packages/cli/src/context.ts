/**
 * The CLI edge: paths, platform, injected IO, and the test levers. Commands
 * receive a context and never read `process` directly, so tests run any command
 * without touching the real HOME, keychain, network, or terminal.
 */

import os from 'node:os'
import path from 'node:path'
import type {
  crypto,
  HarnessId,
  HarnessProbe,
  Platform,
  Remote,
  ToolLockEntry,
} from '@laurencio/core'
import type { RevisionId, StoreId } from '@laurencio/protocol'
import type { Flags } from './args'
import type { ExecFn } from './daemon/installer'
import { cliError } from './errors'
import { type CliIo, createIo } from './ui'
import type { WorkbenchController } from './workbench/controller'
import type { WorkbenchRuntime } from './workbench/runtime'

export interface RemoteFactoryInput {
  storeId: StoreId
  token: string
  baseUrl: string | null
}

export interface CliDeps {
  home?: string
  platform?: Platform
  env?: Record<string, string | undefined>
  cwd?: string
  now?: () => Date
  io?: CliIo
  fetch?: typeof fetch
  keychain?: crypto.CredentialStore | null
  /** Precomputed probes. Tests pass these instead of spawning binaries. */
  probes?: Partial<Record<HarnessId, HarnessProbe>>
  remote?: (input: RemoteFactoryInput) => Remote
  createRevisionId?: () => RevisionId
  /** Test lever: pin KDF parameters instead of calibrating. */
  calibrate?: () => crypto.KdfParams
  /** Test lever: shrink the quiescence window so scripted syncs settle at once. */
  quiescence?: { windowMs?: number }
  sleep?: (ms: number) => Promise<void>
  /** Test lever: record service installer commands instead of running them. */
  exec?: ExecFn
  /** Test lever: record browser launches instead of opening the desktop browser. */
  openUrl?: (url: string) => Promise<boolean>
  /** Test and embedding seams for temporary workbench lifecycle integration. */
  workbenchController?: WorkbenchController
  workbenchRuntime?: WorkbenchRuntime
  which?: (program: string) => string | null
  architecture?: string
  /** Test/embedding seam; production trusts only the catalog compiled into the client. */
  curatedTools?: readonly ToolLockEntry[]
  launchAgent?: (input: {
    executable: string
    args: string[]
    cwd: string
    environment: Record<string, string | undefined>
  }) => Promise<number>
}

export interface CommandContext {
  deps: CliDeps
  home: string
  platform: Platform
  cwd: string
  env: Record<string, string | undefined>
  io: CliIo
  now: () => Date
  flags: Flags
  command: string
  subcommand: string | null
  positionals: string[]
}

function resolvePlatform(value: NodeJS.Platform | undefined): Platform {
  switch (value) {
    case 'darwin':
    case 'win32':
      return value
    case 'linux':
      throw cliError('unsupported-platform', 'the Laurencio client supports macOS and Windows')
    default:
      throw cliError('unsupported-platform', `the Laurencio client does not support ${value}`)
  }
}

export function resolveHome(flags: Flags, deps: CliDeps): string {
  const raw = flags.home ?? deps.home ?? deps.env?.HOME ?? process.env.HOME ?? os.homedir()
  if (raw === undefined || raw === '') {
    throw cliError('no-home', 'could not determine a home directory; pass --home')
  }
  return path.resolve(raw)
}

export function createContext(
  command: string,
  subcommand: string | null,
  positionals: string[],
  flags: Flags,
  deps: CliDeps,
): CommandContext {
  const env = deps.env ?? (process.env as Record<string, string | undefined>)
  return {
    deps,
    home: resolveHome(flags, { ...deps, env }),
    platform: resolvePlatform(deps.platform ?? process.platform),
    cwd: path.resolve(deps.cwd ?? process.cwd()),
    env,
    io: deps.io ?? createIo(),
    now: deps.now ?? (() => new Date()),
    flags,
    command,
    subcommand,
    positionals,
  }
}

/** The tokenized-path environment an `AdapterContext` needs. */
export function adapterContext(ctx: CommandContext): {
  home: string
  platform: Platform
  env: Record<string, string | undefined>
  probes?: Partial<Record<HarnessId, HarnessProbe>>
} {
  return ctx.deps.probes === undefined
    ? { home: ctx.home, platform: ctx.platform, env: ctx.env }
    : { home: ctx.home, platform: ctx.platform, env: ctx.env, probes: ctx.deps.probes }
}

export function isVerbose(ctx: CommandContext): boolean {
  return ctx.flags.verbose
}

export function remoteDirFlag(ctx: CommandContext): string | null {
  return ctx.flags.remoteDir ?? ctx.env.LAURENCIO_REMOTE_DIR ?? null
}
