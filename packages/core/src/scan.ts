import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import pm from 'picomatch'
import { createAdapterRegistry } from './adapters/registry'
import type { LayoutEntry, LocalLayout, Manifest, ManifestEntry } from './model'
import { type OwnershipRef, type ResolvedSurface, resolveOwnership } from './ownership'
import type { TokenEnv } from './paths'
import {
  applyTransforms,
  enforceUploadRules,
  type PathMapping,
  projectEntryPath,
} from './transforms'
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
  /** Directory-level store-to-local mappings for surfaces whose transforms re-key paths. */
  pathMap: PathMapping[]
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
  pathMap: Map<string, PathMapping>
  tokenEnv: TokenEnv
}

interface WalkTarget {
  surface: Surface
  surfaceId: SurfaceId
  /** Absolute declared root, used to place layout entries in declared space. */
  declaredRoot: string
  counters: Counters
  /** Realpaths of the directories on the current walk stack; stops link cycles. */
  visiting: Set<string>
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
  let raw: string
  try {
    raw = fs.readFileSync(localPath, 'utf8')
  } catch {
    entry.classification = 'unreadable'
    target.counters.errors += 1
    state.entries.push(entry)
    return
  }
  const projected = projectEntryPath(target.surface, relPosix, localPath, state.tokenEnv)
  let projection: string
  try {
    projection = applyTransforms({
      surface: target.surface,
      storePath: projected.storePath,
      direction: 'toStore',
      tokenEnv: state.tokenEnv,
      content: raw,
    }).content
    // Hashes must cover the bytes an upload would carry, secret indirection included.
    projection = enforceUploadRules(target.surface, projected.storePath, projection).content
  } catch {
    // A file that cannot be projected must not upload raw; the surface report shows it.
    entry.classification = 'unsupported'
    target.counters.unsupported += 1
    state.entries.push(entry)
    return
  }
  if (projected.mapping !== null) {
    state.pathMap.set(projected.mapping.storePrefix, projected.mapping)
  }
  const size = Buffer.byteLength(projection)
  entry.storePath = projected.storePath
  entry.hash = sha256Hex(Buffer.from(projection, 'utf8'))
  entry.size = size
  // Opt-in surfaces hash like sync surfaces; DevicePolicy filters them when a plan is built.
  entry.classification = policy === 'opt-in' ? 'opt-in' : 'sync'
  target.counters.files += 1
  target.counters.bytes += size
  state.manifest.push({
    surfaceId: target.surfaceId,
    path: projected.storePath,
    kind: 'file',
    policy: policy === 'opt-in' ? 'opt-in' : 'sync',
    hash: entry.hash,
    size,
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

/** Links a single path may follow before the walk stops descending. */
const MAX_LINK_DEPTH = 8

/** True when `resolved` is a directory already on the walk stack or encloses one. */
function onWalkStack(target: WalkTarget, resolved: string): boolean {
  for (const real of target.visiting) {
    if (resolved === real || real.startsWith(`${resolved}${path.sep}`)) return true
  }
  return false
}

/**
 * The link entry is already recorded; this records the content behind it under
 * the declared path, so a device without the same links still gets the files.
 * The link path itself is what gets walked, keeping every child in declared
 * space while the filesystem reads through the link.
 */
function followLink(
  state: ScanState,
  target: WalkTarget,
  localPath: string,
  relPath: string,
  relPosix: string,
  linkDepth: number,
): void {
  if (linkDepth >= MAX_LINK_DEPTH) return
  const resolved = tryRealpath(localPath)
  if (resolved === null) return
  if (onWalkStack(target, resolved)) return
  // The link entry already names the owning surface; a walk would duplicate that tree.
  if (state.boundary.has(resolved)) return
  if (isExcluded(state, target.surface, relPosix)) return
  let targetStat: fs.Stats
  try {
    targetStat = fs.statSync(localPath)
  } catch {
    return
  }
  if (targetStat.isDirectory()) {
    target.visiting.add(resolved)
    try {
      walkTree(state, target, localPath, relPath, linkDepth + 1)
    } finally {
      target.visiting.delete(resolved)
    }
  } else if (targetStat.isFile()) {
    recordFile(state, target, localPath, relPosix, targetStat)
  }
}

function walkTree(
  state: ScanState,
  target: WalkTarget,
  dir: string,
  rel: string,
  linkDepth = 0,
): void {
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
      followLink(state, target, localPath, relPath, relPosix, linkDepth)
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
      if (stat.isDirectory()) walkTree(state, target, localPath, relPath, linkDepth)
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
    visiting: new Set([tryRealpath(resolved.resolvedPath) ?? resolved.resolvedPath]),
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
  const ownerSurfaces = ownership.surfaces.filter((surface) => surface.role === 'owner')

  const state: ScanState = {
    manifest: [],
    layout: new Map(),
    entries: [],
    ownerRoots: ownerSurfaces.map((surface) => ({
      surfaceId: surface.registered.surface.id,
      resolvedPath: surface.resolvedPath,
    })),
    // Walks run in physical space, so the boundary that stops a parent tree at a
    // nested surface root uses the resolved owner roots. A reference's resolved
    // root is the owner's own content and must not be skipped.
    boundary: new Set(ownerSurfaces.map((surface) => surface.resolvedPath)),
    matchers: new Map(),
    filePolicyMatchers: new Map(),
    pathMap: new Map(),
    tokenEnv: { home: options.ctx.home, platform: options.ctx.platform, env: options.ctx.env },
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
  const pathMap = [...state.pathMap.values()].sort(
    (a, b) =>
      compareStrings(a.surfaceId, b.surfaceId) || compareStrings(a.storePrefix, b.storePrefix),
  )

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
    pathMap,
  }
}
