import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import pm from 'picomatch'
import { createAdapterRegistry } from './adapters/registry'
import type { LayoutEntry, LocalLayout, Manifest, ManifestEntry } from './model'
import { type OwnershipRef, type ResolvedSurface, resolveOwnership } from './ownership'
import { joinStorePath } from './paths'
import type { AdapterContext, HarnessAdapter, HarnessId, Policy, Surface } from './types'

export type EntryClass =
  | 'sync'
  | 'opt-in'
  | 'never'
  | 'excluded'
  | 'link'
  | 'nested'
  | 'unreadable'
  | 'unsupported'

export type EntryKind = 'file' | 'dir' | 'symlink' | 'other'

export interface ScannedEntry {
  surfaceId: SurfaceId
  /** Absolute local path, physical when the surface root links elsewhere. */
  localPath: string
  /** Tokenized path inside the surface namespace; null when the entry never uploads. */
  storePath: string | null
  kind: EntryKind
  classification: EntryClass
  size: number
  mode: number
  hash: string | null
  /** Raw readlink value for symlinks. */
  linkTarget: string | null
  resolvedLinkTarget: string | null
  /** Set when a link resolves inside another declared surface. */
  linkedSurfaceId: SurfaceId | null
}

export interface SurfaceReport {
  surfaceId: SurfaceId
  harness: HarnessId
  displayName: string
  kind: Surface['kind']
  policy: Policy
  declaredPath: string
  resolvedPath: string
  exists: boolean
  role: 'owner' | 'reference'
  owner: SurfaceId
  linkedBy: SurfaceId[]
  files: number
  bytes: number
  links: number
  excluded: number
  nested: number
  errors: number
  unsupported: number
}

export interface ScanResult {
  home: string
  platform: AdapterContext['platform']
  manifest: Manifest
  layout: LocalLayout
  ownership: OwnershipRef[]
  surfaces: SurfaceReport[]
  entries: ScannedEntry[]
}

export interface ScanOptions {
  adapters: readonly HarnessAdapter[]
  ctx: AdapterContext
  deviceId: DeviceId
  revisionId: RevisionId
  /** Passed in so two scans of one home compare byte for byte. */
  createdAt: string
}

interface Counters {
  files: number
  bytes: number
  links: number
  excluded: number
  nested: number
  errors: number
  unsupported: number
}

interface OwnerRoot {
  surfaceId: SurfaceId
  resolvedPath: string
}

interface PolicyMatcher {
  matches: (candidate: string) => boolean
  policy: Policy
}

interface ScanState {
  manifest: ManifestEntry[]
  layout: Map<string, LayoutEntry>
  entries: ScannedEntry[]
  ownerRoots: OwnerRoot[]
  boundary: Set<string>
  matchers: Map<SurfaceId, ((candidate: string) => boolean)[]>
  filePolicyMatchers: Map<SurfaceId, PolicyMatcher[]>
}

interface WalkTarget {
  surface: Surface
  surfaceId: SurfaceId
  /** Absolute declared root, used to place layout entries in declared space. */
  declaredRoot: string
  counters: Counters
}

function newCounters(): Counters {
  return { files: 0, bytes: 0, links: 0, excluded: 0, nested: 0, errors: 0, unsupported: 0 }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function tryRealpath(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

function baseEntry(target: WalkTarget, localPath: string): ScannedEntry {
  return {
    surfaceId: target.surfaceId,
    localPath,
    storePath: null,
    kind: 'other',
    classification: 'unsupported',
    size: 0,
    mode: 0,
    hash: null,
    linkTarget: null,
    resolvedLinkTarget: null,
    linkedSurfaceId: null,
  }
}

function isExcluded(state: ScanState, surface: Surface, relPosix: string): boolean {
  if (surface.kind !== 'tree' || surface.exclude.length === 0) return false
  let matchers = state.matchers.get(surface.id)
  if (matchers === undefined) {
    matchers = surface.exclude.map((pattern) => pm(pattern, { dot: true }))
    state.matchers.set(surface.id, matchers)
  }
  return matchers.some((matches) => matches(relPosix))
}

/** The policy for one walked file, applying `filePolicy` overrides in declared order. */
function effectivePolicy(state: ScanState, surface: Surface, relPosix: string): Policy {
  if (surface.kind !== 'tree') return surface.policy
  const overrides = surface.filePolicy
  if (overrides === undefined || overrides.length === 0) return surface.policy
  let matchers = state.filePolicyMatchers.get(surface.id)
  if (matchers === undefined) {
    matchers = overrides.map((override) => ({
      matches: pm(override.pattern, { dot: true }),
      policy: override.policy,
    }))
    state.filePolicyMatchers.set(surface.id, matchers)
  }
  for (const matcher of matchers) {
    if (matcher.matches(relPosix)) return matcher.policy
  }
  return surface.policy
}

/** The most specific declared surface a link target lands in, if any. */
function findOwnerRoot(state: ScanState, targetPath: string): SurfaceId | null {
  let best: OwnerRoot | null = null
  for (const root of state.ownerRoots) {
    if (root.resolvedPath === targetPath) return root.surfaceId
    if (!targetPath.startsWith(root.resolvedPath + path.sep)) continue
    if (best === null || root.resolvedPath.length > best.resolvedPath.length) best = root
  }
  return best === null ? null : best.surfaceId
}

function recordRootLayout(state: ScanState, resolved: ResolvedSurface): void {
  if (resolved.declaredPath === resolved.resolvedPath) return
  let linkTarget: string
  try {
    linkTarget = fs.readlinkSync(resolved.declaredPath)
  } catch {
    return
  }
  state.layout.set(resolved.declaredPath, {
    path: resolved.declaredPath,
    mode: 'symlink',
    linkTarget,
  })
}

function recordFile(
  state: ScanState,
  target: WalkTarget,
  localPath: string,
  relPosix: string,
  stat: fs.Stats,
): void {
  const entry = baseEntry(target, localPath)
  entry.kind = 'file'
  entry.size = stat.size
  entry.mode = stat.mode & 0o777
  const policy = effectivePolicy(state, target.surface, relPosix)
  if (policy === 'never') {
    entry.classification = 'never'
    state.entries.push(entry)
    return
  }
  const storePath = joinStorePath(target.surface.path, relPosix)
  let data: Buffer
  try {
    data = fs.readFileSync(localPath)
  } catch {
    entry.classification = 'unreadable'
    target.counters.errors += 1
    state.entries.push(entry)
    return
  }
  entry.storePath = storePath
  entry.hash = sha256Hex(data)
  // Opt-in surfaces hash like sync surfaces; DevicePolicy filters them when a plan is built.
  entry.classification = policy === 'opt-in' ? 'opt-in' : 'sync'
  target.counters.files += 1
  target.counters.bytes += stat.size
  state.manifest.push({
    surfaceId: target.surfaceId,
    path: storePath,
    kind: 'file',
    hash: entry.hash,
    size: stat.size,
    mode: entry.mode,
  })
  state.entries.push(entry)
}

function recordLink(
  state: ScanState,
  target: WalkTarget,
  localPath: string,
  relPath: string,
  stat: fs.Stats,
): void {
  const entry = baseEntry(target, localPath)
  entry.kind = 'symlink'
  entry.size = stat.size
  entry.mode = stat.mode & 0o777
  let raw: string
  try {
    raw = fs.readlinkSync(localPath)
  } catch {
    entry.classification = 'unreadable'
    target.counters.errors += 1
    state.entries.push(entry)
    return
  }
  const lexical = path.resolve(path.dirname(localPath), raw)
  const resolved = tryRealpath(lexical) ?? lexical
  entry.classification = 'link'
  entry.linkTarget = raw
  entry.resolvedLinkTarget = resolved
  entry.linkedSurfaceId = findOwnerRoot(state, resolved)
  target.counters.links += 1
  const declaredPath = path.join(target.declaredRoot, relPath)
  state.layout.set(declaredPath, { path: declaredPath, mode: 'symlink', linkTarget: raw })
  state.entries.push(entry)
}

function recordSkipped(
  state: ScanState,
  target: WalkTarget,
  localPath: string,
  stat: fs.Stats,
  kind: EntryKind,
  classification: 'excluded' | 'nested',
): void {
  const entry = baseEntry(target, localPath)
  entry.kind = kind
  entry.size = stat.size
  entry.mode = stat.mode & 0o777
  entry.classification = classification
  if (classification === 'excluded') target.counters.excluded += 1
  else target.counters.nested += 1
  state.entries.push(entry)
}

function walkTree(state: ScanState, target: WalkTarget, dir: string, rel: string): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir).sort()
  } catch {
    target.counters.errors += 1
    return
  }
  for (const name of names) {
    const localPath = path.join(dir, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    const relPosix = relPath.split(path.sep).join('/')
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(localPath)
    } catch {
      const entry = baseEntry(target, localPath)
      entry.classification = 'unreadable'
      target.counters.errors += 1
      state.entries.push(entry)
      continue
    }
    if (stat.isSymbolicLink()) {
      recordLink(state, target, localPath, relPath, stat)
      continue
    }
    if (stat.isDirectory() || stat.isFile()) {
      const kind: EntryKind = stat.isDirectory() ? 'dir' : 'file'
      if (isExcluded(state, target.surface, relPosix)) {
        recordSkipped(state, target, localPath, stat, kind, 'excluded')
        continue
      }
      if (state.boundary.has(localPath)) {
        recordSkipped(state, target, localPath, stat, kind, 'nested')
        continue
      }
      if (stat.isDirectory()) walkTree(state, target, localPath, relPath)
      else recordFile(state, target, localPath, relPosix, stat)
      continue
    }
    const entry = baseEntry(target, localPath)
    entry.size = stat.size
    entry.mode = stat.mode & 0o777
    target.counters.unsupported += 1
    state.entries.push(entry)
  }
}

function scanSurface(state: ScanState, resolved: ResolvedSurface, counters: Counters): void {
  const surface = resolved.registered.surface
  recordRootLayout(state, resolved)
  if (!resolved.exists || resolved.role === 'reference') return
  const target: WalkTarget = {
    surface,
    surfaceId: surface.id,
    declaredRoot: resolved.declaredPath,
    counters,
  }
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(resolved.resolvedPath)
  } catch {
    counters.errors += 1
    return
  }
  if (surface.kind !== 'tree') {
    if (stat.isFile()) recordFile(state, target, resolved.resolvedPath, '', stat)
    else counters.unsupported += 1
    return
  }
  if (stat.isDirectory()) walkTree(state, target, resolved.resolvedPath, '')
  else counters.unsupported += 1
}

export function scan(options: ScanOptions): ScanResult {
  const registry = createAdapterRegistry(options.adapters)
  const registered = registry.inventory(options.ctx)
  const ownership = resolveOwnership(registered, options.ctx)

  const state: ScanState = {
    manifest: [],
    layout: new Map(),
    entries: [],
    ownerRoots: ownership.surfaces
      .filter((surface) => surface.role === 'owner')
      .map((surface) => ({
        surfaceId: surface.registered.surface.id,
        resolvedPath: surface.resolvedPath,
      })),
    boundary: new Set(ownership.surfaces.map((surface) => surface.declaredPath)),
    matchers: new Map(),
    filePolicyMatchers: new Map(),
  }

  const surfaces: SurfaceReport[] = []
  for (const resolved of ownership.surfaces) {
    const counters = newCounters()
    scanSurface(state, resolved, counters)
    const surface = resolved.registered.surface
    surfaces.push({
      surfaceId: surface.id,
      harness: surface.harness,
      displayName: resolved.registered.adapter.displayName,
      kind: surface.kind,
      policy: surface.policy,
      declaredPath: resolved.declaredPath,
      resolvedPath: resolved.resolvedPath,
      exists: resolved.exists,
      role: resolved.role,
      owner: resolved.owner,
      linkedBy: [...resolved.linkedBy],
      ...counters,
    })
  }

  const manifestEntries = state.manifest.sort(
    (a, b) => compareStrings(a.surfaceId, b.surfaceId) || compareStrings(a.path, b.path),
  )
  const entries = state.entries.sort(
    (a, b) => compareStrings(a.surfaceId, b.surfaceId) || compareStrings(a.localPath, b.localPath),
  )
  const layoutEntries = [...state.layout.values()].sort((a, b) => compareStrings(a.path, b.path))

  return {
    home: options.ctx.home,
    platform: options.ctx.platform,
    manifest: {
      revisionId: options.revisionId,
      deviceId: options.deviceId,
      createdAt: options.createdAt,
      entries: manifestEntries,
    },
    layout: { deviceId: options.deviceId, entries: layoutEntries },
    ownership: ownership.refs,
    surfaces,
    entries,
  }
}
