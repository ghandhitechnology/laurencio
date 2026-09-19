import { describe, expect, test } from 'bun:test'
import { mkdtempSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StoreId } from '@laurencio/protocol'
import { ARGON2_VERSION, deriveMasterKey, type KeyMaterial } from '../../src/crypto/kdf'
import {
  type CredentialStore,
  KEYCHAIN_SERVICE,
  keyCacheDir,
  keyCacheFilePath,
  openKeyCache,
} from '../../src/crypto/keyring'

const storeId = StoreId.parse('0123456789ABCDEFGHJKMNPQRS')
const otherStore = StoreId.parse('0123456789ABCDEFGHJKMNPQRT')

function testKey(passphrase = 'passphrase'): KeyMaterial {
  return deriveMasterKey(passphrase, {
    algo: 'argon2id',
    salt: 'ab'.repeat(16),
    m: 8,
    t: 1,
    p: 1,
    version: ARGON2_VERSION,
  })
}

function stubKeychain(): CredentialStore & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>()
  return {
    backend: 'keychain',
    entries,
    async get(service, account) {
      const found = entries.get(`${service}/${account}`)
      return found === undefined ? null : found.slice()
    },
    async set(service, account, secret) {
      entries.set(`${service}/${account}`, secret.slice())
    },
    async delete(service, account) {
      entries.delete(`${service}/${account}`)
    },
  }
}

function scratchHome(): string {
  return mkdtempSync(join(tmpdir(), 'laurencio-keyring-'))
}

describe('keychain path', () => {
  test('saves and loads through the keychain', async () => {
    const keychain = stubKeychain()
    const cache = await openKeyCache({ home: scratchHome(), keychain })
    expect(cache.backend).toBe('keychain')
    const key = testKey()
    expect(await cache.save(storeId, key)).toBe('keychain')
    const loaded = await cache.load(storeId)
    expect(loaded).not.toBeNull()
    expect(Buffer.from(loaded?.borrow() ?? [])).toEqual(Buffer.from(key.borrow()))
    expect(keychain.entries.size).toBe(1)
    key.zeroize()
    loaded?.zeroize()
  })

  test('forget removes the keychain entry', async () => {
    const keychain = stubKeychain()
    const cache = await openKeyCache({ home: scratchHome(), keychain })
    const key = testKey()
    await cache.save(storeId, key)
    await cache.forget(storeId)
    expect(await cache.load(storeId)).toBeNull()
    expect(keychain.entries.size).toBe(0)
    key.zeroize()
  })

  test('a missing keychain entry falls back to the file cache', async () => {
    const home = scratchHome()
    const keychain = stubKeychain()
    const cache = await openKeyCache({ home, keychain })
    const key = testKey()
    await cache.save(storeId, key)
    // Simulate a reboot on headless Linux: keychain memory is gone, the file is not.
    keychain.entries.clear()
    const loaded = await cache.load(storeId)
    expect(loaded).toBeNull()
    key.zeroize()
  })
})

describe('file fallback', () => {
  test('an unavailable keychain falls back with a warning', async () => {
    const warnings: string[] = []
    const cache = await openKeyCache({
      home: scratchHome(),
      loadKeyring: async () => {
        throw new Error('Platform failure: User interaction is not allowed.')
      },
      warn: (message) => warnings.push(message),
    })
    expect(cache.backend).toBe('file')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('keychain unavailable')
    expect(warnings[0]).toContain('.laurencio/keys')
  })

  test('a keychain that can read but not write is treated as unavailable', async () => {
    const warnings: string[] = []
    const readsOnly: CredentialStore = {
      backend: 'keychain',
      async get() {
        return null
      },
      async set() {
        throw new Error('User interaction is not allowed.')
      },
      async delete() {
        return
      },
    }
    const cache = await openKeyCache({
      home: scratchHome(),
      loadKeyring: async () => readsOnly,
      warn: (message) => warnings.push(message),
    })
    expect(cache.backend).toBe('file')
    expect(warnings.some((message) => message.includes('keychain unavailable'))).toBe(true)
  })

  test('the probe cleans up after itself on a working keychain', async () => {
    const keychain = stubKeychain()
    const cache = await openKeyCache({ home: scratchHome(), keychain })
    expect(cache.backend).toBe('keychain')
    expect(keychain.entries.size).toBe(0)
  })

  test('writes the key 0600 under .laurencio/keys and never in a synced path', async () => {
    const home = scratchHome()
    const cache = await openKeyCache({ home, keychain: null })
    const key = testKey()
    expect(await cache.save(storeId, key)).toBe('file')
    const path = keyCacheFilePath(home, storeId)
    expect(path.startsWith(keyCacheDir(home))).toBe(true)
    expect(path).toContain('.laurencio/keys')
    const mode = statSync(path).mode & 0o777
    expect(mode).toBe(0o600)
    const dirMode = statSync(keyCacheDir(home)).mode & 0o777
    expect(dirMode).toBe(0o700)
    const loaded = await cache.load(storeId)
    expect(Buffer.from(loaded?.borrow() ?? [])).toEqual(Buffer.from(key.borrow()))
    key.zeroize()
    loaded?.zeroize()
  })

  test('refuses a key file whose permissions widened', async () => {
    const home = scratchHome()
    const warnings: string[] = []
    const cache = await openKeyCache({
      home,
      keychain: null,
      warn: (message) => warnings.push(message),
    })
    const key = testKey()
    await cache.save(storeId, key)
    const path = keyCacheFilePath(home, storeId)
    const { chmodSync } = await import('node:fs')
    chmodSync(path, 0o644)
    expect(await cache.load(storeId)).toBeNull()
    expect(warnings.some((message) => message.includes('expected 600'))).toBe(true)
    key.zeroize()
  })

  test('ignores a truncated key file instead of deriving a short key', async () => {
    const home = scratchHome()
    const warnings: string[] = []
    const cache = await openKeyCache({
      home,
      keychain: null,
      warn: (message) => warnings.push(message),
    })
    const path = keyCacheFilePath(home, storeId)
    const { mkdirSync } = await import('node:fs')
    mkdirSync(keyCacheDir(home), { recursive: true, mode: 0o700 })
    writeFileSync(path, 'deadbeef\n', { mode: 0o600 })
    expect(await cache.load(storeId)).toBeNull()
    expect(warnings.some((message) => message.includes('hex characters'))).toBe(true)
  })

  test('forget removes the file', async () => {
    const home = scratchHome()
    const cache = await openKeyCache({ home, keychain: null })
    const key = testKey()
    await cache.save(storeId, key)
    await cache.forget(storeId)
    expect(await cache.load(storeId)).toBeNull()
    key.zeroize()
  })

  test('keys are cached per store id', async () => {
    const home = scratchHome()
    const cache = await openKeyCache({ home, keychain: null })
    const key = testKey()
    await cache.save(storeId, key)
    expect(await cache.load(otherStore)).toBeNull()
    key.zeroize()
  })

  test('the file fallback can be disabled for a strict posture', async () => {
    await expect(
      openKeyCache({ home: scratchHome(), keychain: null, allowFileFallback: false }),
    ).rejects.toThrow('file fallback is disabled')
  })
})

describe('service naming', () => {
  test('the keychain service is namespaced to laurencio', () => {
    expect(KEYCHAIN_SERVICE).toBe('laurencio')
  })
})
