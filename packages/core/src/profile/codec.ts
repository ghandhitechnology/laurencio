import { BlobId, DeviceId, RevisionId, type StoreId, SurfaceId } from '@laurencio/protocol'
import { open, type SealedBlob, seal } from '../crypto/aead'
import type { KeyMaterial } from '../crypto/kdf'
import { MAX_MANIFEST_BYTES, parseManifest } from '../remote/types'
import {
  DEFAULT_PROFILE_ID,
  isTokenizedCredentialPath,
  type PortableProfile,
  type ProfileSettings,
  type ToolLockEntry,
  type VaultReference,
} from './model'
import { terminalSemanticIssue } from './semantics'

const MAX_PROFILE_BYTES = MAX_MANIFEST_BYTES + 8 * 1024 * 1024
const MAX_TOOLS = 2048
const MAX_VAULT_REFERENCES = 4096

export interface ProfileContext {
  storeId: StoreId
  protocolVersion: number
}

export class ProfileFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileFormatError'
  }
}

export function parsePortableProfile(value: unknown, byteLength?: number): PortableProfile {
  if (byteLength !== undefined && byteLength > MAX_PROFILE_BYTES) {
    throw new ProfileFormatError(`profile exceeds the ${MAX_PROFILE_BYTES} byte limit`)
  }
  const profile = record(value, 'profile')
  exactKeys(profile, ['schemaVersion', 'id', 'manifest', 'shared', 'platforms', 'tools', 'vault'])
  if (profile.schemaVersion !== 2) {
    throw new ProfileFormatError('profile schemaVersion must be 2')
  }
  if (profile.id !== DEFAULT_PROFILE_ID) {
    throw new ProfileFormatError(`profile id must be ${DEFAULT_PROFILE_ID}`)
  }

  const manifestRecord = record(profile.manifest, 'profile manifest')
  exactKeys(manifestRecord, ['revisionId', 'deviceId', 'createdAt', 'entries'])
  parseId(RevisionId, manifestRecord.revisionId, 'profile manifest revisionId')
  parseId(DeviceId, manifestRecord.deviceId, 'profile manifest deviceId')
  isoDate(manifestRecord.createdAt, 'profile manifest createdAt')
  if (!Array.isArray(manifestRecord.entries)) {
    throw new ProfileFormatError('profile manifest entries must be an array')
  }
  for (const [index, entryValue] of manifestRecord.entries.entries()) {
    const entry = record(entryValue, `profile manifest entry ${index}`)
    exactKeys(
      entry,
      ['surfaceId', 'path', 'kind', 'policy', 'hash', 'size', 'mode', 'blob'],
      ['blob'],
    )
    parseId(SurfaceId, entry.surfaceId, `profile manifest entry ${index} surfaceId`)
    text(entry.path, `profile manifest entry ${index} path`)
    const kind = oneOf(entry.kind, ['file', 'tombstone'], `profile manifest entry ${index} kind`)
    oneOf(entry.policy, ['sync', 'opt-in'], `profile manifest entry ${index} policy`)
    if (kind === 'tombstone') {
      if (typeof entry.hash !== 'string') {
        throw new ProfileFormatError(`profile manifest entry ${index} hash must be a string`)
      }
    } else {
      text(entry.hash, `profile manifest entry ${index} hash`)
    }
    integer(entry.size, `profile manifest entry ${index} size`, 0)
    integer(entry.mode, `profile manifest entry ${index} mode`, 0)
    if (entry.blob !== undefined) {
      const blob = record(entry.blob, `profile manifest entry ${index} blob`)
      exactKeys(blob, ['id', 'size'])
      parseId(BlobId, blob.id, `profile manifest entry ${index} blob id`)
      integer(blob.size, `profile manifest entry ${index} blob size`, 0)
    }
  }

  const manifest = parseManifest(manifestRecord)
  const shared = parseSettings(profile.shared, 'profile shared settings')
  const platformsRecord = record(profile.platforms, 'profile platforms')
  exactKeys(platformsRecord, ['darwin', 'win32'], ['darwin', 'win32'])
  const platforms: PortableProfile['platforms'] = {}
  for (const platform of ['darwin', 'win32'] as const) {
    const value = platformsRecord[platform]
    if (value === undefined) continue
    const override = record(value, `profile ${platform} override`)
    exactKeys(override, ['keybindings', 'layout'], ['keybindings', 'layout'])
    const parsedOverride = {
      ...(override.keybindings === undefined
        ? {}
        : { keybindings: stringRecord(override.keybindings, `${platform} keybindings`) }),
      ...(override.layout === undefined
        ? {}
        : { layout: stringRecord(override.layout, `${platform} layout`) }),
    }
    const issue = terminalSemanticIssue(parsedOverride)
    if (issue !== null) throw new ProfileFormatError(issue)
    platforms[platform] = parsedOverride
  }

  if (!Array.isArray(profile.tools)) throw new ProfileFormatError('profile tools must be an array')
  if (profile.tools.length > MAX_TOOLS) throw new ProfileFormatError('profile has too many tools')
  const tools = profile.tools.map(parseTool)

  if (!Array.isArray(profile.vault)) throw new ProfileFormatError('profile vault must be an array')
  if (profile.vault.length > MAX_VAULT_REFERENCES) {
    throw new ProfileFormatError('profile has too many vault references')
  }
  const vault = profile.vault.map(parseVaultReference)

  return { schemaVersion: 2, id: DEFAULT_PROFILE_ID, manifest, shared, platforms, tools, vault }
}

export function sealProfile(
  profile: PortableProfile,
  master: KeyMaterial,
  context: ProfileContext,
): SealedBlob {
  const parsed = parsePortableProfile(profile)
  const plaintext = new TextEncoder().encode(JSON.stringify(parsed))
  try {
    return seal(master, 'profile', plaintext, profileBlobContext(context))
  } finally {
    plaintext.fill(0)
  }
}

export function openProfile(
  master: KeyMaterial,
  framed: Uint8Array,
  context: ProfileContext,
): PortableProfile {
  const plaintext = open(master, 'profile', framed, profileBlobContext(context))
  try {
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder().decode(plaintext))
    } catch {
      throw new ProfileFormatError('profile plaintext is not valid JSON')
    }
    return parsePortableProfile(value, plaintext.length)
  } finally {
    plaintext.fill(0)
  }
}

function profileBlobContext(context: ProfileContext) {
  return { ...context, blobType: 'profile' as const }
}

function parseSettings(value: unknown, label: string): ProfileSettings {
  const settings = record(value, label)
  exactKeys(settings, ['keybindings', 'layout'])
  const parsed = {
    keybindings: stringRecord(settings.keybindings, `${label} keybindings`),
    layout: stringRecord(settings.layout, `${label} layout`),
  }
  const issue = terminalSemanticIssue(parsed)
  if (issue !== null) throw new ProfileFormatError(issue)
  return parsed
}

function parseTool(value: unknown, index: number): ToolLockEntry {
  const tool = record(value, `profile tool ${index}`)
  exactKeys(tool, ['name', 'platform', 'arch', 'version', 'url', 'sha256'])
  const name = text(tool.name, `profile tool ${index} name`)
  const platform = oneOf(
    tool.platform,
    ['darwin', 'win32'] as const,
    `profile tool ${index} platform`,
  )
  const arch = text(tool.arch, `profile tool ${index} arch`)
  const version = text(tool.version, `profile tool ${index} version`)
  if (version === 'latest') throw new ProfileFormatError(`profile tool ${index} is not pinned`)
  const url = text(tool.url, `profile tool ${index} url`)
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw new ProfileFormatError(`profile tool ${index} url is invalid`)
  }
  if (parsedUrl.protocol !== 'https:') {
    throw new ProfileFormatError(`profile tool ${index} url must use HTTPS`)
  }
  const sha256 = text(tool.sha256, `profile tool ${index} sha256`)
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new ProfileFormatError(`profile tool ${index} sha256 is invalid`)
  }
  return { name, platform, arch, version, url, sha256 }
}

function parseVaultReference(value: unknown, index: number): VaultReference {
  const reference = record(value, `profile vault reference ${index}`)
  const kind = oneOf(
    reference.kind,
    ['agent-auth', 'mcp-secret'] as const,
    `profile vault reference ${index} kind`,
  )
  const base = {
    name: text(reference.name, `profile vault reference ${index} name`),
    harness: oneOf(
      reference.harness,
      ['claude', 'codex', 'opencode'] as const,
      `profile vault reference ${index} harness`,
    ),
    vault: text(reference.vault, `profile vault reference ${index} vault`),
    item: text(reference.item, `profile vault reference ${index} item`),
    field: text(reference.field, `profile vault reference ${index} field`),
  }
  if (kind === 'agent-auth') {
    exactKeys(reference, ['kind', 'name', 'harness', 'vault', 'item', 'field', 'path'])
    const credentialPath = text(reference.path, `profile vault reference ${index} path`)
    if (!isTokenizedCredentialPath(credentialPath)) {
      throw new ProfileFormatError(
        `profile vault reference ${index} path must stay under a portable root`,
      )
    }
    return {
      kind,
      ...base,
      path: credentialPath,
    }
  }
  exactKeys(reference, ['kind', 'name', 'harness', 'vault', 'item', 'field', 'server', 'env'])
  return {
    kind,
    ...base,
    server: text(reference.server, `profile vault reference ${index} server`),
    env: text(reference.env, `profile vault reference ${index} env`),
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ProfileFormatError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowedSet = new Set(allowed)
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key))
  if (unexpected !== undefined)
    throw new ProfileFormatError(`unexpected profile field: ${unexpected}`)
  const optionalSet = new Set(optional)
  const missing = allowed.find((key) => !optionalSet.has(key) && !Object.hasOwn(value, key))
  if (missing !== undefined) throw new ProfileFormatError(`missing profile field: ${missing}`)
}

function stringRecord(value: unknown, label: string): Record<string, string> {
  const input = record(value, label)
  const entries: [string, string][] = []
  for (const [key, entry] of Object.entries(input)) {
    if (key.length === 0 || typeof entry !== 'string') {
      throw new ProfileFormatError(`${label} must contain string values under non-empty keys`)
    }
    entries.push([key, entry])
  }
  return Object.fromEntries(entries)
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ProfileFormatError(`${label} must be a non-empty string`)
  }
  return value
}

function integer(value: unknown, label: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ProfileFormatError(`${label} must be an integer of at least ${minimum}`)
  }
  return value
}

function isoDate(value: unknown, label: string): string {
  const textValue = text(value, label)
  const date = new Date(textValue)
  if (Number.isNaN(date.valueOf()) || date.toISOString() !== textValue) {
    throw new ProfileFormatError(`${label} must be an ISO timestamp`)
  }
  return textValue
}

function oneOf<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new ProfileFormatError(`${label} is invalid`)
  }
  return value as T
}

function parseId<T>(
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  value: unknown,
  label: string,
): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new ProfileFormatError(`${label} is invalid`)
  return result.data as T
}
