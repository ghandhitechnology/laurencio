import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { StoreId } from '@laurencio/protocol'
import { KeyMaterial } from '../src/crypto/kdf'
import { type CredentialStore, openKeyCache } from '../src/crypto/keyring'
import { WindowsCredentialError, windowsCredentialStore } from '../src/crypto/windows-keyring'
import { openTokenStore } from '../src/sync/credentials'

test('Windows credential bridge keeps secrets out of commands and preserves binary bytes', async () => {
  const value = new Uint8Array([0, 128, 255, 37])
  const requests: Record<string, unknown>[] = []
  const store = windowsCredentialStore(async (executable, args, input) => {
    expect(executable).toEndWith('System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toContain('-NoProfile')
    expect(args.join(' ')).not.toContain(Buffer.from(value).toString('base64'))
    const request = JSON.parse(input)
    requests.push(request)
    return JSON.stringify({
      ok: true,
      secret: request.operation === 'get' ? Buffer.from(value).toString('base64') : null,
    })
  })
  await store.set('service', 'account', value)
  expect(await store.get('service', 'account')).toEqual(value)
  await store.delete('service', 'account')
  expect(requests.map((request) => request.operation)).toEqual(['set', 'get', 'delete'])
  expect(requests[0]?.secret).toBe(Buffer.from(value).toString('base64'))
})

test('Windows credential bridge distinguishes absent credentials and unsupported logons', async () => {
  expect(
    await windowsCredentialStore(async () => '{"ok":true,"secret":null}').get('s', 'a'),
  ).toBeNull()
  await expect(
    windowsCredentialStore(async () => '{"ok":false,"code":1312}').get('s', 'a'),
  ).rejects.toThrow('loaded profile (Win32 1312)')
  const secret = 'never expose process output'
  const store = windowsCredentialStore(async () => {
    throw new Error(secret)
  })
  await expect(store.get('s', 'a')).rejects.not.toThrow(secret)
  await expect(store.set('s', 'a', new Uint8Array(2561))).rejects.toThrow('2560 bytes')
  const timeout = new WindowsCredentialError(
    'Windows Credential Manager helper timed out after 120 seconds.',
  )
  await expect(
    windowsCredentialStore(async () => {
      throw timeout
    }).get('s', 'a'),
  ).rejects.toBe(timeout)
})

test('Windows requires Credential Manager even when file fallback is requested', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laurencio-win-credentials-'))
  try {
    for (const open of [openKeyCache, openTokenStore]) {
      await expect(
        open({ home, platform: 'win32', keychain: null, allowFileFallback: true }),
      ).rejects.toThrow('Credential Manager')
    }
    expect(fs.readdirSync(home)).toEqual([])
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('Windows key cache preserves actionable Win32 diagnostics', async () => {
  const store = windowsCredentialStore(async () => '{"ok":false,"code":1312}')
  await expect(
    openKeyCache({ home: 'unused', platform: 'win32', loadKeyring: async () => store }),
  ).rejects.toBeInstanceOf(WindowsCredentialError)
  await expect(
    openKeyCache({ home: 'unused', platform: 'win32', loadKeyring: async () => store }),
  ).rejects.toThrow('Win32 1312')
  await expect(
    openTokenStore({
      home: 'unused',
      platform: 'win32',
      loadKeyring: async () => {
        throw new WindowsCredentialError('Run in the signed-in user session (Win32 1312).')
      },
    }),
  ).rejects.toThrow('signed-in user session')
})

test('Windows propagates Credential Manager failures without reading or writing plaintext caches', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laurencio-win-credentials-'))
  const keychain: CredentialStore = {
    backend: 'keychain',
    get: async () => {
      throw new Error('Credential Manager locked')
    },
    set: async () => {
      throw new Error('Credential Manager locked')
    },
    delete: async () => {
      throw new Error('Credential Manager locked')
    },
  }
  const key = new KeyMaterial(new Uint8Array(32).fill(7))
  const storeId = StoreId.parse('0123456789ABCDEFGHJKMNPQRS')
  try {
    const cache = await openKeyCache({ home, platform: 'win32', keychain })
    const tokens = await openTokenStore({ home, platform: 'win32', keychain })
    for (const operation of [
      () => cache.load(storeId),
      () => cache.save(storeId, key),
      () => cache.forget(storeId),
      () => tokens.get('service', 'account'),
      () => tokens.set('service', 'account', key.borrow()),
      () => tokens.delete('service', 'account'),
    ]) {
      await expect(operation()).rejects.toThrow('Credential Manager locked')
    }
    expect(fs.readdirSync(home)).toEqual([])
  } finally {
    key.zeroize()
    fs.rmSync(home, { recursive: true, force: true })
  }
})
