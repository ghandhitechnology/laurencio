import type { Manifest } from '../model'
import type { HarnessId, Platform } from '../types'

export const DEFAULT_PROFILE_ID = 'default' as const

export type ProfileId = typeof DEFAULT_PROFILE_ID

export type ProfilePlatform = Exclude<Platform, 'linux'>

/** Semantic action and layout names mapped to portable values. */
export interface ProfileSettings {
  keybindings: Record<string, string>
  layout: Record<string, string>
}

export interface PlatformProfileOverride {
  keybindings?: Record<string, string>
  layout?: Record<string, string>
}

export interface ToolLockEntry {
  name: string
  platform: ProfilePlatform
  arch: string
  version: string
  url: string
  sha256: string
}

interface VaultReferenceBase {
  name: string
  harness: HarnessId
  vault: string
  item: string
  field: string
}

/** A vault field materialized as a harness-native authentication file. */
export interface AgentAuthVaultReference extends VaultReferenceBase {
  kind: 'agent-auth'
  /** Tokenized harness path, never an absolute machine path. */
  path: string
}

/** A vault field explicitly referenced by an MCP server through an environment variable. */
export interface McpSecretVaultReference extends VaultReferenceBase {
  kind: 'mcp-secret'
  server: string
  env: string
}

/** An address into an external vault. Secret material is never part of a profile. */
export type VaultReference = AgentAuthVaultReference | McpSecretVaultReference

const braced = (name: string): string => `\${${name}}`

const CREDENTIAL_PATH_ROOTS = [
  braced('XDG_CONFIG_HOME'),
  braced('CODEX_HOME'),
  braced('CLAUDE_CONFIG_DIR'),
  '$HOME',
  '%APPDATA%',
] as const

/** Credential targets must remain underneath a portable, client-controlled root. */
export function isTokenizedCredentialPath(value: string): boolean {
  const root = CREDENTIAL_PATH_ROOTS.find(
    (candidate) => value === candidate || value.startsWith(`${candidate}/`),
  )
  if (root === undefined || value.includes('\\') || value.includes('\0')) return false
  const relative = value.slice(root.length).replace(/^\//, '')
  return (
    relative === '' ||
    relative.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..')
  )
}

/** Native login files captured by a newly migrated workbench profile. */
export const DEFAULT_VAULT_REFERENCES: readonly AgentAuthVaultReference[] = [
  {
    kind: 'agent-auth',
    name: 'claude-login',
    harness: 'claude',
    vault: 'laurencio',
    item: 'claude-login',
    field: 'value',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded when materializing the profile.
    path: '${CLAUDE_CONFIG_DIR}/.credentials.json',
  },
  {
    kind: 'agent-auth',
    name: 'codex-login',
    harness: 'codex',
    vault: 'laurencio',
    item: 'codex-login',
    field: 'value',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: expanded when materializing the profile.
    path: '${CODEX_HOME}/auth.json',
  },
  {
    kind: 'agent-auth',
    name: 'opencode-login',
    harness: 'opencode',
    vault: 'laurencio',
    item: 'opencode-login',
    field: 'value',
    path: '$HOME/.local/share/opencode/auth.json',
  },
]

export interface PortableProfile {
  schemaVersion: 2
  id: ProfileId
  /** Manifest captured on a full-device update; current files use the revision head. */
  manifest: Manifest
  shared: ProfileSettings
  platforms: Partial<Record<ProfilePlatform, PlatformProfileOverride>>
  tools: ToolLockEntry[]
  vault: VaultReference[]
}

export interface ProjectedProfile extends ProfileSettings {
  profileId: ProfileId
  platform: ProfilePlatform
  manifest: Manifest
  tools: ToolLockEntry[]
  vault: VaultReference[]
}
