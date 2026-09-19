import { describe, expect, test } from 'bun:test'
import { StoreId } from '@laurencio/protocol'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  BLOB_TYPES,
  blobIdOf,
  deriveSubkey,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  EnvelopeError,
  envelopeAad,
  frameEnvelope,
  HEADER_BYTES,
  NAMESPACES,
  open,
  openText,
  parseEnvelope,
  seal,
  sealText,
} from '../../src/crypto/aead'
import { ARGON2_VERSION, deriveMasterKey, type KeyMaterial } from '../../src/crypto/kdf'

const storeId = StoreId.parse('0123456789ABCDEFGHJKMNPQRS')
const otherStore = StoreId.parse('0123456789ABCDEFGHJKMNPQRT')
const context = { storeId, blobType: 'file' as const, protocolVersion: 1 }

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

/**
 * Published XChaCha20-Poly1305 vector, draft-irtf-cfrg-xchacha-03 appendix A.3.1,
 * also carried in the noble-ciphers suite as stablelib_xchacha20poly1305.json.
 * https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha-03#appendix-A.3.1
 */
describe('xchacha20-poly1305 published vector', () => {
  test('draft-irtf-cfrg-xchacha-03 A.3.1', () => {
    const key = hexToBytes('808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f')
    const nonce = hexToBytes('404142434445464748494a4b4c4d4e4f5051525354555657')
    const aad = hexToBytes('50515253c0c1c2c3c4c5c6c7')
    const plaintext = new TextEncoder().encode(
      "Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.",
    )
    const sealed = xchacha20poly1305(key, nonce, aad).encrypt(plaintext)
    expect(bytesToHex(sealed)).toBe(
      'bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb' +
        '731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452' +
        '2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9' +
        '21f9664c97637da9768812f615c68b13b52e' +
        'c0875924c1c7987947deafd8780acf49',
    )
    const opened = xchacha20poly1305(key, nonce, aad).decrypt(sealed)
    expect(bytesToHex(opened)).toBe(bytesToHex(plaintext))
  })
})

describe('namespace subkeys', () => {
  test('each namespace derives a distinct 32-byte subkey', () => {
    const master = testKey()
    const keys = NAMESPACES.map((namespace) => bytesToHex(deriveSubkey(master, namespace)))
    expect(new Set(keys).size).toBe(NAMESPACES.length)
    for (const hex of keys) expect(hex).toMatch(/^[0-9a-f]{64}$/)
    master.zeroize()
  })

  test('the same master and namespace derive the same subkey', () => {
    const first = testKey()
    const second = testKey()
    expect(bytesToHex(deriveSubkey(first, 'content'))).toBe(
      bytesToHex(deriveSubkey(second, 'content')),
    )
    first.zeroize()
    second.zeroize()
  })
})

describe('envelope framing', () => {
  test('frame layout is magic, version, nonce, ciphertext', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'hello store', context)
    expect(sealed.bytes.length).toBe(HEADER_BYTES + 'hello store'.length + 16)
    expect(sealed.bytes.slice(0, 4)).toEqual(ENVELOPE_MAGIC)
    expect(sealed.bytes[4]).toBe(ENVELOPE_VERSION)
    const envelope = parseEnvelope(sealed.bytes)
    expect(envelope.nonce).toHaveLength(24)
    expect(envelope.ciphertext).toHaveLength('hello store'.length + 16)
    master.zeroize()
  })

  test('blob id is sha256 of the framed ciphertext', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'body', context)
    expect(sealed.blobId).toBe(blobIdOf(sealed.bytes))
    expect(sealed.blobId).toMatch(/^[0-9a-f]{64}$/)
    master.zeroize()
  })

  test('framing and parsing are lossless', () => {
    const ciphertext = new Uint8Array(16).fill(9)
    const framed = frameEnvelope({
      version: ENVELOPE_VERSION,
      nonce: new Uint8Array(24).fill(7),
      ciphertext,
    })
    const parsed = parseEnvelope(framed)
    expect(parsed.nonce).toEqual(new Uint8Array(24).fill(7))
    expect(parsed.ciphertext).toEqual(ciphertext)
  })

  test('a foreign frame is rejected before any crypto', () => {
    expect(() => parseEnvelope(Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toThrow(
      EnvelopeError,
    )
    expect(() => parseEnvelope(new Uint8Array(HEADER_BYTES + 16))).toThrow('magic')
    const short = new Uint8Array(8)
    short.set(ENVELOPE_MAGIC, 0)
    expect(() => parseEnvelope(short)).toThrow('too short')
  })

  test('round-trip works for every namespace and blob type', () => {
    const master = testKey()
    for (const namespace of NAMESPACES) {
      for (const blobType of BLOB_TYPES) {
        const sealed = sealText(master, namespace, `${namespace}/${blobType}`, {
          storeId,
          blobType,
          protocolVersion: 1,
        })
        expect(
          openText(master, namespace, sealed.bytes, { storeId, blobType, protocolVersion: 1 }),
        ).toBe(`${namespace}/${blobType}`)
      }
    }
    master.zeroize()
  })
})

describe('tamper detection', () => {
  test('a flipped ciphertext byte fails authentication', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'sensitive body', context)
    const tampered = sealed.bytes.slice()
    const index = tampered.length - 1
    tampered[index] = (tampered[index] ?? 0) ^ 0x01
    expect(() => open(master, 'content', tampered, context)).toThrow('authentication failed')
    master.zeroize()
  })

  test('a flipped nonce fails authentication', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'sensitive body', context)
    const tampered = sealed.bytes.slice()
    tampered[ENVELOPE_MAGIC.length + 1] = (tampered[ENVELOPE_MAGIC.length + 1] ?? 0) ^ 0x01
    expect(() => open(master, 'content', tampered, context)).toThrow('authentication failed')
    master.zeroize()
  })

  test('truncated ciphertext fails closed', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'sensitive body', context)
    expect(() =>
      open(master, 'content', sealed.bytes.slice(0, sealed.bytes.length - 4), context),
    ).toThrow()
    master.zeroize()
  })

  test('AAD binds store id, blob type, namespace, and protocol version', () => {
    const master = testKey()
    const sealed = sealText(master, 'content', 'sensitive body', context)
    const wrongStore = { ...context, storeId: otherStore }
    const wrongType = { ...context, blobType: 'manifest' as const }
    const wrongVersion = { ...context, protocolVersion: 2 }
    expect(() => open(master, 'content', sealed.bytes, wrongStore)).toThrow('authentication failed')
    expect(() => open(master, 'content', sealed.bytes, wrongType)).toThrow('authentication failed')
    expect(() => open(master, 'content', sealed.bytes, wrongVersion)).toThrow(
      'authentication failed',
    )
    expect(() => open(master, 'metadata', sealed.bytes, context)).toThrow('authentication failed')
    expect(openText(master, 'content', sealed.bytes, context)).toBe('sensitive body')
    master.zeroize()
  })

  test('the AAD layout is canonical and stable', () => {
    const aad = bytesToHex(envelopeAad('content', context))
    expect(aad).toContain(Buffer.from('laurencio/aead/v1').toString('hex'))
    expect(aad).toContain(Buffer.from(storeId).toString('hex'))
    expect(aad).toContain(Buffer.from('content').toString('hex'))
    expect(aad).toContain(Buffer.from('file').toString('hex'))
    expect(aad.endsWith('00000001')).toBe(true)
    expect(envelopeAad('manifest', context)).not.toEqual(envelopeAad('content', context))
  })

  test('invalid context is rejected before sealing', () => {
    const master = testKey()
    expect(() => sealText(master, 'content', 'x', { ...context, protocolVersion: 0 })).toThrow(
      'invalid protocol version',
    )
    expect(() =>
      sealText(master, 'content', 'x', { ...context, storeId: 'not-an-id' as typeof storeId }),
    ).toThrow('store id')
    expect(() =>
      sealText(master, 'content', 'x', { ...context, blobType: 'nope' as 'file' }),
    ).toThrow('unknown blob type')
    master.zeroize()
  })
})

describe('key separation', () => {
  test('a wrong passphrase fails authentication', () => {
    const right = testKey('the right passphrase')
    const wrong = testKey('the wrong passphrase')
    const sealed = sealText(right, 'content', 'body', context)
    expect(() => open(wrong, 'content', sealed.bytes, context)).toThrow('authentication failed')
    right.zeroize()
    wrong.zeroize()
  })

  test('a wrong key fails even with matching AAD', () => {
    const first = testKey('one')
    const second = testKey('two')
    const sealed = sealText(first, 'manifest', '{"a":1}', { ...context, blobType: 'manifest' })
    expect(() =>
      open(second, 'manifest', sealed.bytes, { ...context, blobType: 'manifest' }),
    ).toThrow(EnvelopeError)
    first.zeroize()
    second.zeroize()
  })

  test('nonces are random, so identical plaintext yields distinct blobs', () => {
    const master = testKey()
    const first = sealText(master, 'content', 'same body', context)
    const second = sealText(master, 'content', 'same body', context)
    expect(first.blobId).not.toBe(second.blobId)
    expect(bytesToHex(first.bytes)).not.toBe(bytesToHex(second.bytes))
    master.zeroize()
  })
})

describe('seal/open helpers', () => {
  test('seal returns framed bytes and open reverses them', () => {
    const master = testKey()
    const plaintext = new TextEncoder().encode('binary body')
    const sealed = seal(master, 'metadata', plaintext, { ...context, blobType: 'metadata' })
    expect(open(master, 'metadata', sealed.bytes, { ...context, blobType: 'metadata' })).toEqual(
      plaintext,
    )
    master.zeroize()
  })
})
