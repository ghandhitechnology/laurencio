import {
  type CredentialBaseline,
  type CredentialOperationResult,
  DEFAULT_VAULT_REFERENCES,
  type DevicePolicy,
  migrateManifestToProfile,
  type PortableProfile,
  type SyncState,
  supportsProfile,
  supportsVault,
  type VaultReference,
} from '@laurencio/core'
import { loadCliConfig } from './config'
import { adapterContext, type CommandContext } from './context'
import { cliError } from './errors'
import { ensureProfileV2 } from './profile-version'
import type { CliSession } from './session'
import { loadRemoteManifest } from './session'
import { createSystemCredentialIo } from './workbench/credentials'
import { applyNativeTerminal, importNativeTerminalSettings } from './workbench/native-terminal'
import { loadPortableProfile, savePortableProfile } from './workbench/profile'
import { reconcileCredentialVault } from './workbench/vault'

const CREDENTIAL_BASELINES_META_KEY = 'credential_vault_baselines'

/** Applies device policy and an optional command-level harness selection to vault references. */
export function selectedCredentialReferences(
  references: readonly VaultReference[],
  policy: DevicePolicy,
  harnesses: readonly string[] = [],
): VaultReference[] {
  const selected = harnesses.length === 0 ? null : new Set(harnesses)
  return references.filter((reference) => {
    const harness = policy.harnesses[reference.harness]
    if (harness?.enabled === false) return false
    const surfaceChoices = Object.values(harness?.surfaces ?? {})
    if (surfaceChoices.length > 0 && surfaceChoices.every((choice) => choice === 'off'))
      return false
    return selected === null || selected.has(reference.harness)
  })
}

/** Reads only valid, metadata-only credential baselines from local sync state. */
export function readCredentialBaselines(state: SyncState): Record<string, CredentialBaseline> {
  const raw = state.getMeta(CREDENTIAL_BASELINES_META_KEY)
  if (raw === null) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, CredentialBaseline] =>
          typeof entry[1] === 'object' &&
          entry[1] !== null &&
          Number.isSafeInteger((entry[1] as CredentialBaseline).version) &&
          (entry[1] as CredentialBaseline).version > 0 &&
          /^[0-9a-f]{64}$/.test((entry[1] as CredentialBaseline).digest),
      ),
    )
  } catch {
    return {}
  }
}

/** Replaces local credential baselines after a completed reconcile or explicit resolution. */
export function writeCredentialBaselines(
  state: SyncState,
  baselines: Readonly<Record<string, CredentialBaseline>>,
): void {
  state.setMeta(CREDENTIAL_BASELINES_META_KEY, JSON.stringify(baselines))
}

/** Captures changed native login material after a successful full-mode sync. */
export async function syncSessionCredentials(
  ctx: CommandContext,
  session: CliSession,
  state: SyncState,
  harnesses: readonly string[] = [],
): Promise<CredentialOperationResult[]> {
  await ensureProfileV2(session.remote)
  let references: readonly VaultReference[] = DEFAULT_VAULT_REFERENCES
  let profileToPublish: PortableProfile | null = null
  let profileGeneration: number | null = null
  let profileNeedsPublish = false
  if (supportsProfile(session.remote)) {
    const stored = await loadPortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
    })
    const current = await loadRemoteManifest(session, null)
    if (
      current.manifest !== null &&
      (stored === null || stored.profile.manifest.revisionId !== current.manifest.revisionId)
    ) {
      const initialSettings =
        stored === null && (ctx.platform === 'darwin' || ctx.platform === 'win32')
          ? importNativeTerminalSettings({
              home: ctx.home,
              platform: ctx.platform,
              environment: ctx.env,
            })
          : undefined
      const migrated = migrateManifestToProfile(current.manifest)
      profileToPublish =
        stored === null
          ? {
              ...migrated,
              ...(initialSettings === undefined ? {} : { shared: initialSettings }),
            }
          : { ...stored.profile, manifest: current.manifest }
      profileGeneration = stored?.head.generation ?? null
      profileNeedsPublish = true
    } else {
      profileToPublish = stored?.profile ?? null
      profileGeneration = stored?.head.generation ?? null
    }
    if (profileToPublish !== null) {
      references = profileToPublish.vault
      if (ctx.platform === 'darwin' || ctx.platform === 'win32') {
        const which =
          ctx.deps.which ?? ((name: string) => Bun.which(name, { PATH: ctx.env.PATH ?? '' }))
        const wezterm = ctx.platform === 'win32' ? (which('wezterm-gui') ?? which('wezterm')) : null
        applyNativeTerminal({
          home: ctx.home,
          platform: ctx.platform,
          environment: ctx.env,
          profile: profileToPublish,
          ...(ctx.platform === 'win32'
            ? {
                powershell: which('pwsh') ?? 'pwsh.exe',
                ...(wezterm === null ? {} : { wezterm }),
              }
            : {}),
        })
      }
    }
  }
  references = selectedCredentialReferences(references, loadCliConfig(ctx.home).policy, harnesses)
  let results: CredentialOperationResult[] = []
  if (references.length > 0 && supportsVault(session.remote)) {
    if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
      throw cliError('unsupported-platform', 'credential sync supports macOS and Windows')
    }
    const reconciled = await reconcileCredentialVault({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
      references,
      baselines: readCredentialBaselines(state),
      tokenEnv: adapterContext(ctx),
      io: createSystemCredentialIo(ctx.env, {
        durableMcp: {
          platform: ctx.platform,
          ...(ctx.deps.keychain === undefined ? {} : { keychain: ctx.deps.keychain }),
        },
      }),
      now: () => ctx.now().toISOString(),
    })
    writeCredentialBaselines(state, reconciled.baselines)
    const conflicts = reconciled.results.filter((result) => result.status === 'conflict')
    if (conflicts.length > 0) {
      throw cliError(
        'credential-conflict',
        `credentials changed both locally and remotely: ${conflicts.map((result) => result.name).join(', ')}`,
        {
          hint: 'Run `laurencio credentials resolve <reference> --keep-local` or `--keep-remote` for each listed credential.',
        },
      )
    }
    results = reconciled.results
  }
  // Finish credential reconciliation before updating account metadata. Profile,
  // revision, and vault heads are independent; this is not an atomic commit.
  if (profileNeedsPublish && profileToPublish !== null && supportsProfile(session.remote)) {
    await savePortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
      profile: profileToPublish,
      expectedGeneration: profileGeneration,
    })
  }
  return results
}
