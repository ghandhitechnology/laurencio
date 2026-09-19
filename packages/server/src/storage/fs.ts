import { createHmac, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import {
  BLOB_CONTENT_TYPE,
  type BlobStore,
  type PresignedDownload,
  type PresignedUpload,
} from './types'

export interface FsBlobStoreOptions {
  dir: string
  /** HMAC secret for the local presigned URLs. */
  secret: string
  baseUrl: string
  now?: () => number
}

export type LocalSignatureCheck = { ok: true } | { ok: false; reason: string }

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

  private sign(method: string, key: string, expires: number): string {
    return createHmac('sha256', this.options.secret)
      .update(`${method}:${key}:${expires}`)
      .digest('base64url')
  }

  private url(method: 'put' | 'get', key: string, expires: number, size?: number): string {
    const url = new URL(`/local-blob/${method}`, this.options.baseUrl)
    url.searchParams.set('key', key)
    url.searchParams.set('expires', String(expires))
    url.searchParams.set('sig', this.sign(method, key, expires))
    if (size !== undefined) url.searchParams.set('size', String(size))
    return url.toString()
  }

  async presignPut(input: {
    key: string
    size: number
    expiresInSeconds: number
  }): Promise<PresignedUpload> {
    const expires = this.now() + input.expiresInSeconds * 1000
    return {
      url: this.url('put', input.key, expires, input.size),
      method: 'PUT',
      headers: { 'content-type': BLOB_CONTENT_TYPE },
      expiresAt: new Date(expires),
    }
  }

  async presignGet(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload> {
    const expires = this.now() + input.expiresInSeconds * 1000
    return { url: this.url('get', input.key, expires), expiresAt: new Date(expires) }
  }

  verify(
    method: 'put' | 'get',
    key: string,
    expires: number,
    signature: string,
  ): LocalSignatureCheck {
    if (!Number.isFinite(expires)) return { ok: false, reason: 'expires is not a number' }
    if (expires < this.now()) return { ok: false, reason: 'link expired' }
    const expected = Buffer.from(this.sign(method, key, expires))
    const presented = Buffer.from(signature)
    if (expected.length !== presented.length) return { ok: false, reason: 'bad signature' }
    if (!timingSafeEqual(expected, presented)) return { ok: false, reason: 'bad signature' }
    return { ok: true }
  }

  /** Rejects keys that would escape the storage root. */
  private pathFor(key: string): string | null {
    const root = resolve(this.options.dir)
    const path = resolve(join(root, key))
    if (path !== root && !path.startsWith(`${root}${sep}`)) return null
    return path
  }

  async localPut(key: string, bytes: Uint8Array): Promise<void> {
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

  async head(key: string): Promise<{ size: number } | null> {
    const path = this.pathFor(key)
    if (!path) return null
    try {
      const info = await stat(path)
      return { size: info.size }
    } catch {
      return null
    }
  }
}
