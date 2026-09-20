/**
 * Envelope encryption for store blobs.
 *
 * HKDF-SHA256 derives one subkey per namespace from the Argon2id master key,
 * and XChaCha20-Poly1305 seals each blob with a fresh 24-byte random nonce.
 * The frame is self-describing:
 *
 *   magic (4) | version (1) | nonce (24) | ciphertext (n)
 *
 * Additional authenticated data binds the store id, the blob type, the
 * namespace, and the wire protocol version, so a blob cannot be replayed into
 * another store, another blob kind, or another protocol revision. Blob ids are
 * the sha256 of the framed ciphertext, which keeps the server unable to index
 * or dedupe by name.
 */

import type { BlobId, StoreId } from '@laurencio/protocol'
import { BlobId as BlobIdSchema } from '@laurencio/protocol'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import type { KeyMaterial } from './kdf'

export const ENVELOPE_MAGIC = Uint8Array.from([0x4c, 0x4e, 0x43, 0x31]) // "LNC1"
export const ENVELOPE_VERSION = 1
export const NONCE_BYTES = 24
export const TAG_BYTES = 16
export const HEADER_BYTES = ENVELOPE_MAGIC.length + 1 + NONCE_BYTES

export const NAMESPACES = ['content', 'manifest', 'metadata', 'vault', 'profile'] as const
export type Namespace = (typeof NAMESPACES)[number]

export const BLOB_TYPES = ['file', 'manifest', 'revision', 'metadata', 'vault', 'profile'] as const
export type BlobType = (typeof BLOB_TYPES)[number]

export interface BlobContext {
  storeId: StoreId
  blobType: BlobType
  protocolVersion: number
}

const STORE_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Boundary check: store id and protocol version arrive from outside the process. */
export function assertBlobContext(context: BlobContext): void {
  if (!STORE_ID_PATTERN.test(context.storeId)) {
    throw new EnvelopeError('bad-envelope', 'store id must be a 26-character laurencio id')
  }
  if (!BLOB_TYPES.includes(context.blobType)) {
    throw new EnvelopeError('bad-envelope', `unknown blob type: ${context.blobType}`)
  }
  if (!Number.isInteger(context.protocolVersion) || context.protocolVersion < 1) {
    throw new EnvelopeError('bad-envelope', `invalid protocol version: ${context.protocolVersion}`)
  }
}

export interface EncryptedEnvelope {
  version: number
  nonce: Uint8Array
  ciphertext: Uint8Array
}

export interface SealedBlob {
  blobId: BlobId
  namespace: Namespace
  blobType: BlobType
  /** Framed ciphertext, exactly as uploaded. */
  bytes: Uint8Array
}

export type EnvelopeErrorCode =
  | 'bad-magic'
  | 'bad-version'
  | 'bad-length'
  | 'bad-envelope'
  | 'auth-failed'

export class EnvelopeError extends Error {
  readonly code: EnvelopeErrorCode

  constructor(code: EnvelopeErrorCode, message: string) {
    super(message)
    this.name = 'EnvelopeError'
    this.code = code
  }
}

const HKDF_SALT = utf8ToBytes('laurencio/hkdf/v1')

function subkeyInfo(namespace: Namespace): Uint8Array {
  return utf8ToBytes(`laurencio/subkey/v1/${namespace}`)
}

/** Deterministic subkey for a namespace. Same master and namespace, same key. */
export function deriveSubkey(master: KeyMaterial, namespace: Namespace): Uint8Array {
  return hkdf(sha256, master.borrow(), HKDF_SALT, subkeyInfo(namespace), 32)
}

/**
 * Canonical AAD. Every field comes from a closed alphabet with no NUL, so
 * concatenation with 0x00 separators is unambiguous. The label carries the
 * envelope version, and the protocol version is a big-endian u32, so a blob
 * cannot be replayed across framing or protocol revisions.
 */
export function envelopeAad(namespace: Namespace, context: BlobContext): Uint8Array {
  assertBlobContext(context)
  const protocolVersion = new Uint8Array(4)
  new DataView(protocolVersion.buffer).setUint32(0, context.protocolVersion, false)
  return concatBytes(
    utf8ToBytes(`laurencio/aead/v${ENVELOPE_VERSION}`),
    Uint8Array.of(0),
    utf8ToBytes(namespace),
    Uint8Array.of(0),
    utf8ToBytes(context.storeId),
    Uint8Array.of(0),
    utf8ToBytes(context.blobType),
    Uint8Array.of(0),
    protocolVersion,
  )
}

export function frameEnvelope(envelope: EncryptedEnvelope): Uint8Array {
  if (envelope.nonce.length !== NONCE_BYTES) {
    throw new EnvelopeError('bad-length', `nonce must be ${NONCE_BYTES} bytes`)
  }
  if (envelope.version !== ENVELOPE_VERSION) {
    throw new EnvelopeError('bad-version', `unsupported envelope version: ${envelope.version}`)
  }
  const header = new Uint8Array(HEADER_BYTES)
  header.set(ENVELOPE_MAGIC, 0)
  header[ENVELOPE_MAGIC.length] = envelope.version
  header.set(envelope.nonce, ENVELOPE_MAGIC.length + 1)
  return concatBytes(header, envelope.ciphertext)
}

export function parseEnvelope(framed: Uint8Array): EncryptedEnvelope {
  if (framed.length < HEADER_BYTES + TAG_BYTES) {
    throw new EnvelopeError('bad-length', `framed envelope is ${framed.length} bytes, too short`)
  }
  for (let index = 0; index < ENVELOPE_MAGIC.length; index += 1) {
    if (framed[index] !== ENVELOPE_MAGIC[index]) {
      throw new EnvelopeError(
        'bad-magic',
        'framed envelope does not start with the laurencio magic',
      )
    }
  }
  const version = framed[ENVELOPE_MAGIC.length]
  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError('bad-version', `unsupported envelope version: ${version ?? 'missing'}`)
  }
  const nonce = framed.slice(ENVELOPE_MAGIC.length + 1, HEADER_BYTES)
  const ciphertext = framed.slice(HEADER_BYTES)
  return { version: ENVELOPE_VERSION, nonce, ciphertext }
}

export function blobIdOf(framed: Uint8Array): BlobId {
  return BlobIdSchema.parse(bytesToHex(sha256(framed)))
}

/** Seals plaintext and returns the framed bytes with their content id. */
export function seal(
  master: KeyMaterial,
  namespace: Namespace,
  plaintext: Uint8Array,
  context: BlobContext,
): SealedBlob {
  const subkey = deriveSubkey(master, namespace)
  try {
    const nonce = randomBytes(NONCE_BYTES)
    const ciphertext = xchacha20poly1305(subkey, nonce, envelopeAad(namespace, context)).encrypt(
      plaintext,
    )
    const bytes = frameEnvelope({ version: ENVELOPE_VERSION, nonce, ciphertext })
    return { blobId: blobIdOf(bytes), namespace, blobType: context.blobType, bytes }
  } finally {
    subkey.fill(0)
  }
}

export function sealText(
  master: KeyMaterial,
  namespace: Namespace,
  plaintext: string,
  context: BlobContext,
): SealedBlob {
  return seal(master, namespace, utf8ToBytes(plaintext), context)
}

/**
 * Opens framed ciphertext. Throws `EnvelopeError` with code `auth-failed` when
 * the key, the nonce, the ciphertext, or any AAD field is wrong.
 */
export function open(
  master: KeyMaterial,
  namespace: Namespace,
  framed: Uint8Array,
  context: BlobContext,
): Uint8Array {
  const envelope = parseEnvelope(framed)
  const subkey = deriveSubkey(master, namespace)
  try {
    return xchacha20poly1305(subkey, envelope.nonce, envelopeAad(namespace, context)).decrypt(
      envelope.ciphertext,
    )
  } catch {
    throw new EnvelopeError('auth-failed', 'envelope authentication failed')
  } finally {
    subkey.fill(0)
  }
}

export function openText(
  master: KeyMaterial,
  namespace: Namespace,
  framed: Uint8Array,
  context: BlobContext,
): string {
  return new TextDecoder().decode(open(master, namespace, framed, context))
}
