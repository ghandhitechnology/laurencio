import { z } from 'zod'
import { BlobId, DeviceId, RevisionId, StoreId, SurfaceId, UserId } from './ids'
import { PROTOCOL_VERSION } from './version'

const isoDate = z.string().datetime()

export const ErrorCode = z.enum([
  'protocol_mismatch',
  'unauthenticated',
  'forbidden',
  'not_found',
  'invalid_request',
  'conflict',
  'quota_exceeded',
  'rate_limited',
  'internal',
])
export type ErrorCode = z.infer<typeof ErrorCode>

export const ErrorResponse = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type ErrorResponse = z.infer<typeof ErrorResponse>

export const DeviceRecord = z.object({
  id: DeviceId,
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  createdAt: isoDate,
  lastSeenAt: isoDate.optional(),
  revokedAt: isoDate.optional(),
})
export type DeviceRecord = z.infer<typeof DeviceRecord>

export const DeviceRenameRequest = z.object({ name: z.string().min(1).max(80) })
export type DeviceRenameRequest = z.infer<typeof DeviceRenameRequest>

export const KdfParams = z.object({
  algo: z.literal('argon2id'),
  version: z.literal(1),
  salt: z.string().regex(/^[A-Za-z0-9+/=]{16,}$/, 'base64 salt'),
  m: z.number().int().positive(),
  t: z.number().int().positive(),
  p: z.number().int().positive(),
  calibratedAt: isoDate,
})
export type KdfParams = z.infer<typeof KdfParams>

export const BlobRef = z.object({
  id: BlobId,
  size: z.number().int().nonnegative(),
})
export type BlobRef = z.infer<typeof BlobRef>

export const PresignRequest = z.object({
  blob: BlobRef,
})
export type PresignRequest = z.infer<typeof PresignRequest>

export const PresignResponse = z.object({
  url: z.string().url(),
  method: z.literal('PUT'),
  expiresAt: isoDate,
  headers: z.record(z.string(), z.string()),
  blobId: BlobId,
})
export type PresignResponse = z.infer<typeof PresignResponse>

export const RevisionSummary = z.object({
  id: RevisionId,
  storeId: StoreId,
  deviceId: DeviceId,
  parents: z.array(RevisionId).max(4),
  manifest: BlobRef,
  createdAt: isoDate,
})
export type RevisionSummary = z.infer<typeof RevisionSummary>

export const CommitRequest = z.object({
  protocolVersion: z.number().int().positive(),
  revision: RevisionSummary,
  blobs: z.array(BlobRef).max(4096),
  note: z.string().max(200).optional(),
})
export type CommitRequest = z.infer<typeof CommitRequest>

export const CommitResponse = z.object({
  revisionId: RevisionId,
  accepted: z.boolean(),
  missing: z.array(BlobId),
})
export type CommitResponse = z.infer<typeof CommitResponse>

export const RevisionList = z.object({
  protocolVersion: z.number().int().positive(),
  revisions: z.array(RevisionSummary),
  head: RevisionId.nullable(),
})
export type RevisionList = z.infer<typeof RevisionList>

export const MeResponse = z.object({
  protocolVersion: z.number().int().positive(),
  userId: UserId,
  storeId: StoreId,
  devices: z.array(DeviceRecord),
  kdf: KdfParams.nullable(),
  quotas: z.object({
    blobs: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    maxBytes: z.number().int().nonnegative(),
  }),
})
export type MeResponse = z.infer<typeof MeResponse>

export const SurfaceRef = z.object({
  id: SurfaceId,
  harness: z.string(),
  paths: z.array(z.string()),
})
export type SurfaceRef = z.infer<typeof SurfaceRef>

export { PROTOCOL_VERSION }
