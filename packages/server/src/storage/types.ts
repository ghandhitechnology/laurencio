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

export interface BlobStore {
  readonly kind: 's3' | 'fs'
  presignPut(input: {
    key: string
    size: number
    expiresInSeconds: number
  }): Promise<PresignedUpload>
  presignGet(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload>
  /** Deleting a key that does not exist is not an error. */
  delete(key: string): Promise<void>
  /** Returns the stored size, or null when the object is absent. */
  head(key: string): Promise<{ size: number } | null>
}

/** The only key scheme the server uses: store id plus client-supplied ciphertext hash. */
export function blobKey(storeId: StoreId, blobId: BlobId): string {
  return `u/${storeId}/b/${blobId}`
}
