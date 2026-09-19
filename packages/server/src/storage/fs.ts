import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  BLOB_CONTENT_TYPE,
  type BlobHead,
  type BlobStore,
  type PresignedDownload,
  type PresignedUpload,
  sha256Hex,
} from './types'

export interface FsBlobStoreOptions {
  dir: string
  /** HMAC secret for the local presigned URLs. */
  secret: string
  baseUrl: string
  now?: () => number
}

export type LocalSignatureCheck = { ok: true } | { ok: false; reason: string }

export class ChecksumMismatchError extends Error {}

/**
 * Filesystem storage for local development and tests. Presigned URLs point
 * back at this server's `/local-blob` routes, signed the same way a bucket
 * provider would sign them, so the client code path is identical.
 */
export class FsBlobStore implements BlobStore {
  readonly kind = 'fs' as const
  private readonly options: FsBlobStoreOptions
  private readonly now: () => number

  constructor(options: FsBlobStoreOptions) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
  }

  private sign(method: string, key: string, expires: number, extra?: string): string {
    const payload = `${method}:${key}:${expires}${extra ? `:${extra}` : ''}`
    return createHmac('sha256', this.options.secret).update(payload).digest('base64url')
  }

  private putSignature(key: string, expires: number, sha256: string): string {
    return this.sign('put', key, expires, sha256)
  }

  async presignPut(input: {
    key: string
    size: number
    sha256: string
    expiresInSeconds: number
  }): Promise<PresignedUpload> {
    const expires = this.now() + input.expiresInSeconds * 1000
    const url = new URL('/local-blob/put', this.options.baseUrl)
    url.searchParams.set('key', input.key)
    url.searchParams.set('expires', String(expires))
    url.searchParams.set('size', String(input.size))
    url.searchParams.set('sha256', input.sha256)
    url.searchParams.set('sig', this.putSignature(input.key, expires, input.sha256))
    return {
      url: url.toString(),
      method: 'PUT',
      headers: { 'content-type': BLOB_CONTENT_TYPE },
      expiresAt: new Date(expires),
    }
  }

  async presignGet(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload> {
    const expires = this.now() + input.expiresInSeconds * 1000
    const url = new URL('/local-blob/get', this.options.baseUrl)
    url.searchParams.set('key', input.key)
    url.searchParams.set('expires', String(expires))
    url.searchParams.set('sig', this.sign('get', input.key, expires))
    return { url: url.toString(), expiresAt: new Date(expires) }
  }

  verifyPut(input: {
    key: string
    expires: number
    sig: string
    sha256: string
  }): LocalSignatureCheck {
    return this.checkSignature(
      this.putSignature(input.key, input.expires, input.sha256),
      input.expires,
      input.sig,
    )
  }

  verifyGet(input: { key: string; expires: number; sig: string }): LocalSignatureCheck {
    return this.checkSignature(this.sign('get', input.key, input.expires), input.expires, input.sig)
  }

  private checkSignature(expectedPayload: string, expires: number, signature: string) {
    if (!Number.isFinite(expires)) return { ok: false as const, reason: 'expires is not a number' }
    if (expires < this.now()) return { ok: false as const, reason: 'link expired' }
    const expected = Buffer.from(expectedPayload)
    const presented = Buffer.from(signature)
    if (expected.length !== presented.length) return { ok: false as const, reason: 'bad signature' }
    if (!timingSafeEqual(expected, presented))
      return { ok: false as const, reason: 'bad signature' }
    return { ok: true as const }
  }

  /** Rejects keys that would escape the storage root. */
  private pathFor(key: string): string | null {
    const root = resolve(this.options.dir)
    const path = resolve(join(root, key))
    if (path !== root && !path.startsWith(`${root}${sep}`)) return null
    return path
  }

  /** Writes only after the bytes match the checksum the upload URL was signed for. */
  async localPut(key: string, bytes: Uint8Array, sha256?: string): Promise<void> {
    if (sha256 !== undefined) {
      const actual = sha256Hex(bytes)
      if (actual !== sha256) {
        throw new ChecksumMismatchError(`sha256 mismatch for ${key}: expected ${sha256}`)
      }
    }
    const path = this.pathFor(key)
    if (!path) throw new Error(`refusing to write outside the storage root: ${key}`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
  }

  async localGet(key: string): Promise<Uint8Array | null> {
    const path = this.pathFor(key)
    if (!path) return null
    try {
      return await readFile(path)
    } catch {
      return null
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.pathFor(key)
    if (!path) return
    await rm(path, { force: true })
  }

  /** Recomputed from the stored bytes so commit verification catches corruption. */
  async head(key: string): Promise<BlobHead | null> {
    const path = this.pathFor(key)
    if (!path) return null
    try {
      const bytes = await readFile(path)
      return { size: bytes.byteLength, sha256: sha256Hex(bytes) }
    } catch {
      return null
    }
  }
}
