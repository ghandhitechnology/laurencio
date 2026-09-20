import type { Manifest } from '../model'
import { DEFAULT_PROFILE_ID, DEFAULT_VAULT_REFERENCES, type PortableProfile } from './model'

export function migrateManifestToProfile(manifest: Manifest): PortableProfile {
  return {
    schemaVersion: 2,
    id: DEFAULT_PROFILE_ID,
    manifest,
    shared: { keybindings: {}, layout: {} },
    platforms: {},
    tools: [],
    vault: DEFAULT_VAULT_REFERENCES.map((reference) => ({ ...reference })),
  }
}
