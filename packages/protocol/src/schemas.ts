import { z } from 'zod'
import { BlobId, DeviceId, RevisionId, StoreId, SurfaceId, UserId, WorkbenchSessionId } from './ids'
import { CURRENT_PROFILE_VERSION, PROTOCOL_VERSION } from './version'

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

export const DeviceListResponse = z.object({
  protocolVersion: z.number().int().positive(),
  devices: z.array(DeviceRecord),
})
export type DeviceListResponse = z.infer<typeof DeviceListResponse>

export const DeviceCreateResponse = z.object({
  protocolVersion: z.number().int().positive(),
  device: DeviceRecord,
  /** Device token, shown once. Stored by the client in the OS keychain. */
  token: z.string().min(16),
})
export type DeviceCreateResponse = z.infer<typeof DeviceCreateResponse>

export const WORKBENCH_SESSION_DEFAULT_TTL_SECONDS = 24 * 60 * 60
export const WORKBENCH_SESSION_MIN_TTL_SECONDS = 60 * 60
export const WORKBENCH_SESSION_MAX_TTL_SECONDS = 7 * 24 * 60 * 60

export const WorkbenchSession = z.object({
  id: WorkbenchSessionId,
  deviceId: DeviceId,
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  createdAt: isoDate,
  expiresAt: isoDate,
  closedAt: isoDate.optional(),
})
export type WorkbenchSession = z.infer<typeof WorkbenchSession>

export const WorkbenchSessionCreateRequest = z.object({
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
  expiresInSeconds: z.number().int().positive().optional(),
})
export type WorkbenchSessionCreateRequest = z.infer<typeof WorkbenchSessionCreateRequest>

export const WorkbenchSessionCreateResponse = z.object({
  protocolVersion: z.number().int().positive(),
  session: WorkbenchSession,
  /** Temporary device token, shown once and valid only for this session. */
  token: z.string().min(16),
})
export type WorkbenchSessionCreateResponse = z.infer<typeof WorkbenchSessionCreateResponse>

export const WorkbenchSessionListResponse = z.object({
  protocolVersion: z.number().int().positive(),
  sessions: z.array(WorkbenchSession),
})
export type WorkbenchSessionListResponse = z.infer<typeof WorkbenchSessionListResponse>

export const WorkbenchSessionCloseResponse = z.object({
  protocolVersion: z.number().int().positive(),
  session: WorkbenchSession,
})
export type WorkbenchSessionCloseResponse = z.infer<typeof WorkbenchSessionCloseResponse>

export const ProfileVersion = z.union([z.literal(1), z.literal(2)])
export type ProfileVersion = z.infer<typeof ProfileVersion>

export const ProfileVersionWriteRequest = z.object({
  expectedVersion: z.literal(1),
  profileVersion: z.literal(CURRENT_PROFILE_VERSION),
})
export type ProfileVersionWriteRequest = z.infer<typeof ProfileVersionWriteRequest>

export const ProfileVersionResponse = z.object({
  protocolVersion: z.number().int().positive(),
  profileVersion: ProfileVersion,
})
export type ProfileVersionResponse = z.infer<typeof ProfileVersionResponse>

export const BlobDownloadResponse = z.object({
  protocolVersion: z.number().int().positive(),
  blobId: BlobId,
  size: z.number().int().nonnegative(),
  url: z.string().url(),
  expiresAt: isoDate,
})
export type BlobDownloadResponse = z.infer<typeof BlobDownloadResponse>

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

export const KdfResponse = z.object({
  protocolVersion: z.number().int().positive(),
  kdf: KdfParams.nullable(),
  /** KDF generation; increments on passphrase rotation. Null before enrollment. */
  generation: z.number().int().nonnegative().nullable().optional(),
})
export type KdfResponse = z.infer<typeof KdfResponse>

export const KdfWriteRequest = KdfParams.extend({
  /** Generation the writer read; null asserts the store has no parameters yet. */
  generation: z.number().int().positive().nullable(),
})
export type KdfWriteRequest = z.infer<typeof KdfWriteRequest>

export const KdfWriteResponse = z.object({
  protocolVersion: z.number().int().positive(),
  kdf: KdfParams,
  /** Generation the write produced. */
  generation: z.number().int().positive(),
})
export type KdfWriteResponse = z.infer<typeof KdfWriteResponse>

export const BlobRef = z.object({
  id: BlobId,
  size: z.number().int().nonnegative(),
})
export type BlobRef = z.infer<typeof BlobRef>

export const VaultHead = z.object({
  blob: BlobRef,
  generation: z.number().int().positive(),
  updatedAt: isoDate,
})
export type VaultHead = z.infer<typeof VaultHead>

export const VaultHeadWriteRequest = z.object({
  blob: BlobRef,
  expectedGeneration: z.number().int().positive().nullable(),
})
export type VaultHeadWriteRequest = z.infer<typeof VaultHeadWriteRequest>

export const VaultHeadResponse = z.object({
  protocolVersion: z.number().int().positive(),
  head: VaultHead.nullable(),
})
export type VaultHeadResponse = z.infer<typeof VaultHeadResponse>

export const ProfileHead = z.object({
  blob: BlobRef,
  generation: z.number().int().positive(),
  updatedAt: isoDate,
})
export type ProfileHead = z.infer<typeof ProfileHead>

export const ProfileHeadWriteRequest = z.object({
  blob: BlobRef,
  expectedGeneration: z.number().int().positive().nullable(),
})
export type ProfileHeadWriteRequest = z.infer<typeof ProfileHeadWriteRequest>

export const ProfileHeadResponse = z.object({
  protocolVersion: z.number().int().positive(),
  head: ProfileHead.nullable(),
})
export type ProfileHeadResponse = z.infer<typeof ProfileHeadResponse>

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
  /** KDF generation; increments on passphrase rotation. */
  kdfGeneration: z.number().int().nonnegative().nullable().optional(),
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
