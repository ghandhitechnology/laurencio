import type {
  BlobId,
  DeviceId,
  RevisionId,
  StoreId,
  UserId,
  WorkbenchSessionId,
} from '@laurencio/protocol'

/**
 * Casts for values that came out of our own database, where the id shape is
 * already an invariant. Values arriving over HTTP go through the zod schemas
 * in `@laurencio/protocol` instead.
 */
export const asUserId = (value: string): UserId => value as UserId
export const asDeviceId = (value: string): DeviceId => value as DeviceId
export const asStoreId = (value: string): StoreId => value as StoreId
export const asRevisionId = (value: string): RevisionId => value as RevisionId
export const asBlobId = (value: string): BlobId => value as BlobId
export const asWorkbenchSessionId = (value: string): WorkbenchSessionId =>
  value as WorkbenchSessionId
