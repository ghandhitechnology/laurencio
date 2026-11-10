import type { Manifest } from '../model'
import { DEFAULT_PROFILE_ID, type PortableProfile } from './model'

export function migrateManifestToProfile(manifest: Manifest): PortableProfile {
  return {
    schemaVersion: 2,
    id: DEFAULT_PROFILE_ID,
    manifest,
    shared: { keybindings: {}, layout: {} },
    platforms: {},
    tools: [],
    vault: [],
  }
}
