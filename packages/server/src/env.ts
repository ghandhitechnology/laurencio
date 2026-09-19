import { randomBytes } from 'node:crypto'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** Random fallback for local runs; processes must not share a public constant. */
function randomSecret(): string {
  return randomBytes(32).toString('base64url')
}

/** Matches the time strings Better Auth accepts, for example "5s" or "30m". */
export type TimeString = `${number}${'s' | 'm' | 'h' | 'd'}`

export function isTimeString(value: string): value is TimeString {
  return /^\d+(s|m|h|d)$/.test(value)
}

export interface DatabaseConfig {
  /** Postgres connection string, or null to use an embedded PGlite directory. */
  url: string | null
  pgliteDir: string | null
}

export interface AuthConfig {
  githubClientId: string | null
  githubClientSecret: string | null
  allowDevSignin: boolean
  /** Time string accepted by Better Auth, for example "5s". */
  devicePollInterval: TimeString
  deviceClientId: string
}

export type StorageConfig =
  | {
      kind: 's3'
      bucket: string
      region: string
      endpoint: string | null
      accessKeyId: string
      secretAccessKey: string
      forcePathStyle: boolean
    }
  | { kind: 'fs'; dir: string; secret: string; baseUrl: string }

export interface ServerEnv {
  nodeEnv: 'development' | 'test' | 'staging' | 'production'
  port: number
  /** Loopback unless HOST is set; the deployment has to opt into a public bind. */
  host: string
  publicUrl: string
  secret: string
  /** True when no BETTER_AUTH_SECRET was supplied and a random one was minted. */
  generatedSecret: boolean
  trustedOrigins: string[]
  database: DatabaseConfig
  auth: AuthConfig
  storage: StorageConfig
  quota: { maxBytes: number; maxBlobs: number; maxBlobBytes: number }
  rate: {
    capacity: number
    refillPerSecond: number
    /** Separate bucket for browser device-approval attempts, keyed by client address. */
    approvalCapacity: number
    approvalRefillPerSecond: number
  }
  gc: { graceSeconds: number }
  autoMigrate: boolean
  logLevel: LogLevel
}

export class EnvError extends Error {}

export type EnvSource = Record<string, string | undefined>

function required(source: EnvSource, key: string): string {
  const value = source[key]
  if (!value) throw new EnvError(`missing required environment variable ${key}`)
  return value
}

function integer(source: EnvSource, key: string, fallback: number): number {
  const raw = source[key]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new EnvError(`${key} must be an integer, got ${raw}`)
  }
  return value
}

function booleanish(source: EnvSource, key: string, fallback: boolean): boolean {
  const raw = source[key]
  if (raw === undefined || raw === '') return fallback
  return raw === '1' || raw.toLowerCase() === 'true'
}

function logLevel(source: EnvSource): LogLevel {
  const raw = source.LOG_LEVEL ?? 'info'
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw
  throw new EnvError(`LOG_LEVEL must be debug, info, warn, or error, got ${raw}`)
}

function timeString(source: EnvSource, key: string, fallback: TimeString): TimeString {
  const raw = source[key]
  if (raw === undefined || raw === '') return fallback
  if (!isTimeString(raw)) throw new EnvError(`${key} must look like 5s, 30m, 2h, or 1d, got ${raw}`)
  return raw
}

export function loadEnv(source: EnvSource = process.env): ServerEnv {
  const rawNodeEnv = source.NODE_ENV ?? 'development'
  const nodeEnv =
    rawNodeEnv === 'production'
      ? 'production'
      : rawNodeEnv === 'staging'
        ? 'staging'
        : rawNodeEnv === 'test'
          ? 'test'
          : 'development'
  const isProduction = nodeEnv === 'production'

  const publicUrl = source.BETTER_AUTH_URL ?? `http://localhost:${source.PORT ?? '8787'}`
  const configuredSecret = source.BETTER_AUTH_SECRET
  // A public constant would let anyone forge sessions on a local instance that
  // is reachable from the network, so mint one per process instead.
  const secret = configuredSecret ?? (isProduction ? '' : randomSecret())
  if (!secret) throw new EnvError('missing required environment variable BETTER_AUTH_SECRET')

  const allowDevSignin = booleanish(source, 'ALLOW_DEV_SIGNIN', nodeEnv !== 'production')
  if (allowDevSignin && isProduction) {
    throw new EnvError('ALLOW_DEV_SIGNIN must not be set in production')
  }

  const githubClientId = source.GITHUB_CLIENT_ID ?? null
  const githubClientSecret = source.GITHUB_CLIENT_SECRET ?? null
  if (isProduction && (!githubClientId || !githubClientSecret)) {
    throw new EnvError('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required in production')
  }

  const databaseUrl = source.DATABASE_URL ?? null
  if (isProduction && !databaseUrl) {
    throw new EnvError('missing required environment variable DATABASE_URL')
  }
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    throw new EnvError('DATABASE_URL must be a postgres:// or postgresql:// URL')
  }

  return {
    nodeEnv,
    port: integer(source, 'PORT', 8787),
    host:
      source.HOST?.trim() ||
      (nodeEnv === 'production' || nodeEnv === 'staging' ? '0.0.0.0' : '127.0.0.1'),
    publicUrl,
    secret,
    generatedSecret: configuredSecret === undefined && !isProduction,
    trustedOrigins: (source.TRUSTED_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    database: {
      url: databaseUrl,
      pgliteDir: source.PGLITE_DATA_DIR ?? (isProduction ? null : '.data/pglite'),
    },
    auth: {
      githubClientId,
      githubClientSecret,
      allowDevSignin,
      devicePollInterval: timeString(source, 'DEVICE_POLL_INTERVAL', '5s'),
      deviceClientId: source.DEVICE_CLIENT_ID ?? 'laurencio-cli',
    },
    storage: storageConfig(source, { nodeEnv, publicUrl, fallbackSecret: secret }),
    quota: {
      maxBytes: integer(source, 'QUOTA_MAX_BYTES', 512 * 1024 * 1024),
      maxBlobs: integer(source, 'QUOTA_MAX_BLOBS', 20000),
      maxBlobBytes: integer(source, 'QUOTA_MAX_BLOB_BYTES', 64 * 1024 * 1024),
    },
    rate: {
      capacity: integer(source, 'RATE_LIMIT_CAPACITY', 60),
      refillPerSecond: integer(source, 'RATE_LIMIT_REFILL_PER_SECOND', 5),
      approvalCapacity: integer(source, 'DEVICE_APPROVAL_RATE_CAPACITY', 10),
      approvalRefillPerSecond: integer(source, 'DEVICE_APPROVAL_RATE_REFILL_PER_SECOND', 1),
    },
    // One day of slack so a commit racing a sweep still finds its objects.
    gc: { graceSeconds: integer(source, 'GC_GRACE_SECONDS', 24 * 60 * 60) },
    autoMigrate: booleanish(source, 'AUTO_MIGRATE', nodeEnv !== 'production'),
    logLevel: logLevel(source),
  }
}

function storageConfig(
  source: EnvSource,
  context: { nodeEnv: string; publicUrl: string; fallbackSecret: string },
): StorageConfig {
  const driver = source.STORAGE_DRIVER ?? ((source.S3_BUCKET ?? source.BUCKET) ? 's3' : 'fs')
  if (driver === 's3') {
    return {
      kind: 's3',
      bucket: required(source, source.S3_BUCKET ? 'S3_BUCKET' : 'BUCKET'),
      region: source.S3_REGION ?? source.REGION ?? 'auto',
      endpoint: source.S3_ENDPOINT ?? source.ENDPOINT ?? null,
      accessKeyId: source.S3_ACCESS_KEY_ID ?? required(source, 'ACCESS_KEY_ID'),
      secretAccessKey: source.S3_SECRET_ACCESS_KEY ?? required(source, 'SECRET_ACCESS_KEY'),
      forcePathStyle: booleanish(source, 'S3_FORCE_PATH_STYLE', true),
    }
  }
  if (driver !== 'fs') throw new EnvError(`STORAGE_DRIVER must be s3 or fs, got ${driver}`)
  if (context.nodeEnv === 'production') {
    throw new EnvError('the filesystem storage driver is not available in production')
  }
  const dir = source.FS_STORAGE_DIR ?? '.data/blobs'
  const fsSecret = source.FS_STORAGE_SECRET ?? context.fallbackSecret
  return {
    kind: 'fs',
    dir,
    secret: fsSecret,
    baseUrl: source.FS_STORAGE_BASE_URL ?? context.publicUrl,
  }
}
