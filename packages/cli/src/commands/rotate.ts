/**
 * `laurencio rotate` re-encrypts the store under a new passphrase.
 *
 * A rotation is two transactions in order: first the re-encrypted revision is
 * committed, then the new KDF parameters are published. A device that enrolls
 * in between would derive from the old parameters and find a revision it
 * cannot open, so the parameters only go out once the commit has landed. If
 * publishing fails after the commit, the pending record left in state lets
 * `rotate --resume` finish the publication without re-encrypting.
 */

import {
  acquireLock,
  crypto,
  KdfGenerationConflictError,
  KdfValidationError,
  type Manifest,
  type ManifestEntry,
  openProfile,
  type PublishedKdfParams,
  parseManifest,
  type RevisionRecord,
  releaseLock,
  StaleParentsError,
  type SyncState,
  sealProfile,
  supportsProfile,
  supportsVault,
  Vault,
} from '@laurencio/core'
import { newId, PROTOCOL_VERSION, type RevisionId, type StoreId } from '@laurencio/protocol'
import type { CommandContext } from '../context'
import { cliError } from '../errors'
import {
  clearPendingRotation,
  type KeyEpochRecord,
  type PendingRotation,
  readPendingRotation,
  writeKeyEpoch,
  writePendingRotation,
} from '../key-epoch'
import { ensureProfileV2 } from '../profile-version'
import { readNewPassphrase, readPassphrase } from '../prompt'
import { ok } from '../result'
import type { CliSession } from '../session'
import { keychainOptions, openSession, openState } from '../session'
import { plural, shortId } from '../ui'
import type { CommandSpec } from './command'

export interface RotateData {
  resumed: boolean
  alreadyPublished: boolean
  revisionId: string
  epoch: number
  generation: number
  reEncrypted: number
  replaced: number
  bytesBefore: number
  bytesAfter: number
  keyBackend: string
}

const RESUME_HINT =
  'The revision is committed and this device already uses the new passphrase. Run `laurencio rotate --resume` to publish the parameters.'

function manifestOpen(storeId: StoreId, key: crypto.KeyMaterial, bytes: Uint8Array): string {
  return crypto.openText(key, 'manifest', bytes, {
    storeId,
    blobType: 'manifest',
    protocolVersion: PROTOCOL_VERSION,
  })
}

function openManifest(session: CliSession, key: crypto.KeyMaterial, bytes: Uint8Array): Manifest {
  let text: string
  try {
    text = manifestOpen(session.credentials.storeId, key, bytes)
  } catch (error) {
    if (error instanceof crypto.EnvelopeError) {
      throw cliError('wrong-passphrase', 'that passphrase does not open this store', {
        hint: 'Check the passphrase and try again. Without it the data cannot be recovered.',
      })
    }
    throw error
  }
  return parseManifest(JSON.parse(text), text.length)
}

function publishError(error: unknown): Error {
  if (error instanceof KdfGenerationConflictError) {
    return cliError(
      'rotation-conflict',
      `another device rotated the store (expected generation ${error.expected})`,
      { hint: 'Run `laurencio unlock` with the current passphrase, then rotate again.' },
    )
  }
  if (error instanceof KdfValidationError) {
    return cliError('kdf-rejected', `the server rejected the new parameters: ${error.message}`)
  }
  const reason = error instanceof Error ? error.message : String(error)
  return cliError('kdf-publish-failed', `the new parameters were not published: ${reason}`, {
    hint: RESUME_HINT,
  })
}

/** Publishes pending parameters and verifies the store reports the generation. */
async function publishPending(
  session: CliSession,
  state: SyncState,
  pending: PendingRotation,
): Promise<PublishedKdfParams> {
  let published: PublishedKdfParams
  try {
    published = await session.remote.putKdfParams({
      params: pending.kdf,
      calibratedAt: pending.createdAt,
      expectedGeneration: pending.expectedGeneration,
    })
  } catch (error) {
    throw publishError(error)
  }
  let confirmed: PublishedKdfParams | null
  try {
    confirmed = await session.remote.getKdfParams()
  } catch (error) {
    throw publishError(error)
  }
  if (
    confirmed === null ||
    confirmed.generation !== published.generation ||
    confirmed.kdf.salt !== pending.kdf.salt
  ) {
    throw cliError(
      'kdf-verify-failed',
      `the store did not confirm KDF generation ${published.generation} after publishing`,
      { hint: RESUME_HINT },
    )
  }
  clearPendingRotation(state)
  return published
}

interface RotationOutcome {
  revisionId: string
  epoch: number
  generation: number
  reEncrypted: number
  replaced: number
  bytesBefore: number
  bytesAfter: number
  keyBackend: string
  alreadyPublished: boolean
}

/** Adopts the committed rotation revision into local state. */
function adoptRotation(
  session: CliSession,
  state: SyncState,
  input: {
    epoch: KeyEpochRecord
    entries: ManifestEntry[]
    revision: RevisionRecord
  },
): void {
  state.saveManifest(input.revision, input.entries)
  state.setBaseRevision(input.revision.id)
  state.setKnownHeads(session.credentials.storeId, [input.revision.id])
  writeKeyEpoch(state, input.epoch)
}

/** Runs an async action with a key and zeroizes the key once it settles. */
async function withKey<T>(key: crypto.KeyMaterial, action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } finally {
    key.zeroize()
  }
}

interface SidecarRotationStats {
  reEncrypted: number
  replaced: number
  bytesBefore: number
  bytesAfter: number
}

/** Idempotently re-encrypts metadata heads before the new KDF generation is published. */
async function ensureSidecarHeadsRotated(
  session: CliSession,
  oldKey: crypto.KeyMaterial,
  newKey: crypto.KeyMaterial,
): Promise<SidecarRotationStats> {
  const context = {
    storeId: session.credentials.storeId,
    protocolVersion: PROTOCOL_VERSION,
  }
  const stats: SidecarRotationStats = {
    reEncrypted: 0,
    replaced: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  }

  if (supportsProfile(session.remote)) {
    const head = await session.remote.getProfileHead()
    if (head !== null) {
      const ciphertext = await session.remote.getBlob(head.blob.id)
      try {
        let needsRotation = false
        try {
          openProfile(newKey, ciphertext, context)
        } catch (error) {
          if (!(error instanceof crypto.EnvelopeError)) throw error
          needsRotation = true
        }
        if (needsRotation) {
          const profile = openProfile(oldKey, ciphertext, context)
          const sealed = sealProfile(profile, newKey, context)
          try {
            const blob = await session.remote.putBlob({
              blobId: sealed.blobId,
              bytes: sealed.bytes,
            })
            await session.remote.putProfileHead({
              blob,
              expectedGeneration: head.generation,
            })
            stats.reEncrypted += 1
            stats.replaced += 1
            stats.bytesBefore += ciphertext.length
            stats.bytesAfter += sealed.bytes.length
          } finally {
            sealed.bytes.fill(0)
          }
        }
      } finally {
        ciphertext.fill(0)
      }
    }
  }

  if (supportsVault(session.remote)) {
    const head = await session.remote.getVaultHead()
    if (head !== null) {
      const ciphertext = await session.remote.getBlob(head.blob.id)
      let vault: Vault | null = null
      try {
        let needsRotation = false
        try {
          const current = Vault.open(newKey, ciphertext, context)
          current.zeroize()
        } catch (error) {
          if (!(error instanceof crypto.EnvelopeError)) throw error
          needsRotation = true
        }
        if (needsRotation) {
          vault = Vault.open(oldKey, ciphertext, context)
          const sealed = vault.seal(newKey, context)
          try {
            const blob = await session.remote.putBlob({
              blobId: sealed.blobId,
              bytes: sealed.bytes,
            })
            await session.remote.putVaultHead({
              blob,
              expectedGeneration: head.generation,
            })
            stats.reEncrypted += 1
            stats.replaced += 1
            stats.bytesBefore += ciphertext.length
            stats.bytesAfter += sealed.bytes.length
          } finally {
            sealed.bytes.fill(0)
          }
        }
      } finally {
        vault?.zeroize()
        ciphertext.fill(0)
      }
    }
  }

  return stats
}

async function runRotation(ctx: CommandContext): Promise<RotationOutcome> {
  const session = await openSession(ctx)
  await ensureProfileV2(session.remote)
  const state = openState(ctx)
  const holder = acquireLock(ctx.home)
  try {
    const pending = readPendingRotation(state)
    if (pending !== null) {
      throw cliError(
        'rotation-pending',
        `a rotation for revision ${shortId(pending.revisionId)} is waiting to be published`,
        { hint: 'Run `laurencio rotate --resume`.' },
      )
    }
    const current = await session.remote.getKdfParams()
    if (current === null) {
      throw cliError('no-kdf', 'the store has no passphrase parameters yet', {
        hint: 'Run `laurencio enroll` on the first device.',
      })
    }
    const page = await session.remote.listRevisions()
    const headId = page.heads[0] ?? page.head
    if (headId === null || headId === undefined) {
      throw cliError('nothing-to-rotate', 'the store has no revisions yet', {
        hint: 'Run `laurencio sync` first.',
      })
    }
    if (page.heads.length > 1) {
      throw cliError(
        'forked-store',
        `the store has ${plural(page.heads.length, 'head')}; merge them before rotating`,
        { hint: 'Run `laurencio sync` on each device, then rotate.' },
      )
    }
    const headMeta = page.revisions.find((revision) => revision.id === headId)
    const headBytes = await session.remote.getManifest(headId)
    const passphrase = await readPassphrase(ctx)
    const newPassphrase = await readNewPassphrase(ctx)
    if (newPassphrase === passphrase) {
      throw cliError('same-passphrase', 'the new passphrase must differ from the current one')
    }
    const oldKey = crypto.deriveMasterKey(passphrase, current.kdf)
    const result = await withKey(oldKey, async () => {
      const manifest = openManifest(session, oldKey, headBytes)
      const rotated = await crypto.rotateStore({
        remote: session.remote,
        storeId: session.credentials.storeId,
        protocolVersion: PROTOCOL_VERSION,
        deviceId: session.credentials.deviceId,
        master: oldKey,
        head: { revisionId: headId, parents: headMeta?.parents ?? [], manifest },
        newRevisionId: ctx.deps.createRevisionId?.() ?? (newId() as RevisionId),
        newPassphrase,
        createdAt: ctx.now().toISOString(),
        epoch: current.generation,
        ...(ctx.deps.calibrate === undefined ? {} : { calibrate: ctx.deps.calibrate }),
      })
      const pending: PendingRotation = {
        epoch: rotated.epoch.epoch,
        generation: current.generation + 1,
        expectedGeneration: current.generation,
        revisionId: rotated.revision.id,
        kdf: rotated.epoch.kdf,
        createdAt: rotated.epoch.createdAt,
      }
      // The manifest commit is the first remote write under the new key. Persist recovery data
      // immediately, before rotating either sidecar or replacing the cached key.
      writePendingRotation(state, pending)
      try {
        const sidecars = await ensureSidecarHeadsRotated(session, oldKey, rotated.master)
        return {
          ...rotated,
          pending,
          sidecarReplaced: sidecars.replaced,
          stats: {
            reEncrypted: rotated.stats.reEncrypted + sidecars.reEncrypted,
            bytesBefore: rotated.stats.bytesBefore + sidecars.bytesBefore,
            bytesAfter: rotated.stats.bytesAfter + sidecars.bytesAfter,
          },
        }
      } catch (error) {
        rotated.master.zeroize()
        throw error
      }
    })

    return await withKey(result.master, async () => {
      const cache = await crypto.openKeyCache(keychainOptions(ctx))
      const keyBackend = await cache.save(session.credentials.storeId, result.master)
      adoptRotation(session, state, {
        epoch: {
          epoch: result.epoch.epoch,
          salt: result.epoch.kdf.salt,
          createdAt: result.epoch.createdAt,
        },
        entries: result.entries,
        revision: {
          id: result.revision.id,
          deviceId: result.revision.deviceId,
          parents: [...result.revision.parents],
          createdAt: result.revision.createdAt,
          manifest: { ...result.revision.manifest },
          digest: result.digest,
          role: 'base',
        },
      })
      const published = await publishPending(session, state, result.pending)
      return {
        revisionId: result.revision.id,
        epoch: result.epoch.epoch,
        generation: published.generation,
        reEncrypted: result.stats.reEncrypted,
        replaced: result.replaced.length + result.sidecarReplaced,
        bytesBefore: result.stats.bytesBefore,
        bytesAfter: result.stats.bytesAfter,
        keyBackend,
        alreadyPublished: false,
      } satisfies RotationOutcome
    })
  } catch (error) {
    if (error instanceof StaleParentsError) {
      throw cliError(
        'stale-store',
        'the store head advanced while rotating; nothing was published',
        {
          hint: 'Run `laurencio rotate` again to start from the new head.',
        },
      )
    }
    throw error
  } finally {
    state.close()
    releaseLock(ctx.home, holder.pid, holder)
  }
}

/**
 * The key a pending rotation needs. The cached key normally opens the revision
 * already; after a crash between the commit and the cache write, the new
 * passphrase is asked for and the cache is repaired.
 */
async function ensurePendingKey(
  ctx: CommandContext,
  session: CliSession,
  pending: PendingRotation,
): Promise<{ key: crypto.KeyMaterial; derived: boolean }> {
  const bytes = await session.remote.getManifest(pending.revisionId)
  const opens = (key: crypto.KeyMaterial): boolean => {
    try {
      manifestOpen(session.credentials.storeId, key, bytes)
      return true
    } catch (error) {
      if (error instanceof crypto.EnvelopeError) return false
      throw error
    }
  }
  if (opens(session.credentials.key)) return { key: session.credentials.key, derived: false }
  const passphrase = await readNewPassphrase(ctx)
  const derived = crypto.deriveMasterKey(passphrase, pending.kdf)
  if (!opens(derived)) {
    derived.zeroize()
    throw cliError('wrong-passphrase', 'that passphrase does not open the pending rotation', {
      hint: 'Pass the new passphrase set when this rotation committed.',
    })
  }
  return { key: derived, derived: true }
}

async function resumeRotation(ctx: CommandContext): Promise<RotationOutcome> {
  const session = await openSession(ctx)
  await ensureProfileV2(session.remote)
  const state = openState(ctx)
  const holder = acquireLock(ctx.home)
  try {
    const pending = readPendingRotation(state)
    if (pending === null) {
      throw cliError('nothing-to-resume', 'no rotation is waiting to be published on this device', {
        hint: 'Run `laurencio rotate` to start one.',
      })
    }
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const latest = await session.remote.getKdfParams()
    if (latest !== null && latest.kdf.salt === pending.kdf.salt) {
      clearPendingRotation(state)
      return {
        revisionId: pending.revisionId,
        epoch: pending.epoch,
        generation: latest.generation,
        reEncrypted: 0,
        replaced: 0,
        bytesBefore: 0,
        bytesAfter: 0,
        keyBackend: cache.backend,
        alreadyPublished: true,
      }
    }
    if (latest !== null && latest.generation !== pending.expectedGeneration) {
      throw cliError(
        'rotation-conflict',
        `the store moved to generation ${latest.generation} while this rotation was unpublished`,
        { hint: 'Run `laurencio unlock` with the current passphrase, then rotate again.' },
      )
    }
    const pendingKey = await ensurePendingKey(ctx, session, pending)
    try {
      const sidecars = pendingKey.derived
        ? await ensureSidecarHeadsRotated(session, session.credentials.key, pendingKey.key)
        : { reEncrypted: 0, replaced: 0, bytesBefore: 0, bytesAfter: 0 }
      if (pendingKey.derived) {
        await cache.save(session.credentials.storeId, pendingKey.key)
        writeKeyEpoch(state, {
          epoch: pending.epoch,
          salt: pending.kdf.salt,
          createdAt: pending.createdAt,
        })
      }
      const published = await publishPending(session, state, pending)
      return {
        revisionId: pending.revisionId,
        epoch: pending.epoch,
        generation: published.generation,
        reEncrypted: sidecars.reEncrypted,
        replaced: sidecars.replaced,
        bytesBefore: sidecars.bytesBefore,
        bytesAfter: sidecars.bytesAfter,
        keyBackend: cache.backend,
        alreadyPublished: false,
      }
    } finally {
      if (pendingKey.derived) pendingKey.key.zeroize()
    }
  } finally {
    state.close()
    releaseLock(ctx.home, holder.pid, holder)
  }
}

export const rotateCommand: CommandSpec = {
  name: 'rotate',
  summary: 'Re-encrypt the store under a new passphrase and publish it',
  usage: 'laurencio rotate [--resume] [--passphrase-file <path>] [--yes] [--json]',
  details: [
    'Prompts for the current passphrase and the new one. Scripted runs read',
    'LAURENCIO_PASSPHRASE and LAURENCIO_NEW_PASSPHRASE.',
    '--resume publishes parameters from a rotation whose commit already landed.',
  ],
  async run(ctx) {
    const outcome = ctx.flags.resume ? await resumeRotation(ctx) : await runRotation(ctx)
    const data: RotateData = {
      resumed: ctx.flags.resume,
      alreadyPublished: outcome.alreadyPublished,
      revisionId: outcome.revisionId,
      epoch: outcome.epoch,
      generation: outcome.generation,
      reEncrypted: outcome.reEncrypted,
      replaced: outcome.replaced,
      bytesBefore: outcome.bytesBefore,
      bytesAfter: outcome.bytesAfter,
      keyBackend: outcome.keyBackend,
    }
    const human = (): string => {
      if (outcome.alreadyPublished) {
        return `KDF generation ${outcome.generation} was already published for revision ${shortId(outcome.revisionId)}.`
      }
      if (ctx.flags.resume) {
        return `Published KDF generation ${outcome.generation} for revision ${shortId(outcome.revisionId)}. No blobs were re-encrypted.`
      }
      return [
        `Rotated to epoch ${outcome.epoch} and published KDF generation ${outcome.generation}.`,
        `Re-encrypted ${plural(outcome.reEncrypted, 'blob')} (${outcome.bytesBefore} to ${outcome.bytesAfter} bytes); ${outcome.replaced} old blobs are now unreferenced.`,
        `Revision: ${outcome.revisionId}`,
        `Key cached in the ${outcome.keyBackend} store.`,
        'Revisions committed before this rotation stay sealed with the old key and cannot be read or restored. Run `laurencio export` before rotating if you may need them.',
      ].join('\n')
    }
    return ok(data, human)
  },
}
