import type { ServerEnv } from '../env'
import { FsBlobStore } from './fs'
import { S3BlobStore } from './s3'
import type { BlobStore } from './types'

export function createBlobStore(env: ServerEnv): BlobStore {
  if (env.storage.kind === 's3') return new S3BlobStore(env.storage)
  return new FsBlobStore(env.storage)
}

export { FsBlobStore } from './fs'
export { createS3Client, S3BlobStore } from './s3'
export * from './types'
