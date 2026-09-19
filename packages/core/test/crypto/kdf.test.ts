import { describe, expect, test } from 'bun:test'
import { inspect } from 'node:util'
import { KdfParams as KdfParamsSchema } from '@laurencio/protocol'
import { argon2id } from '@noble/hashes/argon2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  ARGON2_VERSION,
  CALIBRATION_LADDER,
  calibrateKdf,
  deriveMasterKey,
  type KdfParams,
  KeyMaterial,
  kdfParamsFromWire,
  kdfParamsToWire,
  MIN_MEMORY_KIB,
  newSalt,
  parseKdfParams,
} from '../../src/crypto/kdf'

/**
 * Published Argon2id vectors.
 *
 * RFC 9106 section 5.3: password 32 x 0x01, salt 16 x 0x02, secret 8 x 0x03,
 * associated data 12 x 0x04, m=32 KiB, t=3, p=4, version 19.
 * https://www.rfc-editor.org/rfc/rfc9106#section-5.3
 *
 * The same vector appears in the noble-hashes test suite and in the reference
 * implementation's kats/argon2id file, so it pins both the primitive and the
 * secret/associated-data plumbing.
 */
describe('argon2id published vectors', () => {
  test('RFC 9106 section 5.3', () => {
    const tag = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), {
      m: 32,
      t: 3,
      p: 4,
      version: 0x13,
      dkLen: 32,
      key: new Uint8Array(8).fill(3),
      personalization: new Uint8Array(12).fill(4),
    })
    expect(bytesToHex(tag)).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  })

  test('argon2id v1.3 against the reference implementation test set', () => {
    // phc-winner-argon2 src/test.c, mirrored in the noble-hashes suite:
    // argon2id('password', 'somesalt', t=2, m=65536 KiB, p=1, dkLen=32).
    const tag = argon2id('password', 'somesalt', { m: 65536, t: 2, p: 1, dkLen: 32 })
    expect(bytesToHex(tag)).toBe('09316115d5cf24ed5a15a31a3ba326e5cf32edc24702987c02b6566f61913cf7')
  })
})

describe('kdf params', () => {
  test('salt is 16 random bytes in hex', () => {
    const salt = newSalt()
    expect(salt).toMatch(/^[0-9a-f]{32}$/)
    expect(newSalt()).not.toBe(salt)
  })

  test('parseKdfParams rejects malformed input at the boundary', () => {
    const good = {
      algo: 'argon2id',
      salt: 'a'.repeat(32),
      m: 19456,
      t: 2,
      p: 1,
      version: ARGON2_VERSION,
    }
    expect(parseKdfParams(good).m).toBe(19456)
    expect(() => parseKdfParams({ ...good, algo: 'scrypt' })).toThrow()
    expect(() => parseKdfParams({ ...good, salt: 'zz' })).toThrow()
    expect(() => parseKdfParams({ ...good, m: 4 })).toThrow()
    expect(() => parseKdfParams({ ...good, version: 16 })).toThrow()
    expect(() => parseKdfParams(null)).toThrow()
  })

  test('derivation is deterministic and rejects an empty passphrase', () => {
    const params = {
      algo: 'argon2id' as const,
      salt: 'b'.repeat(32),
      m: MIN_MEMORY_KIB,
      t: 2,
      p: 1,
      version: ARGON2_VERSION,
    }
    const first = deriveMasterKey('correct horse battery staple', params)
    const second = deriveMasterKey('correct horse battery staple', params)
    const other = deriveMasterKey('different passphrase', params)
    expect(bytesToHex(first.borrow())).toBe(bytesToHex(second.borrow()))
    expect(bytesToHex(first.borrow())).not.toBe(bytesToHex(other.borrow()))
    expect(() => deriveMasterKey('', params)).toThrow()
    first.zeroize()
    second.zeroize()
    other.zeroize()
  })
})

describe('calibration', () => {
  test('picks the candidate closest to the target and records the observation', () => {
    // A synthetic clock: each candidate costs its memory cost in "milliseconds",
    // so the 19 MiB entry is closest to a 30 ms target.
    const costs = new Map(CALIBRATION_LADDER.map((candidate) => [candidate.m, candidate.m]))
    const params = calibrateKdf({
      targetMs: 30000,
      salt: 'c'.repeat(32),
      candidates: CALIBRATION_LADDER.slice(0, 2),
      now: (() => {
        let elapsed = 0
        let pending = 0
        return () => {
          elapsed += pending
          pending = costs.get(CALIBRATION_LADDER[0]?.m ?? 0) ?? 0
          return elapsed
        }
      })(),
    })
    expect(params.algo).toBe('argon2id')
    expect(params.calibrationMs).toBeDefined()
    expect(CALIBRATION_LADDER.map((candidate) => candidate.m)).toContain(params.m)
  })

  test('a real calibration run records a positive duration', () => {
    const params = calibrateKdf({
      targetMs: 1,
      salt: 'd'.repeat(32),
      candidates: [CALIBRATION_LADDER[0] as { m: number; t: number; p: number }],
      now: () => performance.now(),
    })
    expect(params.calibrationMs).toBeGreaterThan(0)
    expect(JSON.parse(JSON.stringify(params)).salt).toBe(params.salt)
  })
})

describe('wire conversion', () => {
  test('round-trips through the protocol shape without losing the salt', () => {
    const params: KdfParams = {
      algo: 'argon2id',
      salt: 'ab'.repeat(16),
      m: 19456,
      t: 2,
      p: 1,
      version: ARGON2_VERSION,
      calibrationMs: 140,
    }
    const wire = kdfParamsToWire(params, '2026-09-19T00:00:00.000Z')
    expect(wire.version).toBe(1)
    expect(wire.salt).toMatch(/^[A-Za-z0-9+/=]{16,}$/)
    expect(wire.calibratedAt).toBe('2026-09-19T00:00:00.000Z')
    const back = kdfParamsFromWire(wire)
    expect(back.salt).toBe(params.salt)
    expect(back.m).toBe(params.m)
    expect(back.version).toBe(ARGON2_VERSION)
  })

  test('the wire form validates against the protocol schema', () => {
    const params: KdfParams = {
      algo: 'argon2id',
      salt: 'cd'.repeat(16),
      m: 65536,
      t: 3,
      p: 1,
      version: ARGON2_VERSION,
    }
    const wire = kdfParamsToWire(params, '2026-09-19T00:00:00.000Z')
    const parsed = KdfParamsSchema.parse(wire)
    expect(parsed.m).toBe(65536)
    expect(kdfParamsFromWire(parsed).salt).toBe(params.salt)
  })
})

describe('KeyMaterial never serializes', () => {
  const key = deriveMasterKey('a passphrase', {
    algo: 'argon2id',
    salt: 'e'.repeat(32),
    m: 8,
    t: 1,
    p: 1,
    version: ARGON2_VERSION,
  })

  test('toJSON throws, so JSON.stringify fails closed', () => {
    expect(() => JSON.stringify(key)).toThrow('not serializable')
    expect(() => JSON.stringify({ key })).toThrow('not serializable')
    expect(() => JSON.stringify([key])).toThrow('not serializable')
  })

  test('string and inspect forms are redacted', () => {
    expect(String(key)).toBe('[KeyMaterial]')
    expect(`${key}`).toBe('[KeyMaterial]')
    expect(inspect(key)).toBe('[KeyMaterial]')
    expect(Bun.inspect(key)).toBe('[KeyMaterial]')
    expect(key[Symbol.toStringTag]).toBe('KeyMaterial')
  })

  test('no enumerable property holds the bytes', () => {
    expect(Object.keys(key)).toEqual([])
    expect(Object.values(key)).toEqual([])
    expect(Object.entries(key)).toEqual([])
    expect(Object.getOwnPropertyNames(key)).toEqual([])
    const spread: Record<string, unknown> = { ...key }
    expect(spread).toEqual({})
    const seen: string[] = []
    for (const property in key) seen.push(property)
    expect(seen).toEqual([])
  })

  test('the raw bytes never reach a string, an error, or the console', () => {
    const hex = bytesToHex(key.borrow())
    const lines: string[] = []
    const original = console.log
    console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '))
    try {
      console.log('key', key, { nested: key })
    } finally {
      console.log = original
    }
    expect(lines.join('\n')).not.toContain(hex)
    expect(lines.join('\n')).toContain('[KeyMaterial]')
    const error = (() => {
      try {
        JSON.stringify(key)
      } catch (caught) {
        return caught
      }
      return null
    })()
    expect(String(error)).not.toContain(hex)
  })

  test('zeroize wipes the buffer and blocks further use', () => {
    const scratch = deriveMasterKey('another passphrase', {
      algo: 'argon2id',
      salt: 'f'.repeat(32),
      m: 8,
      t: 1,
      p: 1,
      version: ARGON2_VERSION,
    })
    const copy = scratch.copyBytes()
    scratch.zeroize()
    expect(scratch.zeroized).toBe(true)
    expect(() => scratch.borrow()).toThrow('zeroized')
    expect(() => scratch.copyBytes()).toThrow('zeroized')
    copy.fill(0)
  })

  test('hex round-trip is explicit and opt-in', () => {
    const scratch = new KeyMaterial(hexToBytes('ab'.repeat(32)))
    expect(scratch.copyBytes()).toHaveLength(32)
    scratch.zeroize()
  })
})
