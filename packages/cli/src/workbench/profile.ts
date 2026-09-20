import {
  type crypto,
  type Manifest,
  migrateManifestToProfile,
  openProfile,
  type PortableProfile,
  type ProfileRemote,
  type ProfileSettings,
  type Remote,
  sealProfile,
} from '@laurencio/core'
import type { ProfileHead, StoreId } from '@laurencio/protocol'

interface ProfileStoreInput {
  remote: Remote & ProfileRemote
  storeId: StoreId
  key: crypto.KeyMaterial
}

export interface StoredPortableProfile {
  profile: PortableProfile
  head: ProfileHead
}

const profileContext = (storeId: StoreId) => ({ storeId, protocolVersion: 1 })

export async function loadPortableProfile(
  input: ProfileStoreInput,
): Promise<StoredPortableProfile | null> {
  const head = await input.remote.getProfileHead()
  if (head === null) return null
  const ciphertext = await input.remote.getBlob(head.blob.id)
  try {
    return {
      profile: openProfile(input.key, ciphertext, profileContext(input.storeId)),
      head,
    }
  } finally {
    ciphertext.fill(0)
  }
}

export async function savePortableProfile(
  input: ProfileStoreInput & { profile: PortableProfile; expectedGeneration: number | null },
): Promise<ProfileHead> {
  const sealed = sealProfile(input.profile, input.key, profileContext(input.storeId))
  try {
    const blob = await input.remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
    return await input.remote.putProfileHead({ blob, expectedGeneration: input.expectedGeneration })
  } finally {
    sealed.bytes.fill(0)
  }
}

/** Initializes v2 metadata or advances its manifest while preserving account-wide settings. */
export async function updatePortableProfileManifest(
  input: ProfileStoreInput & { manifest: Manifest; initialSettings?: ProfileSettings },
): Promise<StoredPortableProfile> {
  const current = await loadPortableProfile(input)
  const profile =
    current === null
      ? {
          ...migrateManifestToProfile(input.manifest),
          ...(input.initialSettings === undefined ? {} : { shared: input.initialSettings }),
        }
      : { ...current.profile, manifest: input.manifest }
  const head = await savePortableProfile({
    ...input,
    profile,
    expectedGeneration: current?.head.generation ?? null,
  })
  return { profile, head }
}
