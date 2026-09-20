import {
  type DeviceId,
  newId,
  type UserId,
  type WorkbenchSession,
  type WorkbenchSessionId,
  WorkbenchSession as WorkbenchSessionSchema,
} from '@laurencio/protocol'
import { and, desc, eq, isNull } from 'drizzle-orm'
import type { Database } from './db/client'
import { devices, deviceTokens, workbenchSessions } from './db/schema'
import { mintDeviceToken, recordAudit } from './devices'
import { notFound } from './http/errors'
import { asDeviceId, asWorkbenchSessionId } from './ids'

type SessionRow = typeof workbenchSessions.$inferSelect
type DeviceRow = typeof devices.$inferSelect

export interface MintedWorkbenchSession {
  session: WorkbenchSession
  token: string
}

export async function createWorkbenchSession(
  db: Database,
  input: {
    userId: UserId
    actorDeviceId: DeviceId | null
    name: string
    platform: string
    expiresAt: Date
  },
): Promise<MintedWorkbenchSession> {
  return db.transaction(async (tx) => {
    const deviceId = asDeviceId(newId())
    const sessionId = asWorkbenchSessionId(newId())
    const deviceRows = await tx
      .insert(devices)
      .values({
        id: deviceId,
        userId: input.userId,
        name: input.name,
        platform: input.platform,
        kind: 'temporary',
      })
      .returning()
    const device = deviceRows.at(0)
    if (!device) throw new Error('temporary device insert returned no row')
    const sessionRows = await tx
      .insert(workbenchSessions)
      .values({ id: sessionId, deviceId, expiresAt: input.expiresAt })
      .returning()
    const session = sessionRows.at(0)
    if (!session) throw new Error('workbench session insert returned no row')
    const token = await mintDeviceToken(tx, {
      userId: input.userId,
      deviceId,
      expiresAt: input.expiresAt,
    })
    await recordAudit(tx, {
      actorUserId: input.userId,
      deviceId,
      action: 'workbench_session.create',
      subject: sessionId,
      meta: { actorDeviceId: input.actorDeviceId, expiresAt: input.expiresAt.toISOString() },
    })
    return { session: toWorkbenchSession(session, device), token }
  })
}

export async function listWorkbenchSessions(
  db: Database,
  userId: UserId,
): Promise<WorkbenchSession[]> {
  const rows = await db
    .select({ session: workbenchSessions, device: devices })
    .from(workbenchSessions)
    .innerJoin(devices, eq(devices.id, workbenchSessions.deviceId))
    .where(eq(devices.userId, userId))
    .orderBy(desc(workbenchSessions.createdAt))
  return rows.map((row) => toWorkbenchSession(row.session, row.device))
}

/** Closing is idempotent and revokes every credential for the temporary actor. */
export async function closeWorkbenchSession(
  db: Database,
  input: {
    userId: UserId
    actorDeviceId: DeviceId | null
    sessionId: WorkbenchSessionId
    /** Temporary actors may close only the session that owns their token. */
    targetDeviceId?: DeviceId
  },
): Promise<WorkbenchSession> {
  return db.transaction(async (tx) => {
    const found = await tx
      .select({ session: workbenchSessions, device: devices })
      .from(workbenchSessions)
      .innerJoin(devices, eq(devices.id, workbenchSessions.deviceId))
      .where(
        and(
          eq(workbenchSessions.id, input.sessionId),
          eq(devices.userId, input.userId),
          input.targetDeviceId === undefined
            ? undefined
            : eq(workbenchSessions.deviceId, input.targetDeviceId),
        ),
      )
      .limit(1)
    const existing = found.at(0)
    if (!existing) throw notFound('unknown workbench session')
    if (existing.session.closedAt) {
      return toWorkbenchSession(existing.session, existing.device)
    }

    const now = new Date()
    const updatedRows = await tx
      .update(workbenchSessions)
      .set({ closedAt: now })
      .where(and(eq(workbenchSessions.id, input.sessionId), isNull(workbenchSessions.closedAt)))
      .returning()
    const session = updatedRows.at(0)
    if (!session) {
      const raced = await tx
        .select()
        .from(workbenchSessions)
        .where(eq(workbenchSessions.id, input.sessionId))
        .limit(1)
      const closed = raced.at(0)
      if (!closed) throw notFound('unknown workbench session')
      return toWorkbenchSession(closed, existing.device)
    }
    await tx
      .update(devices)
      .set({ revokedAt: now })
      .where(and(eq(devices.id, existing.device.id), isNull(devices.revokedAt)))
    await tx
      .update(deviceTokens)
      .set({ revokedAt: now })
      .where(and(eq(deviceTokens.deviceId, existing.device.id), isNull(deviceTokens.revokedAt)))
    await recordAudit(tx, {
      actorUserId: input.userId,
      deviceId: asDeviceId(existing.device.id),
      action: 'workbench_session.close',
      subject: input.sessionId,
      meta: { actorDeviceId: input.actorDeviceId },
    })
    return toWorkbenchSession(session, { ...existing.device, revokedAt: now })
  })
}

function toWorkbenchSession(row: SessionRow, device: DeviceRow): WorkbenchSession {
  return WorkbenchSessionSchema.parse({
    id: row.id,
    deviceId: row.deviceId,
    name: device.name,
    platform: device.platform,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ...(row.closedAt ? { closedAt: row.closedAt.toISOString() } : {}),
  })
}
