import type { StoreId } from '@laurencio/protocol'
import { open, type SealedBlob, seal } from './crypto/aead'
import type { KeyMaterial } from './crypto/kdf'

const INSPECT = Symbol.for('nodejs.util.inspect.custom')
const VAULT_FORMAT_VERSION = 1
const MAX_SECRET_BYTES = 1024 * 1024
const MAX_ENTRIES = 1024
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

export type VaultRecordKind = 'agent-auth' | 'mcp-secret'

export interface VaultContext {
  storeId: StoreId
  protocolVersion: number
}

export interface VaultRecordMetadata {
  id: string
  kind: VaultRecordKind
  provider: string
  version: number
  updatedAt: string
}

export interface VaultPutInput {
  id: string
  kind: VaultRecordKind
  provider: string
  value: string | Uint8Array
  /** `null` creates a new record; an integer rotates the matching version. */
  expectedVersion: number | null
  updatedAt: string
}

interface VaultEntry extends VaultRecordMetadata {
  value: Uint8Array
}

interface SerializedVaultEntry extends VaultRecordMetadata {
  value: string
}

interface SerializedVault {
  version: number
  entries: SerializedVaultEntry[]
}

export class VaultConflictError extends Error {
  readonly id: string
  readonly expectedVersion: number | null
  readonly actualVersion: number | null

  constructor(id: string, expectedVersion: number | null, actualVersion: number | null) {
    super(
      `vault record ${id} changed (expected ${expectedVersion ?? 'new'}, found ${actualVersion ?? 'missing'})`,
    )
    this.name = 'VaultConflictError'
    this.id = id
    this.expectedVersion = expectedVersion
    this.actualVersion = actualVersion
  }
}

export class VaultFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VaultFormatError'
  }
}

/**
 * An in-memory, zeroizable credential set. The server only sees the envelope
 * produced by `seal`; callers can inspect metadata without exposing values.
 */
export class Vault {
  readonly #entries: Map<string, VaultEntry>
  #zeroized = false

  private constructor(entries: Iterable<VaultEntry> = []) {
    this.#entries = new Map(Array.from(entries, (entry) => [entry.id, entry]))
    Object.defineProperty(this, INSPECT, {
      value: () => '[Vault redacted]',
      enumerable: false,
      configurable: false,
      writable: false,
    })
  }

  static empty(): Vault {
    return new Vault()
  }

  static open(master: KeyMaterial, framed: Uint8Array, context: VaultContext): Vault {
    const plaintext = open(master, 'vault', framed, vaultBlobContext(context))
    try {
      return new Vault(parseSerializedVault(new TextDecoder().decode(plaintext)))
    } finally {
      plaintext.fill(0)
    }
  }

  get zeroized(): boolean {
    return this.#zeroized
  }

  list(): VaultRecordMetadata[] {
    this.#assertLive()
    return Array.from(this.#entries.values(), metadataOf).sort((left, right) =>
      left.id.localeCompare(right.id),
    )
  }

  read(id: string): Uint8Array | null {
    this.#assertLive()
    assertId(id)
    return this.#entries.get(id)?.value.slice() ?? null
  }

  put(input: VaultPutInput): VaultRecordMetadata {
    this.#assertLive()
    assertId(input.id)
    assertKind(input.kind)
    assertProvider(input.provider)
    assertTimestamp(input.updatedAt)
    if (input.expectedVersion !== null && !isPositiveInteger(input.expectedVersion)) {
      throw new VaultFormatError('expected version must be null or a positive integer')
    }

    const current = this.#entries.get(input.id)
    const actualVersion = current?.version ?? null
    if (actualVersion !== input.expectedVersion) {
      throw new VaultConflictError(input.id, input.expectedVersion, actualVersion)
    }

    const value =
      typeof input.value === 'string' ? new TextEncoder().encode(input.value) : input.value.slice()
    if (value.length === 0 || value.length > MAX_SECRET_BYTES) {
      value.fill(0)
      throw new VaultFormatError(`vault value must be between 1 and ${MAX_SECRET_BYTES} bytes`)
    }

    const entry: VaultEntry = {
      id: input.id,
      kind: input.kind,
      provider: input.provider,
      version: (actualVersion ?? 0) + 1,
      updatedAt: input.updatedAt,
      value,
    }
    current?.value.fill(0)
    this.#entries.set(entry.id, entry)
    return metadataOf(entry)
  }

  remove(id: string, expectedVersion: number): void {
    this.#assertLive()
    assertId(id)
    if (!isPositiveInteger(expectedVersion)) {
      throw new VaultFormatError('expected version must be a positive integer')
    }
    const current = this.#entries.get(id)
    const actualVersion = current?.version ?? null
    if (actualVersion !== expectedVersion) {
      throw new VaultConflictError(id, expectedVersion, actualVersion)
    }
    if (current === undefined) {
      throw new VaultConflictError(id, expectedVersion, null)
    }
    current.value.fill(0)
    this.#entries.delete(id)
  }

  seal(master: KeyMaterial, context: VaultContext): SealedBlob {
    this.#assertLive()
    const entries: SerializedVaultEntry[] = Array.from(this.#entries.values())
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((entry) => ({
        ...metadataOf(entry),
        value: Buffer.from(entry.value).toString('base64'),
      }))
    const plaintext = new TextEncoder().encode(
      JSON.stringify({ version: VAULT_FORMAT_VERSION, entries } satisfies SerializedVault),
    )
    try {
      return seal(master, 'vault', plaintext, vaultBlobContext(context))
    } finally {
      plaintext.fill(0)
    }
  }

  zeroize(): void {
    if (this.#zeroized) return
    for (const entry of this.#entries.values()) entry.value.fill(0)
    this.#entries.clear()
    this.#zeroized = true
  }

  toJSON(): never {
    throw new Error('Vault is not serializable')
  }

  toString(): string {
    return '[Vault redacted]'
  }

  get [Symbol.toStringTag](): string {
    return 'Vault'
  }

  #assertLive(): void {
    if (this.#zeroized) throw new Error('vault has been zeroized')
  }
}

function vaultBlobContext(context: VaultContext) {
  return { ...context, blobType: 'vault' as const }
}

function metadataOf(entry: VaultEntry): VaultRecordMetadata {
  return {
    id: entry.id,
    kind: entry.kind,
    provider: entry.provider,
    version: entry.version,
    updatedAt: entry.updatedAt,
  }
}

function parseSerializedVault(text: string): VaultEntry[] {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new VaultFormatError('vault plaintext is not valid JSON')
  }
  if (!isRecord(raw) || raw.version !== VAULT_FORMAT_VERSION || !Array.isArray(raw.entries)) {
    throw new VaultFormatError('unsupported vault format')
  }
  if (raw.entries.length > MAX_ENTRIES) throw new VaultFormatError('vault has too many records')

  const seen = new Set<string>()
  return raw.entries.map((candidate) => {
    if (!isRecord(candidate)) throw new VaultFormatError('vault record must be an object')
    const id = stringField(candidate, 'id')
    const kind = stringField(candidate, 'kind')
    const provider = stringField(candidate, 'provider')
    const updatedAt = stringField(candidate, 'updatedAt')
    const encodedValue = stringField(candidate, 'value')
    const version = candidate.version
    assertId(id)
    assertKind(kind)
    assertProvider(provider)
    assertTimestamp(updatedAt)
    if (!isPositiveInteger(version)) throw new VaultFormatError('record version must be positive')
    if (seen.has(id)) throw new VaultFormatError(`duplicate vault record: ${id}`)
    seen.add(id)

    const value = decodeBase64(encodedValue)
    if (value.length === 0 || value.length > MAX_SECRET_BYTES) {
      value.fill(0)
      throw new VaultFormatError('vault value has an invalid size')
    }
    return { id, kind, provider, version, updatedAt, value }
  })
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new VaultFormatError('vault value is not canonical base64')
  }
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function assertId(value: string): void {
  if (!ID_PATTERN.test(value)) throw new VaultFormatError(`invalid vault record id: ${value}`)
}

function assertKind(value: string): asserts value is VaultRecordKind {
  if (value !== 'agent-auth' && value !== 'mcp-secret') {
    throw new VaultFormatError(`unsupported vault record kind: ${value}`)
  }
}

function assertProvider(value: string): void {
  if (!PROVIDER_PATTERN.test(value)) throw new VaultFormatError(`invalid vault provider: ${value}`)
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new VaultFormatError(`invalid vault timestamp: ${value}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new VaultFormatError(`vault record ${key} must be a string`)
  return value
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}
