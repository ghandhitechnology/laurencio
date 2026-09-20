import type { Remote } from '@laurencio/core'

interface ProfileVersionRemote {
  getProfileVersion(): Promise<1 | 2>
  migrateProfileVersion(): Promise<2>
}

function supportsProfileVersion(remote: Remote): remote is Remote & ProfileVersionRemote {
  const candidate = remote as Partial<ProfileVersionRemote>
  return (
    typeof candidate.getProfileVersion === 'function' &&
    typeof candidate.migrateProfileVersion === 'function'
  )
}

/** Upgrades a legacy account before any v2 profile or vault write. */
export async function ensureProfileV2(remote: Remote): Promise<void> {
  if (!supportsProfileVersion(remote)) return
  if ((await remote.getProfileVersion()) === 1) await remote.migrateProfileVersion()
}
