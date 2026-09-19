/**
 * Session assembly: identity, credentials, remote, state, policy, and adapters.
 * Every command that talks to the store opens one of these. The remote factory
 * and the keychain are injectable, so tests never touch the network or the OS
 * keychain.
 */

import {
  builtinAdapters,
  CredentialsError,
  createFileRemote,
  createHttpRemote,
  crypto,
  type DeviceIdentity,
  type DevicePolicy,
  type HarnessAdapter,
  type HarnessId,
  httpErrorFromResponse,
  loadCredentials,
  type Manifest,
  openTokenStore,
  PROTOCOL_HEADER,
  parseManifest,
  type Remote,
  type RemoteUsage,
  readDeviceIdentity,
  type ScannedEntry,
  type ScanResult,
  type Surface,
  type SyncCredentials,
  SyncState,
  scan,
  type TokenStoreOptions,
  tokenAccount,
} from '@laurencio/core'
import {
  type BlobId,
  DeviceId,
  type DeviceId as DeviceIdType,
  type DeviceRecord,
  DeviceRenameRequest,
  newId,
  PROTOCOL_VERSION,
  RevisionId,
  type RevisionId as RevisionIdType,
  type StoreId,
} from '@laurencio/protocol'
import { type CliConfig, effectiveAdapters, loadCliConfig } from './config'
import { adapterContext, type CommandContext, remoteDirFlag } from './context'
import { cliError } from './errors'
import { collectProbes } from './probes'

export interface CliSession {
  identity: DeviceIdentity
  credentials: SyncCredentials
  config: CliConfig
  remote: Remote
  baseUrl: string | null
  remoteDir: string | null
}

export function keychainOptions(ctx: CommandContext): TokenStoreOptions {
  if (ctx.deps.keychain !== undefined) return { home: ctx.home, keychain: ctx.deps.keychain }
  // Testing lever: keep the OS keychain untouched in scripted runs.
  if (ctx.env.LAURENCIO_KEYCHAIN === 'file') return { home: ctx.home, keychain: null }
  return { home: ctx.home }
}

export function baseUrlFor(ctx: CommandContext, config: CliConfig): string | null {
  const fromFlag = ctx.flags.server
  if (fromFlag !== undefined && fromFlag !== '') return fromFlag
  const fromEnv = ctx.env.LAURENCIO_SERVER
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  return config.server
}

export async function openRemote(
  ctx: CommandContext,
  input: { storeId: StoreId; token: string; baseUrl: string | null },
): Promise<Remote> {
  const dir = remoteDirFlag(ctx)
  if (ctx.deps.remote !== undefined) {
    return ctx.deps.remote({ storeId: input.storeId, token: input.token, baseUrl: input.baseUrl })
  }
  if (dir !== null) {
    try {
      return createFileRemote({ dir })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw cliError('bad-remote', `could not open the test remote at ${dir}: ${reason}`)
    }
  }
  if (input.baseUrl === null) {
    throw cliError('no-server', 'no server is configured for this device', {
      hint: 'Run `laurencio init --server <url>` or set LAURENCIO_SERVER.',
    })
  }
  return createHttpRemote({
    baseUrl: input.baseUrl,
    storeId: input.storeId,
    token: input.token,
    ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
    retry: { attempts: 2 },
  })
}

export async function openSession(ctx: CommandContext): Promise<CliSession> {
  const config = loadCliConfig(ctx.home)
  const baseUrl = baseUrlFor(ctx, config)
  let credentials: SyncCredentials
  try {
    credentials = await loadCredentials(keychainOptions(ctx))
  } catch (error) {
    if (error instanceof CredentialsError) {
      const hint =
        error.code === 'not-enrolled'
          ? 'Run `laurencio init` to sign in and select surfaces.'
          : error.code === 'missing-key'
            ? 'Run `laurencio unlock` with the store passphrase.'
            : 'Run `laurencio login` to sign in again.'
      throw cliError(error.code, error.message, { hint })
    }
    throw error
  }
  const remote = await openRemote(ctx, {
    storeId: credentials.storeId,
    token: credentials.token,
    baseUrl,
  })
  return {
    identity: readDeviceIdentity(ctx.home) ?? {
      version: 1,
      deviceId: credentials.deviceId,
      storeId: credentials.storeId,
      name: 'unknown',
      platform: ctx.platform,
      createdAt: ctx.now().toISOString(),
    },
    credentials,
    config,
    remote,
    baseUrl,
    remoteDir: remoteDirFlag(ctx),
  }
}

/** Identity read from the device file, or null when this device is not enrolled. */
export function identityFor(ctx: CommandContext): DeviceIdentity | null {
  return readDeviceIdentity(ctx.home)
}

/** Probe or reuse precomputed harness facts, as a context the adapters can read. */
export function withProbes(ctx: CommandContext): CommandContext {
  if (ctx.deps.probes !== undefined) return ctx
  return { ...ctx, deps: { ...ctx.deps, probes: collectProbes({ home: ctx.home, env: ctx.env }) } }
}

export function openState(ctx: CommandContext): SyncState {
  return SyncState.open({ home: ctx.home })
}

function selectedAdapters(ctx: CommandContext): readonly HarnessAdapter[] {
  const requested = ctx.flags.harness
  const known: readonly HarnessId[] = ['claude', 'codex', 'opencode']
  for (const id of requested) {
    if (!known.includes(id as HarnessId)) {
      throw cliError('unknown-harness', `unknown harness: ${id}`, {
        hint: `Known harnesses: ${known.join(', ')}`,
      })
    }
  }
  return requested.length === 0
    ? builtinAdapters
    : builtinAdapters.filter((adapter) => requested.includes(adapter.id))
}

export function adaptersFor(ctx: CommandContext, policy: DevicePolicy): HarnessAdapter[] {
  return effectiveAdapters(selectedAdapters(ctx), policy)
}

export function allAdaptersFor(ctx: CommandContext): HarnessAdapter[] {
  return [...selectedAdapters(ctx)]
}

export interface LocalInventory {
  scan: ScanResult
  surfaces: Map<string, Surface>
  byStorePath: Map<string, ScannedEntry>
  adapters: HarnessAdapter[]
  policy: DevicePolicy
}

/**
 * `mode: 'all'` keeps disabled and opt-in surfaces in the map, for inventory
 * views. Sessions that plan or sync use the default effective filtering.
 */
export function scanInventory(
  ctx: CommandContext,
  options: {
    policy: DevicePolicy
    deviceId?: DeviceIdType
    revisionId?: RevisionIdType
    mode?: 'effective' | 'all'
  },
): LocalInventory {
  // Scan ids are cosmetic for planning; a fresh id keeps callers short.
  const deviceId = options.deviceId ?? DeviceId.parse(newId())
  const revisionId = options.revisionId ?? RevisionId.parse(newId())
  const adapters = options.mode === 'all' ? allAdaptersFor(ctx) : adaptersFor(ctx, options.policy)
  const result = scan({
    adapters,
    ctx: adapterContext(ctx),
    deviceId,
    revisionId,
    createdAt: ctx.now().toISOString(),
  })
  const surfaces = new Map<string, Surface>()
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces(adapterContext(ctx))) surfaces.set(surface.id, surface)
  }
  const byStorePath = new Map<string, ScannedEntry>()
  for (const entry of result.entries) {
    if (entry.storePath !== null) byStorePath.set(entry.storePath, entry)
  }
  return { scan: result, surfaces, byStorePath, adapters, policy: options.policy }
}

export interface RemoteManifestView {
  manifest: Manifest | null
  head: RevisionId | null
}

/** The remote manifest at the current head, decrypted. */
export async function loadRemoteManifest(
  session: CliSession,
  localBase: RevisionId | null,
): Promise<RemoteManifestView> {
  const page = await session.remote.listRevisions()
  const head = page.head
  if (head === null) return { manifest: null, head: null }
  if (head === localBase) return { manifest: null, head }
  const bytes = await session.remote.getManifest(head)
  return { manifest: await decryptManifest(session, bytes), head }
}

export async function decryptManifest(session: CliSession, bytes: Uint8Array): Promise<Manifest> {
  const text = decryptText(session, bytes, 'manifest')
  return parseManifest(JSON.parse(text))
}

export function decryptText(
  session: CliSession,
  bytes: Uint8Array,
  blobType: 'file' | 'manifest',
): string {
  return crypto.openText(
    session.credentials.key,
    blobType === 'file' ? 'content' : 'manifest',
    bytes,
    {
      storeId: session.credentials.storeId,
      blobType,
      protocolVersion: PROTOCOL_VERSION,
    },
  )
}

export async function readRemoteBlob(session: CliSession, blobId: BlobId): Promise<string> {
  const bytes = await session.remote.getBlob(blobId)
  return decryptText(session, bytes, 'file')
}

export async function remoteUsage(session: CliSession): Promise<RemoteUsage | null> {
  const withUsage = session.remote as Remote & { getUsage?: () => Promise<RemoteUsage> }
  if (typeof withUsage.getUsage !== 'function') return null
  return withUsage.getUsage()
}

export interface DeviceAdmin {
  rename(deviceId: string, name: string): Promise<DeviceRecord>
  revoke(deviceId: string): Promise<DeviceRecord>
}

/** Device admin over HTTP, or over the FileRemote lever in tests. */
export function deviceAdmin(ctx: CommandContext, session: CliSession): DeviceAdmin {
  const fileRemote = session.remote as Remote & { upsertDevice?: (device: DeviceRecord) => void }
  if (typeof fileRemote.upsertDevice === 'function') {
    const upsert = fileRemote.upsertDevice.bind(fileRemote)
    return {
      async rename(deviceId, name) {
        const existing = await findDevice(session.remote, deviceId)
        const record: DeviceRecord = { ...existing, name }
        upsert(record)
        return record
      },
      async revoke(deviceId) {
        const existing = await findDevice(session.remote, deviceId)
        const record: DeviceRecord = { ...existing, revokedAt: ctx.now().toISOString() }
        upsert(record)
        return record
      },
    }
  }
  const call = async (deviceId: string, init: RequestInit): Promise<DeviceRecord> => {
    if (session.baseUrl === null) throw cliError('no-server', 'no server is configured')
    const response = await (ctx.deps.fetch ?? globalThis.fetch)(
      new URL(`/v1/devices/${deviceId}`, session.baseUrl).toString(),
      {
        ...init,
        headers: {
          authorization: `Bearer ${session.credentials.token}`,
          'content-type': 'application/json',
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
          ...(init.headers ?? {}),
        },
      },
    )
    if (!response.ok) throw await httpErrorFromResponse(response, 'device update')
    const body = (await response.json()) as { device: DeviceRecord }
    return body.device
  }
  return {
    rename: (deviceId, name) =>
      call(deviceId, {
        method: 'PATCH',
        body: JSON.stringify(DeviceRenameRequest.parse({ name })),
      }),
    revoke: (deviceId) => call(deviceId, { method: 'DELETE' }),
  }
}

async function findDevice(remote: Remote, deviceId: string): Promise<DeviceRecord> {
  const devices = await remote.listDevices()
  const found = devices.find((device) => device.id === deviceId)
  if (found === undefined) throw cliError('unknown-device', `no device with id ${deviceId}`)
  return found
}

/** True when the master key for this store is cached on the device. */
export async function keyCached(ctx: CommandContext, storeId: StoreId): Promise<boolean> {
  const cache = await crypto.openKeyCache(keychainOptions(ctx))
  const key = await cache.load(storeId)
  if (key === null) return false
  key.zeroize()
  return true
}

/** The device token from the keychain or the 0600 file store. */
export async function deviceToken(ctx: CommandContext, deviceId: DeviceId): Promise<string> {
  const store = await openTokenStore(keychainOptions(ctx))
  const raw = await store.get(crypto.KEYCHAIN_SERVICE, tokenAccount(deviceId))
  if (raw === null) {
    throw cliError('missing-token', 'the device token is missing', {
      hint: 'Run `laurencio login` to sign in again.',
    })
  }
  return new TextDecoder().decode(raw)
}
