import type { DeviceId } from '@laurencio/protocol'
import {
  PROFILE_VERSION_HEADER,
  ProfileVersion,
  type StoreId,
  type UserId,
} from '@laurencio/protocol'
import { and, eq } from 'drizzle-orm'
import type { Database } from './db/client'
import { stores } from './db/schema'
import { recordAudit, type StoreRow } from './devices'
import { badRequest, conflict } from './http/errors'

/** Missing means legacy profile v1 so deployed clients keep working. */
export function readClientProfileVersion(headers: Headers): number {
  const raw = headers.get(PROFILE_VERSION_HEADER)
  if (raw === null) return 1
  const version = Number(raw)
  if (!Number.isInteger(version) || version < 1) {
    throw badRequest(`${PROFILE_VERSION_HEADER} must be a positive integer`)
  }
  return version
}

export function requireCompatibleProfileWrite(store: StoreRow, headers: Headers): number {
  const clientProfileVersion = readClientProfileVersion(headers)
  if (clientProfileVersion < store.profileVersion) {
    throw conflict('client profile version is too old to write this store', {
      storeProfileVersion: store.profileVersion,
      clientProfileVersion,
    })
  }
  return clientProfileVersion
}

export function requireProfileV2Write(store: StoreRow, headers: Headers): number {
  if (store.profileVersion !== 2) {
    throw conflict('store must be migrated to profile v2 before this write', {
      storeProfileVersion: store.profileVersion,
      requiredProfileVersion: 2,
    })
  }
  return requireCompatibleProfileWrite(store, headers)
}

export async function updateStoreProfileVersion(
  db: Database,
  input: {
    storeId: StoreId
    actorUserId: UserId
    actorDeviceId: DeviceId | null
    expectedVersion: 1
    profileVersion: 2
    clientProfileVersion: number
  },
): Promise<1 | 2> {
  if (input.clientProfileVersion < input.profileVersion) {
    throw conflict('client cannot migrate a store beyond its own profile version', {
      storeProfileVersion: input.expectedVersion,
      clientProfileVersion: input.clientProfileVersion,
      requestedProfileVersion: input.profileVersion,
    })
  }
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(stores)
      .set({ profileVersion: input.profileVersion })
      .where(and(eq(stores.id, input.storeId), eq(stores.profileVersion, input.expectedVersion)))
      .returning({ profileVersion: stores.profileVersion })
    const row = rows.at(0)
    if (!row) return null
    await recordAudit(tx, {
      actorUserId: input.actorUserId,
      deviceId: input.actorDeviceId,
      action: 'store.profile_version.update',
      subject: input.storeId,
      meta: {
        from: input.expectedVersion,
        to: input.profileVersion,
        clientProfileVersion: input.clientProfileVersion,
      },
    })
    return ProfileVersion.parse(row.profileVersion)
  })
  if (updated !== null) return updated

  const current = await db
    .select({ profileVersion: stores.profileVersion })
    .from(stores)
    .where(eq(stores.id, input.storeId))
    .limit(1)
  throw conflict('store profile version changed', {
    expectedVersion: input.expectedVersion,
    profileVersion: current.at(0)?.profileVersion ?? null,
  })
}
