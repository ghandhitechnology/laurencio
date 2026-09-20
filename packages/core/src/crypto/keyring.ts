/**
 * Derived-key cache.
 *
 * The master key is cached so the daemon can run unattended. The primary cache
 * is the OS keychain; the macOS fallback is a 0600 file
 * under `$HOME/.laurencio/keys`, which is a declared never-sync location.
 * Windows uses Credential Manager and never falls back to plaintext files.
 *
 * The keychain module is imported lazily so the file path still works when the
 * native binding is missing or the store is locked.
 */

import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type { StoreId } from '@laurencio/protocol'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { KEY_BYTES, KeyMaterial } from './kdf'
import { WindowsCredentialError, windowsCredentialStore } from './windows-keyring'

export const KEYCHAIN_SERVICE = 'laurencio'
const KEYCHAIN_PROBE_ACCOUNT = 'laurencio-probe'

export type CredentialBackend = 'keychain' | 'file'

export interface CredentialStore {
  readonly backend: CredentialBackend
  get(service: string, account: string): Promise<Uint8Array | null>
  set(service: string, account: string, secret: Uint8Array): Promise<void>
  delete(service: string, account: string): Promise<void>
}

export interface KeyCache {
  readonly backend: CredentialBackend
  load(storeId: StoreId): Promise<KeyMaterial | null>
  save(storeId: StoreId, key: KeyMaterial): Promise<CredentialBackend>
  forget(storeId: StoreId): Promise<void>
}

export interface KeyCacheOptions {
  home: string
  /** Injected keychain backend. Tests pass a stub; production resolves the real one. */
  keychain?: CredentialStore | null
  /** Set false to disable the file fallback. Windows always disables it. */
  allowFileFallback?: boolean
  platform?: NodeJS.Platform
  warn?: (message: string) => void
  /** Injectable keychain resolution, for tests. */
  loadKeyring?: () => Promise<CredentialStore>
}

export const KEY_CACHE_DIR = '.laurencio/keys'

export function keyCacheDir(home: string): string {
  return `${home}/${KEY_CACHE_DIR}`
}

export function keyCacheFilePath(home: string, storeId: StoreId): string {
  return `${keyCacheDir(home)}/${storeId}.key`
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  )
}

function defaultWarn(message: string): void {
  process.emitWarning(message, { code: 'LAURENCIO_KEY_CACHE' })
}

/** Uses macOS Keychain or the standalone Windows Credential Manager bridge. */
export async function resolveKeychainStore(): Promise<CredentialStore> {
  if (process.platform === 'win32') return windowsCredentialStore()
  const keyring = (await import('@napi-rs/keyring')) as {
    Entry: new (
      service: string,
      account: string,
    ) => {
      getSecret(): Array<number> | null
      setSecret(secret: Uint8Array): void
      deleteCredential(): boolean
    }
  }
  return {
    backend: 'keychain',
    async get(service, account) {
      const secret = new keyring.Entry(service, account).getSecret()
      return secret === null ? null : Uint8Array.from(secret)
    },
    async set(service, account, secret) {
      new keyring.Entry(service, account).setSecret(secret)
    },
    async delete(service, account) {
      new keyring.Entry(service, account).deleteCredential()
    },
  }
}

interface FileCacheOptions {
  home: string
  platform: NodeJS.Platform
  warn: (message: string) => void
}

function readFileCache(storeId: StoreId, options: FileCacheOptions): KeyMaterial | null {
  const path = keyCacheFilePath(options.home, storeId)
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return null
    throw error
  }
  if (options.platform !== 'win32') {
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) {
      options.warn(`refusing to read ${path}: mode is ${mode.toString(8)}, expected 600`)
      return null
    }
  }
  const hex = raw.trim()
  if (hex.length !== KEY_BYTES * 2) {
    options.warn(`ignoring ${path}: expected ${KEY_BYTES * 2} hex characters`)
    return null
  }
  return new KeyMaterial(hexToBytes(hex))
}

function writeFileCache(storeId: StoreId, key: KeyMaterial, options: FileCacheOptions): void {
  mkdirSync(keyCacheDir(options.home), { recursive: true, mode: 0o700 })
  const path = keyCacheFilePath(options.home, storeId)
  writeFileSync(path, `${bytesToHex(key.borrow())}\n`, { mode: 0o600 })
  if (options.platform !== 'win32') chmodSync(path, 0o600)
}

export async function openKeyCache(options: KeyCacheOptions): Promise<KeyCache> {
  const warn = options.warn ?? defaultWarn
  const platform = options.platform ?? process.platform
  const allowFileFallback = platform !== 'win32' && (options.allowFileFallback ?? true)
  const fileOptions: FileCacheOptions = { home: options.home, platform, warn }

  let keychain: CredentialStore | null = options.keychain ?? null
  if (options.keychain === undefined) {
    try {
      const candidate = await (options.loadKeyring ?? resolveKeychainStore)()
      // A read probe is not enough: a locked store or a denied prompt fails on
      // write, which is exactly the unattended daemon case. Probe both, then
      // clean up the probe entry.
      const probe = new Uint8Array(KEY_BYTES).fill(1)
      try {
        await candidate.set(KEYCHAIN_SERVICE, KEYCHAIN_PROBE_ACCOUNT, probe)
        await candidate.get(KEYCHAIN_SERVICE, KEYCHAIN_PROBE_ACCOUNT)
      } finally {
        probe.fill(0)
        try {
          await candidate.delete(KEYCHAIN_SERVICE, KEYCHAIN_PROBE_ACCOUNT)
        } catch {
          // A probe entry that cannot be deleted is harmless and will be
          // overwritten by the next probe.
        }
      }
      keychain = candidate
    } catch (error) {
      if (platform === 'win32' && error instanceof WindowsCredentialError) throw error
      const reason = error instanceof Error ? error.message : String(error)
      if (allowFileFallback)
        warn(
          `keychain unavailable (${reason}); using the 0600 file cache under ${keyCacheDir(options.home)}`,
        )
      keychain = null
    }
  }

  const backend: CredentialBackend = keychain === null ? 'file' : 'keychain'
  if (backend === 'file' && !allowFileFallback) {
    throw new Error(
      platform === 'win32'
        ? 'Windows Credential Manager is unavailable; unlock it and retry.'
        : 'keychain unavailable and the file fallback is disabled',
    )
  }

  return {
    backend,
    async load(storeId) {
      if (keychain !== null) {
        try {
          const secret = await keychain.get(KEYCHAIN_SERVICE, storeId)
          if (secret !== null && secret.length === KEY_BYTES) return new KeyMaterial(secret)
        } catch (error) {
          if (!allowFileFallback) throw error
          const reason = error instanceof Error ? error.message : String(error)
          warn(`keychain read failed (${reason}); falling back to the file cache`)
        }
      }
      if (!allowFileFallback) return null
      return readFileCache(storeId, fileOptions)
    },
    async save(storeId, key) {
      if (keychain !== null) {
        try {
          const copy = key.copyBytes()
          try {
            await keychain.set(KEYCHAIN_SERVICE, storeId, copy)
          } finally {
            copy.fill(0)
          }
          return 'keychain'
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (!allowFileFallback) throw error
          warn(
            `keychain write failed (${reason}); using the 0600 file cache under ${keyCacheDir(options.home)}`,
          )
        }
      }
      if (!allowFileFallback) {
        throw new Error('keychain unavailable and the file fallback is disabled')
      }
      writeFileCache(storeId, key, fileOptions)
      return 'file'
    },
    async forget(storeId) {
      if (keychain !== null) {
        try {
          await keychain.delete(KEYCHAIN_SERVICE, storeId)
        } catch (error) {
          if (!allowFileFallback) throw error
          const reason = error instanceof Error ? error.message : String(error)
          warn(`keychain delete failed (${reason})`)
        }
      }
      try {
        rmSync(keyCacheFilePath(options.home, storeId))
      } catch (error) {
        if (!isMissing(error)) throw error
      }
    },
  }
}
