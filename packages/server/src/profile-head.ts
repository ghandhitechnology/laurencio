import {
  type BlobRef,
  type DeviceId,
  type ProfileHead,
  ProfileHead as ProfileHeadSchema,
  type StoreId,
  type UserId,
} from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { blobs, profileHeads } from './db/schema'
import { recordAudit } from './devices'
import { badRequest, conflict } from './http/errors'

type ProfileHeadRow = typeof profileHeads.$inferSelect

export async function readProfileHead(db: Database, storeId: StoreId): Promise<ProfileHead | null> {
  const rows = await db
    .select()
    .from(profileHeads)
    .where(eq(profileHeads.storeId, storeId))
    .limit(1)
  const row = rows.at(0)
  return row ? toProfileHead(row) : null
}

export async function writeProfileHead(
  db: Database,
  input: {
    storeId: StoreId
    actorUserId: UserId
    actorDeviceId: DeviceId
    blob: BlobRef
    expectedGeneration: number | null
  },
): Promise<ProfileHead> {
  return db.transaction(async (tx) => {
    const registered = await tx
      .select({ size: blobs.size })
      .from(blobs)
      .where(and(eq(blobs.storeId, input.storeId), eq(blobs.id, input.blob.id)))
      .limit(1)
    const storedBlob = registered.at(0)
    if (!storedBlob) {
      throw badRequest('profile blob is not registered in this store', { blobId: input.blob.id })
    }
    if (storedBlob.size !== input.blob.size) {
      throw badRequest('profile blob size does not match its registration', {
        blobId: input.blob.id,
        declaredSize: input.blob.size,
        registeredSize: storedBlob.size,
      })
    }

    const generation = input.expectedGeneration === null ? 1 : input.expectedGeneration + 1
    const updated =
      input.expectedGeneration === null
        ? await tx
            .insert(profileHeads)
            .values({
              storeId: input.storeId,
              blobId: input.blob.id,
              blobSize: input.blob.size,
              generation,
            })
            .onConflictDoNothing()
            .returning()
        : await tx
            .update(profileHeads)
            .set({
              blobId: input.blob.id,
              blobSize: input.blob.size,
              generation,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(profileHeads.storeId, input.storeId),
                eq(profileHeads.generation, input.expectedGeneration),
              ),
            )
            .returning()
    const row = updated.at(0)
    if (!row) {
      const current = await tx
        .select({ generation: profileHeads.generation })
        .from(profileHeads)
        .where(eq(profileHeads.storeId, input.storeId))
        .limit(1)
      throw conflict('profile head generation changed', {
        expectedGeneration: input.expectedGeneration,
        generation: current.at(0)?.generation ?? null,
      })
    }
    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      deviceId: input.actorDeviceId,
      action: 'profile.rotate',
      subject: input.storeId,
      meta: { generation: row.generation },
    })
    return toProfileHead(row)
  })
}

function toProfileHead(row: ProfileHeadRow): ProfileHead {
  return ProfileHeadSchema.parse({
    blob: { id: row.blobId, size: row.blobSize },
    generation: row.generation,
    updatedAt: row.updatedAt.toISOString(),
  })
}
