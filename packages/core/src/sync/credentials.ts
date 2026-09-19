/**
 * Device credentials: the identity record under `~/.laurencio/device.json`,
 * the device token in the OS keychain, and the master key from the key cache.
 * The identity file holds ids and names only; the token and the key never
 * touch it.
 *
 * `loginWithDeviceCode` is the explicit RFC 8628 state machine behind
 * `laurencio login`: request a code, show it, poll until the account approves,
 * then mint the device and store its token. `refreshCredentials` re-reads the
 * cached material and verifies it against the server, which is how a revoked
 * device fails fast before a sync run starts.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  DeviceId,
  type MeResponse,
  MeResponse as MeResponseSchema,
  PROTOCOL_VERSION,
  StoreId,
} from '@laurencio/protocol'
import type { KeyMaterial } from '../crypto/kdf'
import {
  type CredentialBackend,
  type CredentialStore,
  KEYCHAIN_SERVICE,
  openKeyCache,
  resolveKeychainStore,
} from '../crypto/keyring'
import { httpErrorFromResponse, PROTOCOL_HEADER } from '../remote/http'
import { LAURENCIO_DIR } from '../secrets/scan'
import type { Platform } from '../types'

export const DEFAULT_DEVICE_CLIENT_ID = 'laurencio-cli'
export const DEVICE_FILE_NAME = 'device.json'
export const TOKEN_DIR = '.laurencio/tokens'

export type CredentialsErrorCode =
  | 'not-enrolled'
  | 'missing-token'
  | 'missing-key'
  | 'store-mismatch'
  | 'login-denied'
  | 'login-expired'
  | 'login-timeout'
  | 'login-failed'

export class CredentialsError extends Error {
  readonly code: CredentialsErrorCode

  constructor(code: CredentialsErrorCode, message: string) {
    super(message)
    this.name = 'CredentialsError'
    this.code = code
  }
}

export interface DeviceIdentity {
  version: 1
  deviceId: DeviceId
  storeId: StoreId
  name: string
  platform: Platform
  createdAt: string
}

export interface SyncCredentials {
  deviceId: DeviceId
  storeId: StoreId
  token: string
  key: KeyMaterial
  /** Where the device token actually landed: the keychain or the 0600 file. */
  backend: CredentialBackend
}

export function deviceIdentityPath(home: string): string {
  return path.join(home, LAURENCIO_DIR, DEVICE_FILE_NAME)
}

export function readDeviceIdentity(home: string): DeviceIdentity | null {
  let raw: string
  try {
    raw = fs.readFileSync(deviceIdentityPath(home), 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    const deviceId = DeviceId.safeParse(record.deviceId)
    const storeId = StoreId.safeParse(record.storeId)
    const platform = record.platform
    if (record.version !== 1 || !deviceId.success || !storeId.success) return null
    if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') return null
    if (typeof record.name !== 'string' || typeof record.createdAt !== 'string') return null
    return {
      version: 1,
      deviceId: deviceId.data,
      storeId: storeId.data,
      name: record.name,
      platform,
      createdAt: record.createdAt,
    }
  } catch {
    return null
  }
}

export function writeDeviceIdentity(home: string, identity: DeviceIdentity): string {
  const filePath = deviceIdentityPath(home)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(tempPath, filePath)
  return filePath
}

export function clearDeviceIdentity(home: string): void {
  fs.rmSync(deviceIdentityPath(home), { force: true })
}

export function tokenAccount(deviceId: DeviceId): string {
  return `device-token:${deviceId}`
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value)
}

function tokenFilePath(home: string, account: string): string {
  const safe = account.replace(/[^A-Za-z0-9._-]+/g, '_')
  return path.join(home, TOKEN_DIR, `${safe}.token`)
}

export interface TokenStoreOptions {
  home: string
  /** Injected keychain backend. Tests pass a stub; production resolves the real one. */
  keychain?: CredentialStore | null
  /** Set false to disable the 0600 file fallback entirely. */
  allowFileFallback?: boolean
  platform?: NodeJS.Platform
  warn?: (message: string) => void
  loadKeyring?: () => Promise<CredentialStore>
}

interface ResolvedBackend {
  keychain: CredentialStore | null
  warn: (message: string) => void
  platform: NodeJS.Platform
  allowFileFallback: boolean
}

function defaultWarn(message: string): void {
  process.emitWarning(message, { code: 'LAURENCIO_TOKEN_CACHE' })
}

async function resolveBackend(options: TokenStoreOptions): Promise<ResolvedBackend> {
  const allowFileFallback = options.allowFileFallback ?? true
  const platform = options.platform ?? process.platform
  const warn = options.warn ?? defaultWarn
  let keychain: CredentialStore | null = options.keychain ?? null
  if (options.keychain === undefined) {
    try {
      keychain = await (options.loadKeyring ?? resolveKeychainStore)()
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      warn(`keychain unavailable (${reason}); device tokens fall back to the 0600 file store`)
      keychain = null
    }
  }
  if (keychain === null && !allowFileFallback) {
    throw new CredentialsError(
      'missing-token',
      'keychain unavailable and the file fallback is disabled',
    )
  }
  return { keychain, warn, platform, allowFileFallback }
}

function makeTokenStore(resolved: ResolvedBackend, home: string): CredentialStore {
  const warn = resolved.warn
  return {
    backend: resolved.keychain === null ? 'file' : 'keychain',
    async get(service, account) {
      if (resolved.keychain !== null) {
        try {
          const secret = await resolved.keychain.get(service, account)
          if (secret !== null) return secret
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          warn(`keychain read failed (${reason}); falling back to the file store`)
        }
      }
      if (!resolved.allowFileFallback) return null
      const filePath = tokenFilePath(home, account)
      let raw: string
      try {
        raw = fs.readFileSync(filePath, 'utf8')
      } catch {
        return null
      }
      if (resolved.platform !== 'win32') {
        const mode = fs.statSync(filePath).mode & 0o777
        if ((mode & 0o077) !== 0) {
          warn(`refusing to read ${filePath}: mode is ${mode.toString(8)}, expected 600`)
          return null
        }
      }
      const trimmed = raw.trim()
      return trimmed === '' ? null : encode(trimmed)
    },
    async set(service, account, secret) {
      if (resolved.keychain !== null) {
        try {
          await resolved.keychain.set(service, account, secret)
          return
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (!resolved.allowFileFallback) throw error
          warn(`keychain write failed (${reason}); using the 0600 file store`)
        }
      }
      const filePath = tokenFilePath(home, account)
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
      fs.writeFileSync(filePath, `${decode(secret)}\n`, { mode: 0o600 })
      if (resolved.platform !== 'win32') fs.chmodSync(filePath, 0o600)
    },
    async delete(service, account) {
      if (resolved.keychain !== null) {
        try {
          await resolved.keychain.delete(service, account)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          warn(`keychain delete failed (${reason})`)
        }
      }
      fs.rmSync(tokenFilePath(home, account), { force: true })
    },
  }
}

export async function openTokenStore(options: TokenStoreOptions): Promise<CredentialStore> {
  return makeTokenStore(await resolveBackend(options), options.home)
}

export async function storeCredentials(
  options: TokenStoreOptions,
  input: { identity: DeviceIdentity; token: string },
): Promise<CredentialBackend> {
  writeDeviceIdentity(options.home, input.identity)
  const store = await openTokenStore(options)
  await store.set(KEYCHAIN_SERVICE, tokenAccount(input.identity.deviceId), encode(input.token))
  return store.backend
}

export async function clearCredentials(
  options: TokenStoreOptions & { deviceId: DeviceId },
): Promise<void> {
  const store = await openTokenStore(options)
  await store.delete(KEYCHAIN_SERVICE, tokenAccount(options.deviceId))
  clearDeviceIdentity(options.home)
}

export interface LoadCredentialsOptions extends TokenStoreOptions {
  /** Rejects credentials that point at another store. */
  storeId?: StoreId
}

/**
 * Loads the identity, the device token, and the cached master key. Throws a
 * `CredentialsError` when this device is not enrolled, the token is missing, or
 * the key cache is empty (the user has to unlock or log in again).
 */
export async function loadCredentials(options: LoadCredentialsOptions): Promise<SyncCredentials> {
  const identity = readDeviceIdentity(options.home)
  if (identity === null) {
    throw new CredentialsError(
      'not-enrolled',
      'this device is not enrolled; run `laurencio login` first',
    )
  }
  if (options.storeId !== undefined && identity.storeId !== options.storeId) {
    throw new CredentialsError(
      'store-mismatch',
      `this device is enrolled for store ${identity.storeId}, not ${options.storeId}`,
    )
  }
  const resolved = await resolveBackend(options)
  const store = makeTokenStore(resolved, options.home)
  const raw = await store.get(KEYCHAIN_SERVICE, tokenAccount(identity.deviceId))
  if (raw === null) {
    throw new CredentialsError(
      'missing-token',
      'the device token is missing from the keychain; run `laurencio login` again',
    )
  }
  const keyCache = await openKeyCache({
    home: options.home,
    keychain: resolved.keychain,
    allowFileFallback: resolved.allowFileFallback,
    platform: resolved.platform,
    warn: resolved.warn,
  })
  const key = await keyCache.load(identity.storeId)
  if (key === null) {
    throw new CredentialsError(
      'missing-key',
      'the store key is not cached on this device; run `laurencio unlock` with the passphrase',
    )
  }
  return {
    deviceId: identity.deviceId,
    storeId: identity.storeId,
    token: decode(raw),
    key,
    backend: store.backend,
  }
}

export interface RefreshOptions extends LoadCredentialsOptions {
  baseUrl: string
  fetch?: typeof fetch
}

/**
 * Verifies the cached credentials against `/v1/me` and returns them. Device
 * tokens are non-expiring today, so a rejection always means revoked or
 * unknown: it surfaces as `DeviceAuthError` and the caller re-runs login.
 */
export async function refreshCredentials(options: RefreshOptions): Promise<SyncCredentials> {
  const credentials = await loadCredentials(options)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(new URL('/v1/me', options.baseUrl).toString(), {
    headers: {
      authorization: `Bearer ${credentials.token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
  })
  if (!response.ok) {
    throw await httpErrorFromResponse(response, 'credential check')
  }
  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new CredentialsError(
      'login-failed',
      `the server's account view was not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const parsed = MeResponseSchema.safeParse(body)
  if (!parsed.success) {
    throw new CredentialsError('login-failed', 'the account view did not match the protocol')
  }
  const me: MeResponse = parsed.data
  if (me.storeId !== credentials.storeId) {
    throw new CredentialsError(
      'store-mismatch',
      `the server put this account on store ${me.storeId}, the device is enrolled for ${credentials.storeId}`,
    )
  }
  return credentials
}

interface DeviceCodeResponse {
  deviceCode: string
  userCode: string
  verificationUri: string | null
  verificationUriComplete: string | null
  expiresIn: number
  intervalSeconds: number
}

export interface DeviceCodePrompt {
  userCode: string
  verificationUri: string
  verificationUriComplete: string | null
  expiresAt: string
  intervalSeconds: number
}

export interface DeviceLoginOptions extends TokenStoreOptions {
  baseUrl: string
  deviceName: string
  platform: Platform
  clientId?: string
  fetch?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  /** Called once with the code to show the user; may approve the code itself in tests. */
  onPrompt?: (prompt: DeviceCodePrompt) => void | Promise<void>
  /** Test lever: stop after this many pending polls. */
  maxPolls?: number
}

export interface DeviceLoginResult {
  identity: DeviceIdentity
  token: string
  backend: CredentialBackend
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

async function loginJson(response: Response, label: string): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new CredentialsError('login-failed', `${label} returned invalid JSON`)
  }
  const record = asRecord(body)
  if (record === null) throw new CredentialsError('login-failed', `${label} returned no object`)
  return record
}

function readDeviceCode(body: Record<string, unknown>): DeviceCodeResponse {
  const deviceCode = readString(body, 'device_code')
  const userCode = readString(body, 'user_code')
  const expiresIn = readNumber(body, 'expires_in')
  const interval = readNumber(body, 'interval')
  if (deviceCode === null || userCode === null || expiresIn === null) {
    throw new CredentialsError('login-failed', 'the device code response was incomplete')
  }
  return {
    deviceCode,
    userCode,
    verificationUri: readString(body, 'verification_uri'),
    verificationUriComplete: readString(body, 'verification_uri_complete'),
    expiresIn,
    intervalSeconds: Math.max(0, interval ?? 5),
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Drives the whole device flow: request the code, surface it, poll for
 * approval, then create the device record and cache its token. The returned
 * identity is what `status`, `devices`, and the daemon read afterwards.
 */
export async function loginWithDeviceCode(options: DeviceLoginOptions): Promise<DeviceLoginResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const now = options.now ?? (() => Date.now())
  const clientId = options.clientId ?? DEFAULT_DEVICE_CLIENT_ID
  const base = new URL(options.baseUrl)

  const codeResponse = await fetchImpl(new URL('/api/auth/device/code', base).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId }),
  })
  if (!codeResponse.ok) {
    const message = await codeResponse.text()
    throw new CredentialsError(
      'login-failed',
      `could not request a device code (${codeResponse.status}): ${message.slice(0, 200)}`,
    )
  }
  const code = readDeviceCode(await loginJson(codeResponse, 'device code request'))
  const expiresAt = new Date(now() + code.expiresIn * 1000).toISOString()
  const prompt: DeviceCodePrompt = {
    userCode: code.userCode,
    verificationUri: code.verificationUri ?? new URL('/device', base).toString(),
    verificationUriComplete: code.verificationUriComplete,
    expiresAt,
    intervalSeconds: code.intervalSeconds,
  }
  await options.onPrompt?.(prompt)

  let intervalMs = Math.max(0, code.intervalSeconds) * 1000
  let polls = 0
  let accessToken: string | null = null
  for (;;) {
    if (options.maxPolls !== undefined && polls >= options.maxPolls) {
      throw new CredentialsError('login-timeout', 'gave up waiting for device approval')
    }
    if (now() > new Date(expiresAt).getTime()) {
      throw new CredentialsError('login-expired', 'the device code expired before it was approved')
    }
    polls += 1
    const tokenResponse = await fetchImpl(new URL('/api/auth/device/token', base).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.deviceCode,
        client_id: clientId,
      }),
    })
    if (tokenResponse.ok) {
      const body = await loginJson(tokenResponse, 'device token request')
      accessToken = readString(body, 'access_token')
      if (accessToken === null) {
        throw new CredentialsError('login-failed', 'the token response had no access_token')
      }
      break
    }
    const errorBody = await loginJson(tokenResponse, 'device token request')
    const errorCode = readString(errorBody, 'error') ?? ''
    const description = readString(errorBody, 'error_description') ?? errorCode
    if (errorCode === 'authorization_pending') {
      await sleep(intervalMs)
      continue
    }
    if (errorCode === 'slow_down') {
      intervalMs += 5000
      await sleep(intervalMs)
      continue
    }
    if (errorCode === 'access_denied') {
      throw new CredentialsError('login-denied', 'the device code was denied')
    }
    if (errorCode === 'expired_token') {
      throw new CredentialsError('login-expired', 'the device code expired before it was approved')
    }
    throw new CredentialsError(
      'login-failed',
      `device token request failed (${tokenResponse.status}): ${description}`,
    )
  }

  const deviceResponse = await fetchImpl(new URL('/v1/devices', base).toString(), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
    body: JSON.stringify({ name: options.deviceName, platform: options.platform }),
  })
  if (!deviceResponse.ok) {
    throw await httpErrorFromResponse(deviceResponse, 'device enrollment')
  }
  const deviceBody = await loginJson(deviceResponse, 'device enrollment')
  const token = readString(deviceBody, 'token')
  const device = asRecord(deviceBody.device)
  const deviceId = device === null ? null : DeviceId.safeParse(device.id)
  if (token === null || deviceId === null || !deviceId.success) {
    throw new CredentialsError('login-failed', 'the enrollment response had no device id or token')
  }

  const meResponse = await fetchImpl(new URL('/v1/me', base).toString(), {
    headers: {
      authorization: `Bearer ${token}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    },
  })
  if (!meResponse.ok) {
    throw await httpErrorFromResponse(meResponse, 'account view')
  }
  const meBody = MeResponseSchema.safeParse(await loginJson(meResponse, 'account view'))
  if (!meBody.success) {
    throw new CredentialsError('login-failed', 'the account view did not match the protocol')
  }

  const identity: DeviceIdentity = {
    version: 1,
    deviceId: deviceId.data,
    storeId: meBody.data.storeId,
    name: options.deviceName,
    platform: options.platform,
    createdAt: new Date(now()).toISOString(),
  }
  const backend = await storeCredentials(options, { identity, token })
  return { identity, token, backend }
}
