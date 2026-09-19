/**
 * Passphrase stretching.
 *
 * Argon2id (RFC 9106) with parameters calibrated once per enrollment against a
 * target duration. Only the salt and the cost parameters are public; the
 * passphrase and the derived bytes never leave this module except as
 * `KeyMaterial`, which refuses to serialize.
 */

import { argon2id } from '@noble/hashes/argon2.js'
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils.js'

export const KEY_BYTES = 32
export const SALT_BYTES = 16
export const ARGON2_VERSION = 0x13

/** OWASP minimum for Argon2id: 19 MiB, two passes, one lane. */
export const MIN_MEMORY_KIB = 19456
export const MIN_TIME_COST = 2
export const MIN_PARALLELISM = 1

/** noble's default allocation ceiling is 1 GiB; keep calibration under it. */
export const MAX_MEMORY_KIB = 1_048_576

export interface KdfParams {
  algo: 'argon2id'
  /** Hex-encoded salt, 16 bytes. Public. */
  salt: string
  /** Memory cost in kibibytes. */
  m: number
  /** Time cost, passes over memory. */
  t: number
  /** Parallelism, lanes. */
  p: number
  /** Argon2 version, always 0x13 (19). */
  version: number
  /** Observed derivation time from the calibration run, milliseconds. Local detail. */
  calibrationMs?: number
  /** When calibration ran. Travels on the wire in place of `calibrationMs`. */
  calibratedAt?: string
}

const INSPECT = Symbol.for('nodejs.util.inspect.custom')

/**
 * Derived key bytes. Not serializable by construction: `toJSON` throws, the
 * default string and inspect forms are redacted, and no enumerable property
 * ever holds the bytes. `zeroize()` wipes the buffer and makes further use
 * throw. Never log, never write to a store, never put in a synced path.
 */
export class KeyMaterial {
  #bytes: Uint8Array
  #zeroized = false

  constructor(bytes: Uint8Array) {
    if (bytes.length !== KEY_BYTES) {
      throw new Error(`key material must be ${KEY_BYTES} bytes, got ${bytes.length}`)
    }
    this.#bytes = bytes.slice()
    Object.defineProperty(this, INSPECT, {
      value: () => '[KeyMaterial]',
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }

  static fromHex(hex: string): KeyMaterial {
    return new KeyMaterial(hexToBytes(hex))
  }

  get byteLength(): number {
    return KEY_BYTES
  }
  get zeroized(): boolean {
    return this.#zeroized
  }

  /** Borrows the live buffer for a crypto call. Do not retain or copy it. */
  borrow(): Uint8Array {
    if (this.#zeroized) throw new Error('key material has been zeroized')
    return this.#bytes
  }

  /** Copies the bytes out for the keychain cache. The copy is the caller's to zero. */
  copyBytes(): Uint8Array {
    if (this.#zeroized) throw new Error('key material has been zeroized')
    return this.#bytes.slice()
  }

  zeroize(): void {
    this.#bytes.fill(0)
    this.#zeroized = true
  }

  toJSON(): never {
    throw new Error('KeyMaterial is not serializable')
  }

  toString(): string {
    return '[KeyMaterial]'
  }

  get [Symbol.toStringTag](): string {
    return 'KeyMaterial'
  }
}

export function newSalt(): string {
  return bytesToHex(randomBytes(SALT_BYTES))
}

export interface CalibrationOptions {
  /** Target wall-clock time for one derivation. */
  targetMs?: number
  /** Salt used for the calibration runs. Random by default. */
  salt?: string
  /** Candidate cost ladder, ascending. */
  candidates?: { m: number; t: number; p: number }[]
  /** Injectable clock, for tests. */
  now?: () => number
}

export const DEFAULT_TARGET_MS = 500

/** Ascending cost ladder. Calibration picks the entry closest to the target. */
export const CALIBRATION_LADDER: { m: number; t: number; p: number }[] = [
  { m: MIN_MEMORY_KIB, t: MIN_TIME_COST, p: MIN_PARALLELISM },
  { m: 32768, t: 3, p: 1 },
  { m: 65536, t: 3, p: 1 },
  { m: 131072, t: 3, p: 1 },
  { m: 262144, t: 3, p: 1 },
  { m: 524288, t: 3, p: 1 },
]

export function assertKdfParams(params: KdfParams): void {
  if (params.algo !== 'argon2id') throw new Error(`unsupported kdf algorithm: ${params.algo}`)
  if (params.version !== ARGON2_VERSION)
    throw new Error(`unsupported argon2 version: ${params.version}`)
  if (!/^[0-9a-f]{32}$/.test(params.salt)) throw new Error('kdf salt must be 16 hex-encoded bytes')
  if (!Number.isInteger(params.m) || params.m < 8 || params.m > MAX_MEMORY_KIB) {
    throw new Error(`kdf memory cost out of range: ${params.m}`)
  }
  if (!Number.isInteger(params.t) || params.t < 1 || params.t > 64) {
    throw new Error(`kdf time cost out of range: ${params.t}`)
  }
  if (!Number.isInteger(params.p) || params.p < 1 || params.p > 16) {
    throw new Error(`kdf parallelism out of range: ${params.p}`)
  }
}

/** Boundary parser for parameters that arrived over the wire. */
export function parseKdfParams(value: unknown): KdfParams {
  if (typeof value !== 'object' || value === null) throw new Error('kdf params must be an object')
  const record = value as Record<string, unknown>
  if (record.algo !== 'argon2id')
    throw new Error(`unsupported kdf algorithm: ${String(record.algo)}`)
  const params: KdfParams = {
    algo: 'argon2id',
    salt: String(record.salt ?? ''),
    m: Number(record.m),
    t: Number(record.t),
    p: Number(record.p),
    version: Number(record.version),
  }
  if (typeof record.calibrationMs === 'number') params.calibrationMs = record.calibrationMs
  if (typeof record.calibratedAt === 'string') params.calibratedAt = record.calibratedAt
  assertKdfParams(params)
  return params
}

/**
 * The wire form from `@laurencio/protocol`: base64 salt, schema version 1, and
 * `calibratedAt` in place of the local `calibrationMs`. Kept here so the two
 * shapes cannot drift silently.
 */
export function kdfParamsToWire(
  params: KdfParams,
  calibratedAt: string,
): {
  algo: 'argon2id'
  version: 1
  salt: string
  m: number
  t: number
  p: number
  calibratedAt: string
} {
  assertKdfParams(params)
  return {
    algo: 'argon2id',
    version: 1,
    salt: bytesToBase64(hexToBytes(params.salt)),
    m: params.m,
    t: params.t,
    p: params.p,
    calibratedAt,
  }
}

export function kdfParamsFromWire(wire: {
  algo: 'argon2id'
  salt: string
  m: number
  t: number
  p: number
}): KdfParams {
  const params: KdfParams = {
    algo: 'argon2id',
    salt: bytesToHex(base64ToBytes(wire.salt)),
    m: wire.m,
    t: wire.t,
    p: wire.p,
    version: ARGON2_VERSION,
  }
  assertKdfParams(params)
  return params
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function deriveMasterKey(passphrase: string, params: KdfParams): KeyMaterial {
  assertKdfParams(params)
  if (passphrase.length === 0) throw new Error('passphrase must not be empty')
  const bytes = argon2id(passphrase, hexToBytes(params.salt), {
    m: params.m,
    t: params.t,
    p: params.p,
    version: params.version,
    dkLen: KEY_BYTES,
  })
  return new KeyMaterial(bytes)
}

/**
 * Picks the ladder entry closest to the target duration and records the
 * observed time. Runs once per enrollment, then the chosen parameters are
 * public store metadata. The search stops at the first candidate at or above
 * the target, then compares it with the previous one so a slow machine does
 * not silently double the target.
 */
export function calibrateKdf(options: CalibrationOptions = {}): KdfParams {
  const targetMs = options.targetMs ?? DEFAULT_TARGET_MS
  const salt = options.salt ?? newSalt()
  const candidates = options.candidates ?? CALIBRATION_LADDER
  const now = options.now ?? (() => performance.now())
  let best: {
    candidate: { m: number; t: number; p: number }
    elapsed: number
    distance: number
  } | null = null
  for (const candidate of candidates) {
    const start = now()
    const probe = deriveMasterKey('laurencio-calibration', {
      algo: 'argon2id',
      salt,
      m: candidate.m,
      t: candidate.t,
      p: candidate.p,
      version: ARGON2_VERSION,
    })
    const elapsed = now() - start
    probe.zeroize()
    const distance =
      elapsed <= 0 ? Number.POSITIVE_INFINITY : Math.abs(Math.log(elapsed / targetMs))
    if (best === null || distance < best.distance) best = { candidate, elapsed, distance }
    if (elapsed >= targetMs) break
  }
  if (best === null) throw new Error('calibration ladder must not be empty')
  return {
    algo: 'argon2id',
    salt,
    m: best.candidate.m,
    t: best.candidate.t,
    p: best.candidate.p,
    version: ARGON2_VERSION,
    calibrationMs: Math.round(best.elapsed),
  }
}

export function createKdfParams(options: CalibrationOptions = {}): KdfParams {
  return calibrateKdf(options)
}
