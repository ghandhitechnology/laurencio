/**
 * Passphrase handling for init, login, and unlock. New stores calibrate
 * Argon2id and publish the public parameters; existing stores derive from the
 * published parameters and verify against the head manifest when one exists.
 * The derived key caches in the OS keychain so the daemon can run unattended.
 */

import { crypto, type Remote } from '@laurencio/core'
import type { StoreId } from '@laurencio/protocol'
import { PROTOCOL_VERSION } from '@laurencio/protocol'
import type { CommandContext } from './context'
import { cliError } from './errors'
import { writeKeyEpoch } from './key-epoch'
import { keychainOptions, openState } from './session'

export interface KeySetupInput {
  remote: Remote
  storeId: StoreId
  token: string
  baseUrl: string | null
  passphrase: string
}

export interface KeySetupResult {
  kdf: crypto.KdfParams
  /** Store generation the cached key belongs to. */
  generation: number
  backend: crypto.CredentialBackend
  calibratedMs: number | null
}

/** Records which generation the freshly cached key belongs to, for doctor. */
function recordKeyEpoch(ctx: CommandContext, generation: number, kdf: crypto.KdfParams): void {
  const state = openState(ctx)
  try {
    writeKeyEpoch(state, {
      epoch: generation,
      salt: kdf.salt,
      createdAt: ctx.now().toISOString(),
    })
  } finally {
    state.close()
  }
}

async function verifyAgainstHead(input: {
  remote: Remote
  storeId: StoreId
  key: crypto.KeyMaterial
}): Promise<void> {
  const page = await input.remote.listRevisions({ limit: 1 })
  if (page.head === null) return
  const bytes = await input.remote.getManifest(page.head)
  try {
    crypto.openText(input.key, 'manifest', bytes, {
      storeId: input.storeId,
      blobType: 'manifest',
      protocolVersion: PROTOCOL_VERSION,
    })
  } catch (error) {
    if (error instanceof crypto.EnvelopeError) {
      throw cliError('wrong-passphrase', 'that passphrase does not open this store', {
        hint: 'Check the passphrase and try again. Without it the data cannot be recovered.',
      })
    }
    throw error
  }
}

/**
 * Derives the store key from `input.passphrase`, creating and publishing
 * parameters when the store has none yet, then caches the key.
 */
export async function setStoreKey(
  ctx: CommandContext,
  input: KeySetupInput,
): Promise<KeySetupResult> {
  const published = await input.remote.getKdfParams()
  let kdf: crypto.KdfParams
  let generation: number
  let calibratedMs: number | null = null
  if (published === null) {
    kdf = (ctx.deps.calibrate ?? (() => crypto.calibrateKdf()))()
    calibratedMs = kdf.calibrationMs ?? null
    const stored = await input.remote.putKdfParams({
      params: kdf,
      calibratedAt: ctx.now().toISOString(),
    })
    kdf = stored.kdf
    generation = stored.generation
  } else {
    kdf = published.kdf
    generation = published.generation
  }
  const key = crypto.deriveMasterKey(input.passphrase, kdf)
  try {
    await verifyAgainstHead({ remote: input.remote, storeId: input.storeId, key })
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const backend = await cache.save(input.storeId, key)
    recordKeyEpoch(ctx, generation, kdf)
    return { kdf, generation, backend, calibratedMs }
  } finally {
    key.zeroize()
  }
}

/** Derives and caches a key for an existing store, verifying it when possible. */
export async function unlockStoreKey(
  ctx: CommandContext,
  input: Omit<KeySetupInput, 'baseUrl'> & { baseUrl?: string | null },
): Promise<KeySetupResult> {
  const published = await input.remote.getKdfParams()
  if (published === null) {
    throw cliError('no-kdf', 'the store has no passphrase parameters yet', {
      hint: 'Run `laurencio enroll` on the first device.',
    })
  }
  const kdf = published.kdf
  const key = crypto.deriveMasterKey(input.passphrase, kdf)
  try {
    await verifyAgainstHead({ remote: input.remote, storeId: input.storeId, key })
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const backend = await cache.save(input.storeId, key)
    recordKeyEpoch(ctx, published.generation, kdf)
    return { kdf, generation: published.generation, backend, calibratedMs: null }
  } finally {
    key.zeroize()
  }
}

export function describeKdf(kdf: crypto.KdfParams, calibratedMs: number | null): string {
  const time = calibratedMs === null ? '' : `, ${calibratedMs} ms`
  return `Argon2id ${kdf.m} KiB memory, ${kdf.t} passes, ${kdf.p} lane${kdf.p === 1 ? '' : 's'}${time}`
}
