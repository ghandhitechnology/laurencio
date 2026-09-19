import { type Manifest, type ManifestEntry, unifiedDiff } from '@laurencio/core'
import { loadCliConfig } from '../config'
import type { CommandContext } from '../context'
import { localPathForStorePath, readLocalFile, selectorMatches } from '../layout'
import { ok } from '../result'
import {
  type CliSession,
  identityFor,
  loadRemoteManifest,
  openSession,
  openState,
  readRemoteBlob,
  scanInventory,
} from '../session'
import { displayPath, plural } from '../ui'
import type { CommandSpec } from './command'

export interface DiffSide {
  exists: boolean
  size: number
  hash: string | null
}

export interface DiffEntry {
  storePath: string
  surfaceId: string | null
  status: string
  local: DiffSide
  remote: DiffSide
  base: DiffSide
  localDiff: string
  remoteDiff: string
  binary: boolean
}

export interface DiffData {
  remoteAvailable: boolean
  selector: string | null
  entries: DiffEntry[]
  truncated: number
}

const MAX_ENTRIES = 50

function sideOf(entry: ManifestEntry | null): DiffSide {
  if (entry === null || entry.kind === 'tombstone') return { exists: false, size: 0, hash: null }
  return { exists: true, size: entry.size, hash: entry.hash }
}

function isBinary(text: string): boolean {
  return text.includes('\u0000')
}

function classify(local: DiffSide, remote: DiffSide, base: DiffSide): string {
  if (!local.exists && !remote.exists) return 'deleted'
  if (local.exists && !remote.exists) return base.exists ? 'deleted-remote' : 'local-only'
  if (!local.exists && remote.exists) return base.exists ? 'deleted-local' : 'remote-only'
  if (local.hash === remote.hash) return 'unchanged'
  if (!base.exists) return 'both-added'
  if (local.hash === base.hash) return 'remote-changed'
  if (remote.hash === base.hash) return 'local-changed'
  return 'conflict'
}

async function textForBlob(
  session: CliSession | null,
  entry: ManifestEntry | null,
  cache: Map<string, string>,
): Promise<string> {
  if (
    session === null ||
    entry === null ||
    entry.kind === 'tombstone' ||
    entry.blob === undefined
  ) {
    return ''
  }
  const cached = cache.get(entry.blob.id)
  if (cached !== undefined) return cached
  const text = await readRemoteBlob(session, entry.blob.id)
  cache.set(entry.blob.id, text)
  return text
}

function entryMap(manifest: Manifest | null): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>()
  for (const entry of manifest?.entries ?? []) map.set(entry.path, entry)
  return map
}

function renderEntry(ctx: CommandContext, entry: DiffEntry): string {
  const lines: string[] = [`${displayPath(ctx.home, entry.storePath)}  ${entry.status}`]
  if (entry.binary) {
    lines.push(
      `  binary: local ${entry.local.exists ? entry.local.size : 'absent'}, remote ${entry.remote.exists ? entry.remote.size : 'absent'}`,
    )
    return lines.join('\n')
  }
  if (entry.localDiff !== '') lines.push(entry.localDiff.trimEnd())
  if (entry.remoteDiff !== '') lines.push(entry.remoteDiff.trimEnd())
  if (entry.localDiff === '' && entry.remoteDiff === '') lines.push('  no differences')
  return lines.join('\n')
}

function matchesSelector(
  selector: string | null,
  storePath: string,
  inventory: ReturnType<typeof scanInventory>,
  ctx: CommandContext,
): boolean {
  if (selector === null || selector === '') return true
  if (inventory.surfaces.has(selector)) {
    return (inventory.byStorePath.get(storePath)?.surfaceId ?? '') === selector
  }
  if (selector.startsWith('/') || selector.startsWith('~')) {
    const expanded = selector.startsWith('~') ? `${ctx.home}${selector.slice(1)}` : selector
    const localPath = localPathForStorePath(
      inventory.surfaces,
      inventory.byStorePath,
      ctx,
      storePath,
    )
    if (localPath === null) return false
    return localPath === expanded || localPath.startsWith(`${expanded}/`)
  }
  if (selectorMatches(selector, storePath)) return true
  return storePath.includes(selector)
}

export const diffCommand: CommandSpec = {
  name: 'diff',
  summary: 'Compare local, remote, and base versions of a path',
  usage: 'laurencio diff [surface|path] [--harness <id>] [--json]',
  async run(ctx) {
    const selector = ctx.flags.surface ?? ctx.positionals[0] ?? null
    const config = loadCliConfig(ctx.home)
    const identity = identityFor(ctx)
    const inventory = scanInventory(ctx, { policy: config.policy })

    const state = openState(ctx)
    try {
      const baseId = state.getBaseRevision()
      const baseManifest = baseId === null ? null : state.getManifest(baseId)
      let session: CliSession | null = null
      let remoteManifest: Manifest | null = null
      let remoteAvailable = false
      if (identity !== null) {
        try {
          session = await openSession(ctx)
          const view = await loadRemoteManifest(session, baseId)
          remoteManifest = view.manifest ?? baseManifest
          remoteAvailable = true
        } catch {
          remoteAvailable = false
        }
      }

      const baseByPath = entryMap(baseManifest)
      const remoteByPath = entryMap(remoteAvailable ? remoteManifest : null)
      const paths = new Set<string>([...baseByPath.keys(), ...remoteByPath.keys()])
      for (const entry of inventory.scan.entries) {
        if (entry.storePath !== null && entry.kind === 'file') paths.add(entry.storePath)
      }

      const blobCache = new Map<string, string>()
      const entries: DiffEntry[] = []
      for (const storePath of [...paths].sort()) {
        if (!matchesSelector(selector, storePath, inventory, ctx)) continue
        const scanned = inventory.byStorePath.get(storePath)
        const localFile = readLocalFile(inventory.surfaces, inventory.byStorePath, ctx, storePath)
        const localSize =
          localFile !== null && localFile.content !== null
            ? Buffer.byteLength(localFile.content)
            : 0
        const localSide: DiffSide = localFile?.exists
          ? { exists: true, size: localSize, hash: localFile.hash }
          : { exists: false, size: 0, hash: null }
        const remoteEntry = remoteByPath.get(storePath) ?? null
        const baseEntry = baseByPath.get(storePath) ?? null
        const remoteSide = sideOf(remoteEntry)
        const baseSide = sideOf(baseEntry)
        const localText = localFile?.content ?? ''
        const remoteText = await textForBlob(session, remoteEntry, blobCache)
        const baseText = await textForBlob(session, baseEntry, blobCache)
        const binary = isBinary(localText) || isBinary(remoteText) || isBinary(baseText)
        entries.push({
          storePath,
          surfaceId: scanned?.surfaceId ?? null,
          status: classify(localSide, remoteSide, baseSide),
          local: localSide,
          remote: remoteSide,
          base: baseSide,
          localDiff: binary ? '' : unifiedDiff(baseText, localText, { from: 'base', to: 'local' }),
          remoteDiff: binary
            ? ''
            : unifiedDiff(baseText, remoteText, { from: 'base', to: 'remote' }),
          binary,
        })
      }

      const truncated = Math.max(0, entries.length - MAX_ENTRIES)
      const shown = entries.slice(0, MAX_ENTRIES)
      const data: DiffData = { remoteAvailable, selector, entries: shown, truncated }
      const human = (): string => {
        const lines: string[] = []
        if (!remoteAvailable) {
          lines.push('Remote is not reachable; showing local against the last synced revision.')
        }
        if (shown.length === 0) {
          lines.push('No tracked files matched.')
          return lines.join('\n')
        }
        for (const entry of shown) lines.push(renderEntry(ctx, entry))
        if (truncated > 0) lines.push(`${plural(truncated, 'file')} not shown, narrow the selector`)
        return lines.join('\n')
      }
      const conflicted = shown.some(
        (entry) => entry.status === 'conflict' || entry.status === 'both-added',
      )
      return ok(data, human, conflicted ? 2 : 0)
    } finally {
      state.close()
    }
  },
}
