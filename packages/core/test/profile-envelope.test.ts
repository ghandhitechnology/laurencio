import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { sealText } from '../src/crypto/aead'
import { KeyMaterial } from '../src/crypto/kdf'
import {
  migrateManifestToProfile,
  openProfile,
  ProfileFormatError,
  parsePortableProfile,
  sealProfile,
} from '../src/profile'

const context = {
  storeId: StoreId.parse('0123456789ABCDEFGHJKMNPQRS'),
  protocolVersion: 2,
}

function testKey(fill = 3): KeyMaterial {
  return new KeyMaterial(new Uint8Array(32).fill(fill))
}

function profile() {
  return migrateManifestToProfile({
    revisionId: RevisionId.parse('0123456789ABCDEFGHJKMNPQRT'),
    deviceId: DeviceId.parse('0123456789ABCDEFGHJKMNPQRV'),
    createdAt: '2026-09-20T00:00:00.000Z',
    entries: [],
  })
}

describe('encrypted portable profile', () => {
  test('round-trips through a profile-only encrypted envelope', () => {
    const key = testKey()
    const input = profile()
    input.shared.keybindings = { 'split-horizontal': 'ctrl+shift+d' }

    const sealed = sealProfile(input, key, context)

    expect(sealed.namespace).toBe('profile')
    expect(sealed.blobType).toBe('profile')
    expect(openProfile(key, sealed.bytes, context)).toEqual(input)
    key.zeroize()
  })

  test('round-trips manifest tombstones through the profile envelope', () => {
    const key = testKey()
    const input = profile()
    input.manifest.entries.push({
      surfaceId: SurfaceId.parse('codex.config'),
      path: '$HOME/.codex/config.toml',
      kind: 'tombstone',
      policy: 'sync',
      hash: '',
      size: 0,
      mode: 0,
    })

    const sealed = sealProfile(input, key, context)

    expect(openProfile(key, sealed.bytes, context)).toEqual(input)
    key.zeroize()
  })

  test('binds the encrypted profile to its store context', () => {
    const key = testKey()
    const sealed = sealProfile(profile(), key, context)

    expect(() =>
      openProfile(key, sealed.bytes, {
        ...context,
        storeId: StoreId.parse('0123456789ABCDEFGHJKMNPQRW'),
      }),
    ).toThrow('authentication failed')
    key.zeroize()
  })

  test('rejects malformed decrypted profiles instead of normalizing them', () => {
    const key = testKey()
    const malformed = { ...profile(), unexpected: true }
    const framed = sealText(key, 'profile', JSON.stringify(malformed), {
      ...context,
      blobType: 'profile',
    }).bytes

    expect(() => openProfile(key, framed, context)).toThrow(ProfileFormatError)
    expect(() => parsePortableProfile({ ...profile(), schemaVersion: 1 })).toThrow(
      'profile schemaVersion must be 2',
    )
    key.zeroize()
  })
})
