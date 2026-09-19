import { createHash } from 'node:crypto'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { StorageConfig } from '../env'
import {
  BLOB_CONTENT_TYPE,
  type BlobHead,
  type BlobStore,
  type PresignedDownload,
  type PresignedUpload,
} from './types'

/** Objects up to this size are downloaded and hashed when the storage reports no checksum. */
const MAX_HASH_BYTES = 16 * 1024 * 1024

export type S3Config = Extract<StorageConfig, { kind: 's3' }>

export function createS3Client(config: S3Config): S3Client {
  return new S3Client({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  })
}

export class S3BlobStore implements BlobStore {
  readonly kind = 's3' as const
  private readonly config: S3Config
  private readonly client: S3Client

  constructor(config: S3Config, client: S3Client = createS3Client(config)) {
    this.config = config
    this.client = client
  }

  async presignPut(input: {
    key: string
    size: number
    sha256: string
    expiresInSeconds: number
  }): Promise<PresignedUpload> {
    // The checksum is verified server-side at commit by hashing the stored
    // object, because a signed checksum header is rejected by some S3-compatible
    // storages and an unsigned one is not trustworthy enough to rely on.
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ContentLength: input.size,
      ContentType: BLOB_CONTENT_TYPE,
    })
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
    })
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': BLOB_CONTENT_TYPE },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    }
  }

  async presignGet(input: { key: string; expiresInSeconds: number }): Promise<PresignedDownload> {
    const command = new GetObjectCommand({ Bucket: this.config.bucket, Key: input.key })
    const url = await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds })
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }))
  }

  async head(key: string): Promise<BlobHead | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      const size = result.ContentLength ?? 0
      let sha256 = base64ToHex(result.ChecksumSHA256)
      // Small objects are hashed on demand so verification does not depend on the
      // storage reporting checksum metadata.
      if (sha256 === null && size <= MAX_HASH_BYTES) {
        const object = await this.client.send(
          new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        )
        if (object.Body !== undefined) {
          const bytes = await object.Body.transformToByteArray()
          sha256 = createHash('sha256').update(bytes).digest('hex')
        }
      }
      return { size, sha256 }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
}

function base64ToHex(base64: string | undefined): string | null {
  if (!base64) return null
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength !== 32) return null
  return bytes.toString('hex')
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return (
    candidate.name === 'NotFound' ||
    candidate.name === 'NoSuchKey' ||
    candidate.$metadata?.httpStatusCode === 404
  )
}
