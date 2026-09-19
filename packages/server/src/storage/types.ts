import { createHash } from 'node:crypto'
import type { BlobId, StoreId } from '@laurencio/protocol'

export const BLOB_CONTENT_TYPE = 'application/octet-stream'

export interface PresignedUpload {
  url: string
  method: 'PUT'
  headers: Record<string, string>
  expiresAt: Date
}

export interface PresignedDownload {
  url: string
  expiresAt: Date
}

export interface BlobHead {
  size: number
  /** Lowercase hex sha256, or null when the backend cannot report one. */
  sha256: string | null
}

export interface BlobStore {
  readonly kind: 's3' | 'fs'
  /**
   * The sha256 is the blob id, so the upload URL has to bind it: S3 signs a
   * checksum condition and the filesystem store verifies the bytes it writes.
   */
  presignPut(input: {
    key: string
    size: number
    sha256: string
    expiresInSeconds: number
  }): Promise<PresignedUpload>
  presignGet(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload>
  /** Deleting a key that does not exist is not an error. */
  delete(key: string): Promise<void>
  /** Returns the stored size and checksum, or null when the object is absent. */
  head(key: string): Promise<BlobHead | null>
}

/** The only key scheme the server uses: store id plus client-supplied ciphertext hash. */
export function blobKey(storeId: StoreId, blobId: BlobId): string {
  return `u/${storeId}/b/${blobId}`
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
