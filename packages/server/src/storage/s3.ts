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
    const checksum = Buffer.from(input.sha256, 'hex').toString('base64')
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: input.key,
      ContentLength: input.size,
      ContentType: BLOB_CONTENT_TYPE,
      // S3 rejects the PUT when the body does not hash to this value.
      ChecksumSHA256: checksum,
    })
    const url = await getSignedUrl(this.client, command, {
      expiresIn: input.expiresInSeconds,
      // Keep the checksum in a signed header the client must send back.
      unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
    })
    return {
      url,
      method: 'PUT',
      headers: {
        'content-type': BLOB_CONTENT_TYPE,
        'x-amz-checksum-sha256': checksum,
      },
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
      return {
        size: result.ContentLength ?? 0,
        sha256: base64ToHex(result.ChecksumSHA256),
      }
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
