import {
  builtinAdapters,
  createHttpRemote,
  crypto,
  DEFAULT_VAULT_REFERENCES,
  defaultPolicy,
  SyncLoop,
  type SyncRunResult,
  SyncState,
  supportsProfile,
  supportsVault,
  type VaultReference,
} from '@laurencio/core'
import type { SurfaceId } from '@laurencio/protocol'
import { effectiveAdapters } from '../config'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
import { createWorkbenchClient } from './client'
import { createSystemCredentialIo } from './credentials'
import { privateEnvironment } from './materialize'
import { loadPortableProfile } from './profile'
import type { RegisteredWorkbench } from './registry'
import { captureCredentialVault } from './vault'

export async function saveWorkbenchChanges(
  ctx: CommandContext,
  input: {
    record: RegisteredWorkbench
    token: string
    passphrase: string
    harnesses: readonly string[]
    surface: string | null
  },
): Promise<SyncRunResult> {
  if (input.harnesses.length === 0 && input.surface === null) {
    throw cliError('selection-required', 'choose what to save with --surface or --harness')
  }
  const selectedHarnesses = new Set(input.harnesses)
  const knownHarnesses = new Set<string>(builtinAdapters.map((adapter) => adapter.id))
  const unknownHarnesses = Array.from(selectedHarnesses).filter(
    (harness) => !knownHarnesses.has(harness),
  )
  if (unknownHarnesses.length > 0) {
    throw cliError('unknown-harness', `unknown harness: ${unknownHarnesses.join(', ')}`)
  }
  const env = privateEnvironment(ctx, input.record.runtime.home)
  if (input.surface !== null) {
    const known = builtinAdapters.some((adapter) =>
      adapter
        .surfaces({
          home: input.record.runtime.home,
          platform: ctx.platform,
          env,
          ...(ctx.deps.probes === undefined ? {} : { probes: ctx.deps.probes }),
        })
        .some((surface) => surface.id === input.surface),
    )
    if (!known) throw cliError('unknown-surface', `unknown surface: ${input.surface}`)
  }
  const client = createWorkbenchClient({
    baseUrl: input.record.server,
    bearer: input.token,
    ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
  })
  const account = await client.account()
  const remote =
    ctx.deps.remote?.({
      storeId: account.storeId,
      token: input.token,
      baseUrl: input.record.server,
    }) ??
    createHttpRemote({
      baseUrl: input.record.server,
      storeId: account.storeId,
      token: input.token,
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      retry: { attempts: 2 },
    })
  const published = await remote.getKdfParams()
  if (published === null) throw cliError('no-kdf', 'this store has no passphrase parameters')
  const selectedSurface = input.surface as SurfaceId | null
  const chosen = builtinAdapters
    .filter((adapter) => selectedHarnesses.size === 0 || selectedHarnesses.has(adapter.id))
    .map((adapter) => ({
      ...adapter,
      surfaces: (adapterContext: Parameters<typeof adapter.surfaces>[0]) =>
        adapter
          .surfaces(adapterContext)
          .filter((surface) => selectedSurface === null || surface.id === selectedSurface),
    }))
  const key = crypto.deriveMasterKey(input.passphrase, published.kdf)
  const state = SyncState.open({ home: input.record.runtime.home })
  const policy = defaultPolicy()
  try {
    const result = await new SyncLoop({
      adapters: effectiveAdapters(chosen, policy),
      ctx: {
        home: input.record.runtime.home,
        platform: ctx.platform,
        env,
        ...(ctx.deps.probes === undefined ? {} : { probes: ctx.deps.probes }),
      },
      deviceId: input.record.remote.deviceId,
      storeId: account.storeId,
      key,
      state,
      remote,
      policy,
      ...(ctx.deps.quiescence === undefined ? {} : { quiescence: ctx.deps.quiescence }),
      ...(ctx.deps.createRevisionId === undefined
        ? {}
        : { createRevisionId: ctx.deps.createRevisionId }),
      now: ctx.now,
    }).runOnce()
    if (result.status === 'failed' || result.status === 'offline') {
      throw cliError(
        result.error?.code ?? 'save-failed',
        result.error?.message ?? 'could not save workbench changes',
      )
    }
    if (selectedHarnesses.size > 0 && supportsVault(remote)) {
      let references: readonly VaultReference[] = DEFAULT_VAULT_REFERENCES
      if (supportsProfile(remote)) {
        const stored = await loadPortableProfile({ remote, storeId: account.storeId, key })
        if (stored !== null) references = stored.profile.vault
      }
      references = references.filter((reference) => selectedHarnesses.has(reference.harness))
      if (references.length > 0) {
        await captureCredentialVault({
          remote,
          storeId: account.storeId,
          key,
          references,
          tokenEnv: { home: input.record.runtime.home, platform: ctx.platform, env },
          io: createSystemCredentialIo(env),
          now: () => ctx.now().toISOString(),
        })
      }
    }
    // Temporary actors publish selected files and credentials. Account settings
    // have a separate head that only enrolled devices may update.
    return result
  } finally {
    state.close()
    key.zeroize()
  }
}
