import {
  type BlobRef,
  type DeviceId,
  type StoreId,
  type UserId,
  type VaultHead,
  VaultHead as VaultHeadSchema,
} from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { blobs, vaultHeads } from './db/schema'
import { recordAudit } from './devices'
import { badRequest, conflict } from './http/errors'

type VaultHeadRow = typeof vaultHeads.$inferSelect

export async function readVaultHead(db: Database, storeId: StoreId): Promise<VaultHead | null> {
  const rows = await db.select().from(vaultHeads).where(eq(vaultHeads.storeId, storeId)).limit(1)
  const row = rows.at(0)
  return row ? toVaultHead(row) : null
}

export async function writeVaultHead(
  db: Database,
  input: {
    storeId: StoreId
    actorUserId: UserId
    actorDeviceId: DeviceId
    blob: BlobRef
    expectedGeneration: number | null
  },
): Promise<VaultHead> {
  return db.transaction(async (tx) => {
    const registered = await tx
      .select({ size: blobs.size })
      .from(blobs)
      .where(and(eq(blobs.storeId, input.storeId), eq(blobs.id, input.blob.id)))
      .limit(1)
    const storedBlob = registered.at(0)
    if (!storedBlob) {
      throw badRequest('vault blob is not registered in this store', { blobId: input.blob.id })
    }
    if (storedBlob.size !== input.blob.size) {
      throw badRequest('vault blob size does not match its registration', {
        blobId: input.blob.id,
        declaredSize: input.blob.size,
        registeredSize: storedBlob.size,
      })
    }

    const generation = input.expectedGeneration === null ? 1 : input.expectedGeneration + 1
    const updated =
      input.expectedGeneration === null
        ? await tx
            .insert(vaultHeads)
            .values({
              storeId: input.storeId,
              blobId: input.blob.id,
              blobSize: input.blob.size,
              generation,
            })
            .onConflictDoNothing()
            .returning()
        : await tx
            .update(vaultHeads)
            .set({
              blobId: input.blob.id,
              blobSize: input.blob.size,
              generation,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(vaultHeads.storeId, input.storeId),
                eq(vaultHeads.generation, input.expectedGeneration),
              ),
            )
            .returning()
    const row = updated.at(0)
    if (!row) {
      const current = await tx
        .select({ generation: vaultHeads.generation })
        .from(vaultHeads)
        .where(eq(vaultHeads.storeId, input.storeId))
        .limit(1)
      throw conflict('vault head generation changed', {
        expectedGeneration: input.expectedGeneration,
        generation: current.at(0)?.generation ?? null,
      })
    }
    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      deviceId: input.actorDeviceId,
      action: 'vault.rotate',
      subject: input.storeId,
      meta: { generation: row.generation },
    })
    return toVaultHead(row)
  })
}

function toVaultHead(row: VaultHeadRow): VaultHead {
  return VaultHeadSchema.parse({
    blob: { id: row.blobId, size: row.blobSize },
    generation: row.generation,
    updatedAt: row.updatedAt.toISOString(),
  })
}
