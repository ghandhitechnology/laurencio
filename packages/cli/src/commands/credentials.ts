import {
  DEFAULT_VAULT_REFERENCES,
  supportsProfile,
  supportsVault,
  type VaultReference,
} from '@laurencio/core'
import { requirePositional } from '../args'
import { adapterContext } from '../context'
import {
  readCredentialBaselines,
  selectedCredentialReferences,
  writeCredentialBaselines,
} from '../credential-sync'
import { cliError } from '../errors'
import { ensureProfileV2 } from '../profile-version'
import { ok } from '../result'
import { openSession, openState } from '../session'
import { createSystemCredentialIo } from '../workbench/credentials'
import { loadPortableProfile } from '../workbench/profile'
import {
  captureCredentialVault,
  materializeCredentialVault,
  reconcileCredentialVault,
} from '../workbench/vault'
import type { CommandSpec } from './command'

type ResolutionDirection = 'keep-local' | 'keep-remote'

interface CredentialResolutionData {
  name: string
  kind: VaultReference['kind']
  harness: VaultReference['harness']
  direction: ResolutionDirection
  status: 'resolved'
  version: number
}

const USAGE = 'laurencio credentials resolve <reference> (--keep-local|--keep-remote) [--json]'

function selectedDirection(keepLocal: boolean, keepRemote: boolean): ResolutionDirection {
  if (keepLocal === keepRemote) {
    throw cliError('bad-flags', 'pass exactly one of --keep-local or --keep-remote', {
      hint: `Usage: ${USAGE}`,
    })
  }
  return keepLocal ? 'keep-local' : 'keep-remote'
}

function referenceNamed(references: readonly VaultReference[], name: string): VaultReference {
  const matches = references.filter((reference) => reference.name === name)
  if (matches.length === 0) {
    throw cliError('unknown-credential', `unknown credential reference: ${name}`, {
      hint: `Available references: ${references.map((reference) => reference.name).join(', ') || 'none'}`,
    })
  }
  if (matches.length > 1) {
    throw cliError('ambiguous-credential', `credential reference is ambiguous: ${name}`)
  }
  const reference = matches[0]
  if (reference === undefined) throw new Error('credential selection invariant failed')
  return reference
}

export const credentialsCommand: CommandSpec = {
  name: 'credentials',
  summary: 'Resolve encrypted credential conflicts explicitly',
  usage: USAGE,
  details: [
    'Use keep-local to replace the encrypted account copy with this device login.',
    'Use keep-remote to replace this device login with the encrypted account copy.',
    'Output contains reference metadata only.',
  ],
  async run(ctx) {
    if (ctx.subcommand !== 'resolve') {
      throw cliError(
        'unknown-subcommand',
        `unknown credentials subcommand: ${ctx.subcommand ?? ''}`,
        { hint: 'Known: resolve' },
      )
    }
    const name = requirePositional(ctx.positionals, 1, 'reference', USAGE)
    const direction = selectedDirection(ctx.flags.keepLocal, ctx.flags.keepRemote)
    const session = await openSession(ctx)
    await ensureProfileV2(session.remote)
    if (!supportsVault(session.remote)) {
      throw cliError('vault-unavailable', 'this remote does not support encrypted credentials')
    }
    if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
      throw cliError('unsupported-platform', 'credential resolution supports macOS and Windows')
    }

    let references: readonly VaultReference[] = DEFAULT_VAULT_REFERENCES
    if (supportsProfile(session.remote)) {
      const stored = await loadPortableProfile({
        remote: session.remote,
        storeId: session.credentials.storeId,
        key: session.credentials.key,
      })
      if (stored !== null) references = stored.profile.vault
    }
    const eligible = selectedCredentialReferences(
      references,
      session.config.policy,
      ctx.flags.harness,
    )
    const reference = referenceNamed(eligible, name)
    const selected = [reference]
    const io = createSystemCredentialIo(ctx.env, {
      durableMcp: {
        platform: ctx.platform,
        ...(ctx.deps.keychain === undefined ? {} : { keychain: ctx.deps.keychain }),
      },
    })
    const vaultInput = {
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
      references: selected,
      tokenEnv: adapterContext(ctx),
      io,
    }
    const state = openState(ctx)
    try {
      const operation =
        direction === 'keep-local'
          ? (
              await captureCredentialVault({
                ...vaultInput,
                now: () => ctx.now().toISOString(),
              })
            ).results[0]
          : (await materializeCredentialVault(vaultInput))[0]
      if (operation === undefined || operation.status === 'missing') {
        const location = direction === 'keep-local' ? 'local' : 'account'
        throw cliError('credential-missing', `${location} credential is missing: ${name}`)
      }

      const reconciled = await reconcileCredentialVault({
        ...vaultInput,
        baselines: readCredentialBaselines(state),
        now: () => ctx.now().toISOString(),
      })
      const verified = reconciled.results[0]
      if (
        verified === undefined ||
        verified.status === 'conflict' ||
        verified.status === 'missing' ||
        verified.version === undefined
      ) {
        throw cliError('credential-conflict', `credential changed during resolution: ${name}`, {
          hint: 'Run the credentials resolve command again after checking the local and account logins.',
        })
      }
      writeCredentialBaselines(state, reconciled.baselines)
      const data: CredentialResolutionData = {
        name: reference.name,
        kind: reference.kind,
        harness: reference.harness,
        direction,
        status: 'resolved',
        version: verified.version,
      }
      return ok(
        data,
        () =>
          `Resolved ${data.name} with ${data.direction === 'keep-local' ? 'this device login' : 'the account login'} (version ${data.version}).`,
      )
    } finally {
      state.close()
    }
  },
}
