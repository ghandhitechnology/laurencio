import fs from 'node:fs'
import path from 'node:path'
import {
  builtinAdapters,
  createCachedRemote,
  createHttpRemote,
  crypto,
  DEFAULT_VAULT_REFERENCES,
  defaultPolicy,
  projectProfile,
  type Remote,
  type RemoteListOptions,
  type RemoteRevisionList,
  resolveToolLock,
  SyncLoop,
  type SyncProgress,
  SyncState,
  shippedToolLock,
  supportsProfile,
  supportsVault,
  type ToolLockEntry,
  ToolManager,
  type VaultReference,
} from '@laurencio/core'
import type { ProfileHead, RevisionId, StoreId, VaultHead } from '@laurencio/protocol'
import { effectiveAdapters } from '../config'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
import { createSystemToolDependencies, toolArchitecture } from '../tools/system'
import { createWorkbenchClient } from './client'
import type { WorkbenchMaterializeInput } from './controller'
import { createSystemCredentialIo } from './credentials'
import { loadPortableProfile, type StoredPortableProfile } from './profile'
import { routeWorkbenchEnvironment } from './runtime'
import { materializeCredentialVault } from './vault'

export interface WorkbenchMaterializeOptions {
  /** Keep verified public tools and downloaded blobs under `~/.laurencio` after the session. */
  persistentCache?: boolean
  onPhase?: (phase: 'syncing' | 'credentials' | 'tools') => void
  onSyncProgress?: (progress: SyncProgress) => void
}

function pinnedRevisionList(
  snapshot: RemoteRevisionList,
  options: RemoteListOptions = {},
): RemoteRevisionList {
  let revisions = snapshot.revisions
  if (options.since !== undefined) {
    const index = revisions.findIndex((revision) => revision.id === options.since)
    if (index >= 0) revisions = revisions.slice(index + 1)
  }
  if (options.limit !== undefined && options.limit >= 0) {
    revisions = revisions.slice(-options.limit)
  }
  return {
    revisions: revisions.map((revision) => ({
      ...revision,
      parents: [...revision.parents],
      manifest: { ...revision.manifest },
      digest: revision.digest.map((entry) => ({ ...entry })),
    })),
    head: snapshot.head,
    heads: [...snapshot.heads],
  }
}

function rejectPinnedWrite(operation: string): never {
  throw new Error(`temporary revision view cannot ${operation}`)
}

/** Holds mutable remote heads still while a temporary home is being populated. */
function createPinnedRemote(
  remote: Remote,
  revisions: RemoteRevisionList,
  profileHead: ProfileHead | null,
  vaultHead: VaultHead | null,
): Remote {
  const profileRemote = supportsProfile(remote) ? remote : null
  const vaultRemote = supportsVault(remote) ? remote : null
  const revisionIds = new Set(revisions.revisions.map((revision) => revision.id))
  const pinned: Remote = {
    getKdfParams: (options) => remote.getKdfParams(options),
    putKdfParams: async () => rejectPinnedWrite('publish KDF parameters'),
    listRevisions: async (options) => pinnedRevisionList(revisions, options),
    getManifest: async (revisionId) => {
      if (!revisionIds.has(revisionId)) {
        throw new Error(`revision ${revisionId} is outside the temporary revision view`)
      }
      return remote.getManifest(revisionId)
    },
    putBlob: async () => rejectPinnedWrite('upload blobs'),
    getBlob: (blobId) => remote.getBlob(blobId),
    commit: async () => rejectPinnedWrite('publish revisions'),
    listDevices: () => remote.listDevices(),
  }
  if (profileRemote !== null) {
    Object.assign(pinned, {
      getProfileHead: async () => profileHead,
      putProfileHead: async () => rejectPinnedWrite('publish profile heads'),
    })
  }
  if (vaultRemote !== null) {
    Object.assign(pinned, {
      getVaultHead: async () => vaultHead,
      putVaultHead: async () => rejectPinnedWrite('publish vault heads'),
    })
  }
  return pinned
}

/**
 * Pin each independently published head before populating the temporary home.
 * The profile's embedded manifest may predate a selective save; file contents
 * always come from the revision head, while settings come from the profile head.
 */
export async function captureWorkbenchSnapshot(
  remote: Remote,
  storeId: StoreId,
  key: crypto.KeyMaterial,
): Promise<{ remote: Remote; revisionId: RevisionId; profile: StoredPortableProfile | null }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const revisions = await remote.listRevisions()
    if (revisions.head === null) {
      throw cliError('empty-profile', 'this account has no workbench profile yet', {
        hint: 'Run `laurencio enroll` on a configured device first.',
      })
    }
    const profileHead = supportsProfile(remote) ? await remote.getProfileHead() : null
    const vaultHead = supportsVault(remote) ? await remote.getVaultHead() : null
    const pinned = createPinnedRemote(remote, revisions, profileHead, vaultHead)
    const profile = supportsProfile(pinned)
      ? await loadPortableProfile({ remote: pinned, storeId, key })
      : null
    const afterVault = supportsVault(remote) ? await remote.getVaultHead() : null
    const afterProfile = supportsProfile(remote) ? await remote.getProfileHead() : null
    const afterRevisions = await remote.listRevisions()
    if (
      JSON.stringify(revisions) === JSON.stringify(afterRevisions) &&
      JSON.stringify(profileHead) === JSON.stringify(afterProfile) &&
      JSON.stringify(vaultHead) === JSON.stringify(afterVault)
    ) {
      return { remote: pinned, revisionId: revisions.head, profile }
    }
  }
  throw cliError('profile-changing', 'the workbench profile is being updated; retry the launch')
}

function installedExecutable(directory: string, names: readonly string[]): string | null {
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) break
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(candidate)
      else if (entry.isFile() && names.some((name) => entry.name.toLowerCase() === name)) {
        return candidate
      }
    }
  }
  return null
}

function completeRuntimeExecutables(
  platform: 'darwin' | 'win32',
  input: WorkbenchMaterializeInput,
  tools: readonly { name: string; directory: string }[],
): void {
  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    if (platform === 'darwin' && input.executables.tmux === undefined && name === 'tmux') {
      const executable = installedExecutable(tool.directory, ['tmux'])
      if (executable !== null) input.executables.tmux = executable
    }
    if (platform === 'win32' && input.executables.wezterm === undefined && name === 'wezterm') {
      const executable = installedExecutable(tool.directory, ['wezterm-gui.exe', 'wezterm.exe'])
      if (executable !== null) input.executables.wezterm = executable
    }
    if (
      platform === 'win32' &&
      input.executables.powershell === undefined &&
      (name === 'powershell' || name === 'pwsh')
    ) {
      const executable = installedExecutable(tool.directory, ['pwsh.exe'])
      if (executable !== null) input.executables.powershell = executable
    }
  }
  if (platform === 'darwin' && input.executables.tmux === undefined) {
    throw cliError(
      'missing-runtime',
      'tmux is unavailable and the account profile has no matching tmux tool pin',
    )
  }
  if (platform === 'win32' && input.executables.wezterm === undefined) {
    throw cliError(
      'missing-runtime',
      'WezTerm is unavailable and the account profile has no matching WezTerm tool pin',
    )
  }
  if (platform === 'win32' && input.executables.powershell === undefined) {
    throw cliError(
      'missing-runtime',
      'PowerShell 7 is unavailable and the account profile has no matching PowerShell tool pin',
    )
  }
}

/** Pulls one remote head into the private home without caching the passphrase-derived key. */
export async function materializeWorkbench(
  ctx: CommandContext,
  input: WorkbenchMaterializeInput,
  unlock: string | crypto.KeyMaterial,
  options: WorkbenchMaterializeOptions = {},
): Promise<RevisionId> {
  const platform = ctx.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    throw cliError('unsupported-platform', 'temporary workbenches support macOS and Windows')
  }
  options.onPhase?.('syncing')
  const client = createWorkbenchClient({
    baseUrl: input.server,
    bearer: input.token,
    ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
  })
  const account = await client.account()
  let remote =
    ctx.deps.remote?.({
      storeId: account.storeId,
      token: input.token,
      baseUrl: input.server,
    }) ??
    createHttpRemote({
      baseUrl: input.server,
      storeId: account.storeId,
      token: input.token,
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      retry: { attempts: 2 },
    })
  if (options.persistentCache === true && ctx.deps.remote === undefined) {
    remote = createCachedRemote(remote, path.join(ctx.home, '.laurencio', 'cache', 'blobs'))
  }
  let key: crypto.KeyMaterial
  if (typeof unlock === 'string') {
    const published = await remote.getKdfParams()
    if (published === null) {
      throw cliError('no-kdf', 'this store has no passphrase parameters', {
        hint: 'Run `laurencio enroll` on a configured device first.',
      })
    }
    key = crypto.deriveMasterKey(unlock, published.kdf)
  } else {
    key = unlock
  }
  const state = SyncState.open({ home: input.home })
  const env = privateEnvironment(ctx, input.home)
  const policy = defaultPolicy()
  try {
    const {
      remote: pinnedRemote,
      revisionId,
      profile,
    } = await captureWorkbenchSnapshot(remote, account.storeId, key)
    const loop = new SyncLoop({
      adapters: effectiveAdapters(builtinAdapters, policy),
      ctx: {
        home: input.home,
        platform: ctx.platform,
        env,
        ...(ctx.deps.probes === undefined ? {} : { probes: ctx.deps.probes }),
      },
      deviceId: input.remote.deviceId,
      storeId: account.storeId,
      key,
      state,
      remote: pinnedRemote,
      policy,
      ...(options.onSyncProgress === undefined ? {} : { onProgress: options.onSyncProgress }),
      ...(ctx.deps.quiescence === undefined ? {} : { quiescence: ctx.deps.quiescence }),
      ...(ctx.deps.createRevisionId === undefined
        ? {}
        : { createRevisionId: ctx.deps.createRevisionId }),
      now: ctx.now,
    })
    const result = await loop.runOnce()
    if (result.status === 'failed' || result.status === 'offline' || result.report === null) {
      throw cliError(
        result.error?.code ?? 'materialize-failed',
        result.error?.message ?? 'could not materialize the workbench profile',
      )
    }
    if (result.report.conflicts.length > 0 || result.report.blocked.length > 0) {
      throw cliError(
        'materialize-conflict',
        'the workbench profile could not be materialized cleanly',
      )
    }
    let references: readonly VaultReference[] = DEFAULT_VAULT_REFERENCES
    let tools: readonly ToolLockEntry[] = []
    if (profile !== null) {
      references = profile.profile.vault
      tools = profile.profile.tools
      const projected = projectProfile(profile.profile, platform)
      fs.writeFileSync(
        path.join(input.root, 'terminal-settings.json'),
        JSON.stringify({ keybindings: projected.keybindings, layout: projected.layout }),
        { mode: 0o600 },
      )
    }
    options.onPhase?.('credentials')
    if (supportsVault(pinnedRemote)) {
      await materializeCredentialVault({
        remote: pinnedRemote,
        storeId: account.storeId,
        key,
        references,
        tokenEnv: { home: input.home, platform, env },
        io: createSystemCredentialIo(env),
      })
      for (const reference of references) {
        if (reference.kind === 'mcp-secret' && env[reference.env] !== undefined) {
          input.environment[reference.env] = env[reference.env]
        }
      }
    }
    let installed: { name: string; directory: string }[] = []
    options.onPhase?.('tools')
    tools = resolveToolLock(tools, ctx.deps.curatedTools ?? shippedToolLock())
    tools = tools.filter((tool) => {
      const name = tool.name.toLowerCase()
      if (platform === 'darwin' && name === 'tmux') return input.executables.tmux === undefined
      if (platform === 'win32' && name === 'wezterm') {
        return input.executables.wezterm === undefined
      }
      if (platform === 'win32' && (name === 'powershell' || name === 'pwsh')) {
        return input.executables.powershell === undefined
      }
      return true
    })
    if (tools.length > 0) {
      const target = options.persistentCache
        ? { kind: 'cache' as const, root: path.join(ctx.home, '.laurencio', 'tools') }
        : { kind: 'session' as const, root: path.join(input.root, 'tools') }
      installed = await new ToolManager(
        tools,
        createSystemToolDependencies({
          ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
        }),
      ).install({
        platform,
        architecture: toolArchitecture(ctx.deps.architecture ?? process.arch),
        target,
      })
      if (installed.length > 0) {
        const directories = installed.flatMap((tool) => [
          tool.directory,
          path.join(tool.directory, 'bin'),
        ])
        input.environment.PATH = [...directories, ctx.env.PATH ?? '']
          .filter(Boolean)
          .join(path.delimiter)
      }
    }
    completeRuntimeExecutables(platform, input, installed)
    return revisionId
  } finally {
    state.close()
    key.zeroize()
  }
}

export function privateEnvironment(
  ctx: Pick<CommandContext, 'env' | 'platform'>,
  home: string,
): Record<string, string | undefined> {
  if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
    throw new Error('Temporary workbenches support macOS and Windows.')
  }
  return routeWorkbenchEnvironment(ctx.env, ctx.platform, home)
}
