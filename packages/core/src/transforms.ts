/**
 * The projection pipeline. Every file crosses it twice: `toStore` before it is hashed or
 * uploaded, `fromStore` before stored content reaches a disk. A surface's declared
 * transforms decide both directions, and an unknown or unimplemented kind fails loudly
 * rather than passing raw content through.
 *
 * Content transforms are pure over the text they receive. Apply-side transforms that must
 * put content back into machine state (Codex machine keys, `~/.claude.json` identity) get
 * the current local file through `localContent`; marker re-insertion gets device-local
 * blocks through `localBlocks`.
 */

import path from 'node:path'
import type { SurfaceId } from '@laurencio/protocol'
import pm from 'picomatch'
import { stringify as stringifyToml } from 'smol-toml'
import {
  claudeMcpExtract,
  claudeMemoryRekey,
  claudePluginRecords,
  expandPathsInText,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  tokenizePathsInText,
} from './adapters/claude/transforms'
import {
  codexAutomationApply,
  codexAutomationSplit,
  codexTomlApply,
  codexTomlSplit,
} from './adapters/codex/transforms'
import { opencodeSchemaNormalize } from './adapters/opencode/transforms'
import { type LocalBlock, reinsertLocalBlocks, stripLocalBlocks } from './markers'
import { joinStorePath, type TokenEnv } from './paths'
import { type MovedSecret, rewriteEnv } from './secrets/placeholders'
import { scanFiles } from './secrets/scan'
import type { HarnessId, Surface, TransformKind } from './types'

export class TransformError extends Error {
  readonly kind: string
  readonly direction: string

  constructor(kind: string, direction: string, message: string) {
    super(`transform ${kind} (${direction}): ${message}`)
    this.name = 'TransformError'
    this.kind = kind
    this.direction = direction
  }
}

export type TransformDirection = 'toStore' | 'fromStore'

export interface TransformContext {
  surface: Surface
  /** Store path of the entry after path projection. */
  storePath: string
  direction: TransformDirection
  tokenEnv: TokenEnv
  content: string
  /** Current on-disk content for apply-side merges into machine state. */
  localContent?: string | null
  /** Device-local marker blocks for `markerBlocks` re-insertion. */
  localBlocks?: readonly LocalBlock[]
  /** Restrict which declared transforms run, for merge paths that handle markers themselves. */
  kinds?: readonly TransformKind[]
}

export interface TransformOutcome {
  content: string
  /** Secret values pulled out of the projection for the device store. */
  moved: MovedSecret[]
  /** Diagnostics from transforms that report them. */
  notes: string[]
}

function parseJson(text: string, kind: TransformKind, direction: TransformDirection): JsonValue {
  try {
    return JSON.parse(text) as JsonValue
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new TransformError(kind, direction, `not valid JSON: ${reason}`)
  }
}

function serializeJson(value: JsonValue): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Merge a stored MCP projection back into the local `~/.claude.json`, keeping its identity. */
function applyMcpExtract(content: string, localContent: string | null): string {
  const remote = parseJson(content, 'claudeMcpExtract', 'fromStore')
  const remoteServers =
    isJsonObject(remote) && isJsonObject(remote.mcpServers) ? remote.mcpServers : {}
  const local =
    localContent === null || localContent.trim() === ''
      ? {}
      : parseJson(localContent, 'claudeMcpExtract', 'fromStore')
  if (!isJsonObject(local)) {
    throw new TransformError('claudeMcpExtract', 'fromStore', 'local file is not a JSON object')
  }
  return serializeJson({ ...local, mcpServers: remoteServers })
}

function transformContent(kind: TransformKind, context: TransformContext, notes: string[]): string {
  const { content, direction, tokenEnv } = context
  const local = context.localContent ?? null
  switch (kind) {
    case 'pathTokenize':
      return direction === 'toStore'
        ? tokenizePathsInText(content, tokenEnv).text
        : expandPathsInText(content, tokenEnv).text
    // Path-level transform: `projectEntryPath` re-keys the slug, the bytes are unchanged.
    case 'claudeSlugRekey':
      return content
    case 'claudeMcpExtract':
      if (direction === 'toStore') {
        const parsed = parseJson(content, kind, direction)
        return serializeJson(claudeMcpExtract(parsed).value)
      }
      return applyMcpExtract(content, local)
    // Install records are derived metadata; the stored projection already carries no
    // machine paths, so applying it verbatim is the projection, not a raw pass-through.
    case 'claudePluginRecords':
      if (direction === 'toStore') {
        return serializeJson(claudePluginRecords(parseJson(content, kind, direction)).value)
      }
      return content
    case 'codexTomlSplit':
      if (direction === 'toStore') return stringifyToml(codexTomlSplit(content).portable)
      return codexTomlApply(local, content)
    case 'codexAutomationSplit':
      if (direction === 'toStore') return stringifyToml(codexAutomationSplit(content).definition)
      return codexAutomationApply(local, content)
    case 'opencodeSchemaNormalize': {
      const result = opencodeSchemaNormalize(content, direction === 'toStore' ? 'upload' : 'apply')
      for (const note of result.notes) notes.push(`${note.kind}:${note.key}:${note.detail}`)
      return result.text
    }
    case 'markerBlocks':
      if (direction === 'toStore') return stripLocalBlocks(context.storePath, content)
      return reinsertLocalBlocks(content, context.localBlocks ?? [])
    default:
      throw new TransformError(String(kind), direction, 'not implemented')
  }
}

/** Run every declared transform for one direction, in declaration order. */
export function applyTransforms(context: TransformContext): TransformOutcome {
  const kinds = context.kinds ?? context.surface.transforms.map((spec) => spec.kind)
  const moved: MovedSecret[] = []
  const notes: string[] = []
  let content = context.content
  for (const kind of kinds) {
    content = transformContent(kind, { ...context, content }, notes)
  }
  return { content, moved, notes }
}

export interface UploadRulesOutcome {
  content: string
  moved: MovedSecret[]
  /** Blocking reason, or null when the projection may upload. */
  blocked: string | null
}

function fileScope(storePath: string): string {
  return path.posix.basename(storePath).replace(/\.[^.]+$/, '')
}

/** JSON env maps that indirect rules rewrite: the file-level `env` and `mcpServers.<name>.env`. */
function indirectEnvHolders(
  value: JsonValue,
  storePath: string,
): { env: JsonObject; scope: string }[] {
  if (!isJsonObject(value)) return []
  const holders: { env: JsonObject; scope: string }[] = []
  if (isJsonObject(value.env)) holders.push({ env: value.env, scope: fileScope(storePath) })
  if (isJsonObject(value.mcpServers)) {
    for (const [name, server] of Object.entries(value.mcpServers)) {
      if (isJsonObject(server) && isJsonObject(server.env)) {
        holders.push({ env: server.env, scope: name })
      }
    }
  }
  return holders
}

function rewriteIndirectEnv(
  harness: HarnessId,
  storePath: string,
  content: string,
): { content: string; moved: MovedSecret[] } {
  let value: JsonValue
  try {
    value = JSON.parse(content) as JsonValue
  } catch {
    // A non-JSON file has no env map to rewrite; the scanner still guards it.
    return { content, moved: [] }
  }
  const moved: MovedSecret[] = []
  for (const holder of indirectEnvHolders(value, storePath)) {
    const values: Record<string, string> = {}
    for (const [key, entry] of Object.entries(holder.env)) {
      if (typeof entry === 'string') values[key] = entry
    }
    const result = rewriteEnv(harness, { path: storePath, scope: holder.scope }, values)
    for (const [key, rewritten] of Object.entries(result.values)) holder.env[key] = rewritten
    moved.push(...result.moved)
  }
  return { content: isJsonObject(value) ? serializeJson(value) : content, moved }
}

/**
 * Fail-closed upload policy: denied paths never leave, indirect rules rewrite env values
 * through the placeholder module, and the secret scanner sees the rewritten projection.
 * Moved values need a device secret store, so until one exists they block the file.
 */
export function enforceUploadRules(
  surface: Surface,
  storePath: string,
  content: string,
): UploadRulesOutcome {
  for (const rule of surface.secretRules) {
    if (rule.kind !== 'deny') continue
    for (const pattern of rule.patterns ?? []) {
      const matches = pm(pattern)
      if (matches(storePath) || matches(path.posix.basename(storePath))) {
        return { content, moved: [], blocked: `denied by secret rule ${pattern}` }
      }
    }
  }

  let projection = content
  const moved: MovedSecret[] = []
  if (surface.secretRules.some((rule) => rule.kind === 'indirect')) {
    const result = rewriteIndirectEnv(surface.harness, storePath, projection)
    projection = result.content
    moved.push(...result.moved)
  }

  const scan = scanFiles([{ path: storePath, content: projection }])
  if (!scan.clean) {
    const rules = [...new Set(scan.findings.map((finding) => finding.rule))].sort()
    return { content: projection, moved, blocked: `secret scan: ${rules.join(', ')}` }
  }
  if (moved.length > 0) {
    return { content: projection, moved, blocked: 'secret needs a device secret store' }
  }
  return { content: projection, moved, blocked: null }
}

export interface PathMapping {
  surfaceId: SurfaceId
  /** Store prefix the path transform maps to. */
  storePrefix: string
  /** Absolute local prefix it came from. */
  localPrefix: string
}

export interface ProjectedPath {
  storePath: string
  /** Directory mapping when a path transform re-keyed the entry; null otherwise. */
  mapping: PathMapping | null
}

/** Claude memory re-key: `projects/<slug>/memory/...` becomes `projects/memory/<identity>/...`. */
function memoryProjection(
  surface: Surface,
  relativePosix: string,
  localPath: string,
  tokenEnv: TokenEnv,
): ProjectedPath {
  const parts = relativePosix.split('/')
  const slug = parts[0]
  const rest = parts.slice(2)
  if (slug === undefined || parts[1] !== 'memory') {
    return { storePath: joinStorePath(surface.path, relativePosix), mapping: null }
  }
  const identityKey = claudeMemoryRekey(slug, tokenEnv.home).storePrefix.slice('memory/'.length)
  const storePath = joinStorePath(surface.path, ['memory', identityKey, ...rest].join('/'))
  let localPrefix = localPath
  for (let index = 0; index < rest.length; index += 1) localPrefix = path.dirname(localPrefix)
  return {
    storePath,
    mapping: {
      surfaceId: surface.id,
      storePrefix: joinStorePath(surface.path, `memory/${identityKey}`),
      localPrefix,
    },
  }
}

/** Store path for one walked entry, applying path-level transforms. */
export function projectEntryPath(
  surface: Surface,
  relativePosix: string,
  localPath: string,
  tokenEnv: TokenEnv,
): ProjectedPath {
  if (surface.transforms.some((spec) => spec.kind === 'claudeSlugRekey')) {
    return memoryProjection(surface, relativePosix, localPath, tokenEnv)
  }
  return { storePath: joinStorePath(surface.path, relativePosix), mapping: null }
}

/** Resolve a store path back to this machine through a directory mapping. */
export function localPathForMapping(mapping: PathMapping, storePath: string): string | null {
  if (storePath === mapping.storePrefix) return mapping.localPrefix
  if (!storePath.startsWith(`${mapping.storePrefix}/`)) return null
  const rest = storePath.slice(mapping.storePrefix.length + 1).split('/')
  return path.join(mapping.localPrefix, ...rest)
}
