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
import { keychainOptions } from './session'

export interface KeySetupInput {
  remote: Remote
  storeId: StoreId
  token: string
  baseUrl: string | null
  passphrase: string
}

export interface KeySetupResult {
  kdf: crypto.KdfParams
  backend: crypto.CredentialBackend
  calibratedMs: number | null
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

async function putKdfParams(
  ctx: CommandContext,
  input: { baseUrl: string | null; storeId: string; token: string; kdf: crypto.KdfParams },
): Promise<void> {
  if (input.baseUrl === null) {
    throw cliError('no-server', 'a new store needs a server to publish KDF parameters')
  }
  const response = await (ctx.deps.fetch ?? globalThis.fetch)(
    new URL(`/v1/stores/${input.storeId}/kdf-params`, input.baseUrl).toString(),
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${input.token}`,
        'content-type': 'application/json',
        'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
      },
      body: JSON.stringify(crypto.kdfParamsToWire(input.kdf, ctx.now().toISOString())),
    },
  )
  if (!response.ok) {
    const body = await response.text()
    throw cliError(
      'kdf-publish-failed',
      `could not publish KDF parameters (${response.status}): ${body.slice(0, 200)}`,
    )
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
  let calibratedMs: number | null = null
  if (published === null) {
    kdf = (ctx.deps.calibrate ?? (() => crypto.calibrateKdf()))()
    calibratedMs = kdf.calibrationMs ?? null
    await putKdfParams(ctx, {
      baseUrl: input.baseUrl,
      storeId: input.storeId,
      token: input.token,
      kdf,
    })
    const stored = await input.remote.getKdfParams()
    if (stored !== null) kdf = stored
  } else {
    kdf = published
  }
  const key = crypto.deriveMasterKey(input.passphrase, kdf)
  try {
    await verifyAgainstHead({ remote: input.remote, storeId: input.storeId, key })
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const backend = await cache.save(input.storeId, key)
    return { kdf, backend, calibratedMs }
  } finally {
    key.zeroize()
  }
}

/** Derives and caches a key for an existing store, verifying it when possible. */
export async function unlockStoreKey(
  ctx: CommandContext,
  input: Omit<KeySetupInput, 'baseUrl'> & { baseUrl?: string | null },
): Promise<KeySetupResult> {
  const kdf = await input.remote.getKdfParams()
  if (kdf === null) {
    throw cliError('no-kdf', 'the store has no passphrase parameters yet', {
      hint: 'Run `laurencio init` on the first device.',
    })
  }
  const key = crypto.deriveMasterKey(input.passphrase, kdf)
  try {
    await verifyAgainstHead({ remote: input.remote, storeId: input.storeId, key })
    const cache = await crypto.openKeyCache(keychainOptions(ctx))
    const backend = await cache.save(input.storeId, key)
    return { kdf, backend, calibratedMs: null }
  } finally {
    key.zeroize()
  }
}

export function describeKdf(kdf: crypto.KdfParams, calibratedMs: number | null): string {
  const time = calibratedMs === null ? '' : `, ${calibratedMs} ms`
  return `Argon2id ${kdf.m} KiB memory, ${kdf.t} passes, ${kdf.p} lane${kdf.p === 1 ? '' : 's'}${time}`
}
