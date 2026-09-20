import fs from 'node:fs'
import {
  type DiscoveredMcpSecret,
  discoverMcpSecrets,
  isConflictCopyPath,
  migrateManifestToProfile,
  supportsProfile,
  supportsVault,
  vaultRecordId,
} from '@laurencio/core'
import pm from 'picomatch'
import { createBackup } from './backup'
import { loadCliConfig } from './config'
import { adapterContext, type CommandContext } from './context'
import { cliError } from './errors'
import { ensureProfileV2 } from './profile-version'
import { askYesNo } from './prompt'
import { type CliSession, scanInventory } from './session'
import { createSystemCredentialIo } from './workbench/credentials'
import { loadPortableProfile, savePortableProfile } from './workbench/profile'
import { reconcileCredentialVault } from './workbench/vault'

/** Enroll named MCP references before projection can remove their inline values. */
export async function enrollMcpSecrets(ctx: CommandContext, session: CliSession): Promise<void> {
  if (!supportsProfile(session.remote) || !supportsVault(session.remote)) return
  const policy = loadCliConfig(ctx.home).policy
  const inventory = scanInventory(ctx, { policy })
  const ignores = policy.ignore.map((pattern) => pm(pattern, { dot: true }))
  const files: { path: string; original: string; content: string }[] = []
  const discovered = new Map<string, DiscoveredMcpSecret>()
  for (const entry of inventory.scan.entries) {
    if (
      entry.kind !== 'file' ||
      entry.storePath === null ||
      isConflictCopyPath(entry.storePath) ||
      ignores.some((matches) => matches(entry.storePath as string)) ||
      !['sync', 'opt-in'].includes(entry.classification)
    )
      continue
    const surface = inventory.surfaces.get(entry.surfaceId)
    if (surface === undefined) continue
    const original = fs.readFileSync(entry.localPath, 'utf8')
    const result = discoverMcpSecrets(surface.harness, original)
    for (const secret of result.secrets) {
      const id = vaultRecordId(secret.reference)
      const previous = discovered.get(id)
      if (
        previous?.value !== null &&
        previous?.value !== undefined &&
        secret.value !== null &&
        previous.value !== secret.value
      ) {
        throw cliError(
          'mcp-secret-conflict',
          'MCP definitions contain different values for the same credential',
        )
      }
      if (previous === undefined || secret.value !== null) discovered.set(id, secret)
    }
    if (result.content !== original)
      files.push({ path: entry.localPath, original, content: result.content })
  }
  if (discovered.size === 0) return
  await ensureProfileV2(session.remote)
  const input = {
    remote: session.remote,
    storeId: session.credentials.storeId,
    key: session.credentials.key,
  }
  const stored = await loadPortableProfile(input)
  const profile = stored?.profile ?? migrateManifestToProfile(inventory.scan.manifest)
  const existing = new Set(profile.vault.map(vaultRecordId))
  const additions = [...discovered]
    .filter(([id]) => !existing.has(id))
    .map(([, secret]) => secret.reference)
  if (additions.length === 0 && files.length === 0) return
  const approved =
    ctx.flags.yes ||
    (!ctx.flags.json &&
      (await askYesNo(
        ctx,
        `Import ${discovered.size} referenced MCP credentials into the encrypted account vault?`,
        false,
      )))
  if (!approved)
    throw cliError('mcp-import-required', 'MCP credential import requires confirmation', {
      hint: 'Run laurencio sync interactively or pass --yes to import the discovered references.',
    })
  if (ctx.platform !== 'darwin' && ctx.platform !== 'win32')
    throw cliError('unsupported-platform', 'MCP credentials require macOS or Windows')
  const io = createSystemCredentialIo(
    { ...ctx.env },
    {
      durableMcp: {
        platform: ctx.platform,
        ...(ctx.deps.keychain === undefined ? {} : { keychain: ctx.deps.keychain }),
      },
    },
  )
  const references = [...discovered.values()].map((secret) => secret.reference)
  const imported = await reconcileCredentialVault({
    ...input,
    references,
    baselines: {},
    tokenEnv: adapterContext(ctx),
    io: {
      ...io,
      async readMcpSecret(harness, server, env) {
        const secret = [...discovered.values()].find(
          (item) =>
            item.reference.harness === harness &&
            item.reference.server === server &&
            item.reference.env === env,
        )
        return secret?.value === null || secret?.value === undefined
          ? io.readMcpSecret(harness, server, env)
          : new TextEncoder().encode(secret.value)
      },
    },
    now: () => ctx.now().toISOString(),
  })
  if (imported.results.some((result) => result.status === 'conflict'))
    throw cliError(
      'mcp-secret-conflict',
      'MCP credentials differ from the account vault; local configuration was preserved',
    )
  if (imported.results.some((result) => result.status === 'missing'))
    throw cliError(
      'mcp-secret-missing',
      'A referenced MCP credential is missing from the environment and OS credential store',
    )
  // Independent heads: vault first, profile second, configuration last. CAS failure
  // leaves the source recoverable and retrying cannot overwrite a concurrent rotation.
  if (additions.length > 0)
    await savePortableProfile({
      ...input,
      profile: { ...profile, vault: [...profile.vault, ...additions] },
      expectedGeneration: stored?.head.generation ?? null,
    })
  for (const secret of discovered.values()) {
    if (secret.value === null) continue
    const value = new TextEncoder().encode(secret.value)
    try {
      await io.writeMcpSecret(
        secret.reference.harness,
        secret.reference.server,
        secret.reference.env,
        value,
      )
    } finally {
      value.fill(0)
    }
  }
  for (const file of files)
    if (fs.readFileSync(file.path, 'utf8') !== file.original)
      throw cliError('mcp-config-changed', 'MCP configuration changed during import; retry sync')
  if (files.length > 0)
    createBackup(
      ctx.home,
      files.map((file, index) => ({ label: `mcp-import-${index + 1}`, path: file.path })),
      ctx.now(),
    )
  for (const file of files)
    await io.writeFileAtomic(file.path, new TextEncoder().encode(file.content), 0o600)
}
