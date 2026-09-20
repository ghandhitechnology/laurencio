import type {
  AgentAuthVaultReference,
  McpSecretVaultReference,
  PortableProfile,
  ProfilePlatform,
  ProjectedProfile,
  ToolLockEntry,
  VaultReference,
} from './model'
import { DEFAULT_PROFILE_ID, isTokenizedCredentialPath } from './model'
import { terminalSemanticIssue } from './semantics'

function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function sortedRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => compareText(left, right)),
  )
}

function compareTools(left: ToolLockEntry, right: ToolLockEntry): number {
  return compareText(
    [left.name, left.arch, left.version, left.url, left.sha256].join('\0'),
    [right.name, right.arch, right.version, right.url, right.sha256].join('\0'),
  )
}

function assertPinnedTools(tools: ToolLockEntry[]): void {
  for (const tool of tools) {
    if (tool.platform !== 'darwin' && tool.platform !== 'win32') {
      throw new Error(`tool ${tool.name} has an unsupported platform: ${tool.platform}`)
    }
    if (tool.arch.trim().length === 0) {
      throw new Error(`tool ${tool.name} has an invalid arch`)
    }
    if (tool.version.trim().length === 0 || tool.version === 'latest') {
      throw new Error(`tool ${tool.name} has an unpinned version`)
    }
    try {
      new URL(tool.url)
    } catch {
      throw new Error(`tool ${tool.name} has an invalid url`)
    }
    if (!/^[0-9a-f]{64}$/.test(tool.sha256)) {
      throw new Error(`tool ${tool.name} has an invalid sha256 pin`)
    }
  }
}

function compareVaultReferences(left: VaultReference, right: VaultReference): number {
  return compareText(vaultReferenceKey(left), vaultReferenceKey(right))
}

function vaultReferenceKey(reference: VaultReference): string {
  const target =
    reference.kind === 'agent-auth' ? reference.path : `${reference.server}\0${reference.env}`
  return [
    reference.kind,
    reference.name,
    reference.harness,
    target,
    reference.vault,
    reference.item,
    reference.field,
  ].join('\0')
}

function assertVaultReferences(references: VaultReference[]): void {
  const sharedFields = ['kind', 'name', 'harness', 'vault', 'item', 'field']
  for (const reference of references) {
    const kind: string = reference.kind
    if (kind !== 'agent-auth' && kind !== 'mcp-secret') {
      throw new Error(`unsupported vault reference kind: ${kind}`)
    }
    if (reference.kind === 'agent-auth' && !isTokenizedCredentialPath(reference.path)) {
      throw new Error(`vault reference ${reference.name} has a non-portable credential path`)
    }
    const referenceFields = new Set(
      reference.kind === 'agent-auth'
        ? [...sharedFields, 'path']
        : [...sharedFields, 'server', 'env'],
    )
    const payloadField = Object.keys(reference)
      .sort()
      .find((field) => !referenceFields.has(field))
    if (payloadField !== undefined) {
      throw new Error(
        `vault reference ${reference.name} contains secret payload field: ${payloadField}`,
      )
    }
  }
}

function normalizeVaultReference(reference: VaultReference): VaultReference {
  const shared = {
    name: reference.name,
    harness: reference.harness,
    vault: reference.vault,
    item: reference.item,
    field: reference.field,
  }
  if (reference.kind === 'agent-auth') {
    const normalized: AgentAuthVaultReference = {
      kind: reference.kind,
      ...shared,
      path: reference.path,
    }
    return normalized
  }
  const normalized: McpSecretVaultReference = {
    kind: reference.kind,
    ...shared,
    server: reference.server,
    env: reference.env,
  }
  return normalized
}

export function projectProfile(
  profile: PortableProfile,
  platform: ProfilePlatform,
): ProjectedProfile {
  if (profile.schemaVersion !== 2) {
    throw new Error(`unsupported profile schema: ${profile.schemaVersion}`)
  }
  if (profile.id !== DEFAULT_PROFILE_ID) {
    throw new Error(`unsupported profile id: ${profile.id}`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`unsupported profile platform: ${platform}`)
  }
  assertPinnedTools(profile.tools)
  assertVaultReferences(profile.vault)
  for (const settings of [profile.shared, ...Object.values(profile.platforms)]) {
    if (settings === undefined) continue
    const issue = terminalSemanticIssue(settings)
    if (issue !== null) throw new Error(issue)
  }
  const override = profile.platforms[platform]
  const tools = profile.tools
    .filter((tool) => tool.platform === platform)
    .map((tool) => ({
      name: tool.name,
      platform: tool.platform,
      arch: tool.arch,
      version: tool.version,
      url: tool.url,
      sha256: tool.sha256,
    }))
    .sort(compareTools)
  const vault = profile.vault.map(normalizeVaultReference).sort(compareVaultReferences)
  return {
    profileId: profile.id,
    platform,
    manifest: profile.manifest,
    keybindings: sortedRecord({ ...profile.shared.keybindings, ...override?.keybindings }),
    layout: sortedRecord({ ...profile.shared.layout, ...override?.layout }),
    tools,
    vault,
  }
}
