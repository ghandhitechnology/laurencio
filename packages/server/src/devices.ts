import { createHash, randomBytes } from 'node:crypto'
import {
  type DeviceId,
  type DeviceRecord,
  DeviceRecord as DeviceRecordSchema,
  newId,
  type StoreId,
  type UserId,
} from '@laurencio/protocol'
import { and, desc, eq, gt, isNull, or } from 'drizzle-orm'
import type { Principal } from './context'
import type { Database } from './db/client'
import { auditLog, devices, deviceTokens, stores } from './db/schema'
import { forbidden, notFound } from './http/errors'
import { asDeviceId, asUserId } from './ids'

export type DeviceRow = typeof devices.$inferSelect
export type StoreRow = typeof stores.$inferSelect
export type DeviceTokenRow = typeof deviceTokens.$inferSelect

const TOKEN_PREFIX = 'lrn_'
/** Active devices renew this window; devices idle for 90 days must sign in again. */
export const TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function newDeviceToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
}

export function toDeviceRecord(row: DeviceRow): DeviceRecord {
  return DeviceRecordSchema.parse({
    id: row.id,
    name: row.name,
    platform: row.platform,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastSeenAt ? { lastSeenAt: row.lastSeenAt.toISOString() } : {}),
    ...(row.revokedAt ? { revokedAt: row.revokedAt.toISOString() } : {}),
  })
}

/** Creates the user's single store on first use. */
export async function ensureStore(db: Database, userId: UserId): Promise<StoreRow> {
  const found = await db.select().from(stores).where(eq(stores.userId, userId)).limit(1)
  const existing = found.at(0)
  if (existing) return existing
  const inserted = await db
    .insert(stores)
    .values({ id: newId(), userId })
    .onConflictDoNothing()
    .returning()
  const created = inserted.at(0)
  if (created) return created
  const retry = await db.select().from(stores).where(eq(stores.userId, userId)).limit(1)
  const raced = retry.at(0)
  if (!raced) throw new Error('store creation lost a race and the row is still missing')
  return raced
}

export async function requireStore(
  db: Database,
  userId: UserId,
  storeId: StoreId,
): Promise<StoreRow> {
  const found = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1)
  const store = found.at(0)
  if (!store) throw notFound('unknown store')
  if (store.userId !== userId) throw forbidden('store belongs to another account')
  return store
}

export async function getStoreByUser(db: Database, userId: UserId): Promise<StoreRow | null> {
  const found = await db.select().from(stores).where(eq(stores.userId, userId)).limit(1)
  return found.at(0) ?? null
}

export interface MintedDevice {
  device: DeviceRecord
  token: string
}

export async function createDevice(
  db: Database,
  input: { userId: UserId; name: string; platform: string },
): Promise<MintedDevice> {
  const deviceId = newId()
  const inserted = await db
    .insert(devices)
    .values({ id: deviceId, userId: input.userId, name: input.name, platform: input.platform })
    .returning()
  const row = inserted.at(0)
  if (!row) throw new Error('device insert returned no row')
  const token = await mintDeviceToken(db, { userId: input.userId, deviceId: asDeviceId(deviceId) })
  return { device: toDeviceRecord(row), token }
}

export async function mintDeviceToken(
  db: Database,
  input: { userId: UserId; deviceId: DeviceId },
): Promise<string> {
  const token = newDeviceToken()
  await db.insert(deviceTokens).values({
    id: newId(),
    deviceId: input.deviceId,
    userId: input.userId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  })
  return token
}

export interface DeviceAuth {
  principal: Principal
  device: DeviceRow
  token: DeviceTokenRow
}

export type DeviceAuthFailure = 'unknown' | 'revoked' | 'expired'

export type DeviceAuthResult =
  | { ok: true; auth: DeviceAuth }
  | { ok: false; reason: DeviceAuthFailure }

/** Resolves a device token so the caller can tell expired from unknown or revoked. */
export async function authenticateDeviceToken(
  db: Database,
  token: string,
): Promise<DeviceAuthResult> {
  const found = await db
    .select({ token: deviceTokens, device: devices })
    .from(deviceTokens)
    .innerJoin(devices, eq(devices.id, deviceTokens.deviceId))
    .where(eq(deviceTokens.tokenHash, hashToken(token)))
    .limit(1)
  const row = found.at(0)
  if (!row) return { ok: false, reason: 'unknown' }
  if (row.token.revokedAt || row.device.revokedAt) return { ok: false, reason: 'revoked' }
  if (row.token.expiresAt && row.token.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'expired' }
  }
  return {
    ok: true,
    auth: {
      principal: {
        userId: asUserId(row.token.userId),
        deviceId: asDeviceId(row.device.id),
        tokenId: row.token.id,
      },
      device: row.device,
      token: row.token,
    },
  }
}

/** Presence and sliding expiry, written at most once a minute per token. */
export async function touchDevice(
  db: Database,
  auth: DeviceAuth,
  now: Date = new Date(),
): Promise<void> {
  const lastUsed = auth.token.lastUsedAt?.getTime() ?? 0
  if (now.getTime() - lastUsed < 60_000) return
  await db
    .update(deviceTokens)
    .set({ lastUsedAt: now, expiresAt: new Date(now.getTime() + TOKEN_TTL_MS) })
    .where(
      and(
        eq(deviceTokens.id, auth.token.id),
        isNull(deviceTokens.revokedAt),
        or(isNull(deviceTokens.expiresAt), gt(deviceTokens.expiresAt, now)),
      ),
    )
  await db
    .update(devices)
    .set({ lastSeenAt: now })
    .where(and(eq(devices.id, auth.device.id), isNull(devices.revokedAt)))
}

/** Marks the device revoked and kills its tokens in the same transaction. */
export async function revokeDevice(
  db: Database,
  input: { userId: UserId; deviceId: DeviceId; actorUserId: UserId },
): Promise<DeviceRecord> {
  const released = await db.transaction(async (tx) => {
    const now = new Date()
    const updated = await tx
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.id, input.deviceId), eq(devices.userId, input.userId)))
      .returning()
    const row = updated.at(0)
    if (!row) return null
    await tx
      .update(deviceTokens)
      .set({ revokedAt: now })
      .where(and(eq(deviceTokens.deviceId, input.deviceId), isNull(deviceTokens.revokedAt)))
    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      deviceId: input.deviceId,
      action: 'device.revoke',
      subject: input.deviceId,
    })
    return row
  })
  if (!released) throw notFound('unknown device')
  return toDeviceRecord(released)
}

export async function renameDevice(
  db: Database,
  input: { userId: UserId; deviceId: DeviceId; name: string },
): Promise<DeviceRecord> {
  const updated = await db
    .update(devices)
    .set({ name: input.name })
    .where(and(eq(devices.id, input.deviceId), eq(devices.userId, input.userId)))
    .returning()
  const row = updated.at(0)
  if (!row) throw notFound('unknown device')
  await recordAudit(db, {
    actorUserId: input.userId,
    action: 'device.rename',
    subject: input.deviceId,
    meta: { name: input.name },
  })
  return toDeviceRecord(row)
}

export async function listDevices(
  db: Database,
  userId: UserId,
  options: { includeRevoked?: boolean } = {},
): Promise<DeviceRecord[]> {
  const rows = await db
    .select()
    .from(devices)
    .where(
      options.includeRevoked
        ? eq(devices.userId, userId)
        : and(eq(devices.userId, userId), isNull(devices.revokedAt)),
    )
    .orderBy(desc(devices.createdAt))
  return rows.map(toDeviceRecord)
}

export interface AuditEntry {
  actorUserId: UserId | null
  deviceId?: DeviceId | null
  action: string
  subject?: string | null
  meta?: Record<string, unknown> | null
}

type Inserter = Pick<Database, 'insert'>

export async function recordAudit(db: Inserter, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    id: newId(),
    actorUserId: entry.actorUserId,
    deviceId: entry.deviceId ?? null,
    action: entry.action,
    subject: entry.subject ?? null,
    meta: entry.meta ?? null,
  })
}
