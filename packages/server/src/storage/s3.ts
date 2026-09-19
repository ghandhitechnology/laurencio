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
  type BlobStore,
  type PresignedDownload,
  type PresignedUpload,
} from './types'

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
    expiresInSeconds: number
  }): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ContentLength: input.size,
      ContentType: BLOB_CONTENT_TYPE,
    })
    const url = await getSignedUrl(this.client, command, { expiresIn: input.expiresInSeconds })
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

  async head(key: string): Promise<{ size: number } | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      )
      return { size: result.ContentLength ?? 0 }
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
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
