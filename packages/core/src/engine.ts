/**
 * One sync run: scan the local surfaces, compare against the base revision and
 * the remote head, order the work, apply it through the single writer, and
 * commit a new encrypted revision. The engine never talks to harnesses and
 * never writes files itself: the scanner observes, the applier writes, and the
 * remote stores ciphertext.
 */

import fs from 'node:fs'
import path from 'node:path'
import type {
  BlobRef,
  DeviceId,
  RevisionId,
  RevisionSummary,
  StoreId,
  SurfaceId,
} from '@laurencio/protocol'
import { newId, PROTOCOL_VERSION } from '@laurencio/protocol'
import pm from 'picomatch'
import {
  Applier,
  type ApplyHooks,
  type FileFingerprint,
  hashContent,
  StaleWriteError,
} from './apply'
import { type BlobContext, openText, sealText } from './crypto/aead'
import type { KeyMaterial } from './crypto/kdf'
import { parseLocalBlocks, reinsertLocalBlocks } from './markers'
import { merge } from './merge'
import {
  ConflictLedger,
  conflictRecord,
  createConflictArtifact,
  isConflictCopyPath,
} from './merge/conflict'
import type {
  ConflictArtifact,
  DevicePolicy,
  LocalLayout,
  Manifest,
  ManifestEntry,
  RevisionMeta,
  SurfaceDigest,
  SyncReport,
} from './model'
import { expand, type TokenEnv } from './paths'
import { QuiescenceGate, type QuiescenceOptions } from './quiescence'
import type { Remote } from './remote/types'
import { parseManifest } from './remote/types'
import { scan } from './scan'
import { acquireLock, releaseLock, type SyncState } from './state'
import {
  applyTransforms,
  enforceUploadRules,
  localPathForMapping,
  type PathMapping,
} from './transforms'
import type { AdapterContext, HarnessAdapter, Surface, TransformKind } from './types'

export type PlanOpKind = 'read' | 'merge' | 'write' | 'delete' | 'upload' | 'download' | 'link'

export interface PlanOp {
  kind: PlanOpKind
  storePath: string
  surfaceId: SurfaceId
  detail: string
}

export type FileResolution =
  | 'unchanged'
  | 'upload'
  | 'download'
  | 'merge'
  | 'delete-local'
  | 'delete-remote'

export interface PlanFile {
  storePath: string
  surfaceId: SurfaceId
  resolution: FileResolution
  local: ManifestEntry | null
  base: ManifestEntry | null
  remote: ManifestEntry | null
}

export interface SyncPlan {
  files: PlanFile[]
  /** Ordered execution steps: read, download, merge, write, delete, upload, link. */
  ops: PlanOp[]
}

export interface PlanInput {
  base: Manifest | null
  local: Manifest
  remote: Manifest | null
  /** Store paths the plan must not touch, for example conflict copies and ignores. */
  exclude?: (storePath: string) => boolean
}

const OP_ORDER: PlanOpKind[] = ['read', 'download', 'merge', 'write', 'delete', 'upload', 'link']

function entryMap(manifest: Manifest | null): Map<string, ManifestEntry> {
  const map = new Map<string, ManifestEntry>()
  if (manifest === null) return map
  for (const entry of manifest.entries) map.set(entry.path, entry)
  return map
}

function isFile(entry: ManifestEntry | null): entry is ManifestEntry {
  return entry !== null && entry.kind === 'file'
}

function classify(
  base: ManifestEntry | null,
  local: ManifestEntry | null,
  remote: ManifestEntry | null,
): FileResolution {
  if (remote !== null && remote.kind === 'tombstone') {
    if (local === null) return 'unchanged'
    return isFile(base) && local.hash !== base.hash ? 'upload' : 'delete-local'
  }
  if (isFile(remote)) {
    if (local === null) {
      if (!isFile(base) || base.hash !== remote.hash) return 'download'
      return 'delete-remote'
    }
    if (!isFile(base)) return local.hash === remote.hash ? 'unchanged' : 'merge'
    if (remote.hash === base.hash) return local.hash === base.hash ? 'unchanged' : 'upload'
    return local.hash === base.hash ? 'download' : 'merge'
  }
  // No remote entry: either never uploaded or deleted remotely.
  if (local === null) return 'unchanged'
  if (!isFile(base)) return 'upload'
  if (local.hash === base.hash) return 'delete-local'
  return 'upload'
}

/** The decision table, pure over the three manifests. Execution stays in `sync`. */
export function computeSyncPlan(input: PlanInput): SyncPlan {
  const baseByPath = entryMap(input.base)
  const localByPath = entryMap(input.local)
  const remoteByPath = entryMap(input.remote)
  const paths = new Set<string>([
    ...baseByPath.keys(),
    ...localByPath.keys(),
    ...remoteByPath.keys(),
  ])

  const files: PlanFile[] = []
  for (const storePath of [...paths].sort()) {
    if (input.exclude?.(storePath) === true) continue
    const base = baseByPath.get(storePath) ?? null
    const local = localByPath.get(storePath) ?? null
    const remote = remoteByPath.get(storePath) ?? null
    const surfaceId = local?.surfaceId ?? remote?.surfaceId ?? base?.surfaceId
    if (surfaceId === undefined) continue
    files.push({
      storePath,
      surfaceId,
      resolution: classify(base, local, remote),
      local,
      base,
      remote,
    })
  }

  const ops: PlanOp[] = []
  for (const file of files) {
    switch (file.resolution) {
      case 'unchanged':
        break
      case 'upload':
        ops.push({
          kind: 'upload',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'local change',
        })
        break
      case 'download':
        ops.push({
          kind: 'download',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'remote change',
        })
        ops.push({
          kind: 'write',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'apply remote',
        })
        break
      case 'merge':
        ops.push({
          kind: 'read',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'load three sides',
        })
        ops.push({
          kind: 'merge',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'three-way merge',
        })
        ops.push({
          kind: 'write',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'apply merge',
        })
        break
      case 'delete-local':
        ops.push({
          kind: 'delete',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'remote deletion',
        })
        break
      case 'delete-remote':
        ops.push({
          kind: 'upload',
          storePath: file.storePath,
          surfaceId: file.surfaceId,
          detail: 'tombstone',
        })
        break
    }
  }
  const rank = new Map<PlanOpKind, number>(OP_ORDER.map((kind, index) => [kind, index]))
  ops.sort(
    (a, b) =>
      (rank.get(a.kind) ?? 0) - (rank.get(b.kind) ?? 0) || a.storePath.localeCompare(b.storePath),
  )
  return { files, ops }
}

export interface SyncOptions {
  adapters: readonly HarnessAdapter[]
  ctx: AdapterContext
  deviceId: DeviceId
  storeId: StoreId
  key: KeyMaterial
  state: SyncState
  remote: Remote
  policy?: DevicePolicy
  quiescence?: QuiescenceOptions
  hooks?: ApplyHooks
  now?: () => Date
  /** Deterministic revision ids for tests. */
  createRevisionId?: () => RevisionId
}

export const CONFLICT_LEDGER_META_KEY = 'conflict_ledger'
export const MAX_MERGE_ATTEMPTS = 3

export async function sync(options: SyncOptions): Promise<SyncReport> {
  const now = options.now ?? (() => new Date())
  const createRevisionId = options.createRevisionId ?? (() => newId() as RevisionId)
  const home = options.ctx.home

  options.state.reconcile()
  acquireLock(home)
  try {
    return await runSync(options, now, createRevisionId)
  } finally {
    releaseLock(home)
  }
}

function loadLedger(state: SyncState): ConflictLedger {
  const raw = state.getMeta(CONFLICT_LEDGER_META_KEY)
  if (raw === null) return new ConflictLedger()
  try {
    return ConflictLedger.fromJSON(raw)
  } catch {
    return new ConflictLedger()
  }
}

function markerSurface(surface: Surface | undefined): boolean {
  return surface?.transforms.some((transform) => transform.kind === 'markerBlocks') === true
}

function readText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf8')
}

function readTextOrNull(filePath: string): string | null {
  try {
    return readText(filePath)
  } catch {
    return null
  }
}

function sameEntries(a: readonly ManifestEntry[], b: readonly ManifestEntry[]): boolean {
  const key = (entry: ManifestEntry): string =>
    `${entry.surfaceId}\u0000${entry.path}\u0000${entry.kind}\u0000${entry.hash}`
  const left = a.map(key).sort()
  const right = b.map(key).sort()
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

async function runSync(
  options: SyncOptions,
  now: () => Date,
  createRevisionId: () => RevisionId,
): Promise<SyncReport> {
  const { ctx, deviceId, storeId, key, state, remote } = options
  const tokenEnv: TokenEnv = { home: ctx.home, platform: ctx.platform, env: ctx.env }
  const fileContext: BlobContext = { storeId, blobType: 'file', protocolVersion: PROTOCOL_VERSION }
  const manifestContext: BlobContext = {
    storeId,
    blobType: 'manifest',
    protocolVersion: PROTOCOL_VERSION,
  }

  const surfaces = new Map<SurfaceId, Surface>()
  for (const adapter of options.adapters) {
    for (const surface of adapter.surfaces(ctx)) surfaces.set(surface.id, surface)
  }
  const policy = options.policy
  const ignores = (policy?.ignore ?? []).map((pattern) => pm(pattern))
  const harnessDisabled = (surface: Surface): boolean => {
    const harness = policy?.harnesses?.[surface.harness]
    return harness !== undefined && !harness.enabled
  }
  const excluded = (storePath: string): boolean =>
    isConflictCopyPath(storePath) || ignores.some((matches) => matches(storePath))

  /** Opt-in surfaces participate only when the device policy names them `on` explicitly. */
  const optInEnabled = (surface: Surface): boolean => {
    const harness = policy?.harnesses?.[surface.harness]
    if (harness === undefined || !harness.enabled) return false
    return harness.surfaces[surface.id] === 'on'
  }
  /** The entry's effective policy decides, so Codex profile overrides inside `never` travel. */
  const entrySyncable = (entry: ManifestEntry, surface: Surface | undefined): boolean => {
    if (surface === undefined || harnessDisabled(surface)) return false
    return entry.policy !== 'opt-in' || optInEnabled(surface)
  }

  const ledger = loadLedger(state)
  const scanResult = scan({
    adapters: options.adapters,
    ctx,
    deviceId,
    revisionId: createRevisionId(),
    createdAt: now().toISOString(),
  })
  const localEntries: ManifestEntry[] = []
  for (const entry of scanResult.manifest.entries) {
    if (!entrySyncable(entry, surfaces.get(entry.surfaceId))) continue
    if (ledger.isExcluded(entry.path) || excluded(entry.path)) continue
    localEntries.push(entry)
  }
  const localManifest: Manifest = { ...scanResult.manifest, entries: localEntries }

  const baseRevisionId = state.getBaseRevision()
  const baseManifest = baseRevisionId === null ? null : state.getManifest(baseRevisionId)
  const revisionList = await remote.listRevisions()
  const headId = revisionList.head
  let remoteManifest: Manifest | null = null
  if (headId !== null && headId !== baseRevisionId) {
    remoteManifest = parseManifest(
      JSON.parse(openText(key, 'manifest', await remote.getManifest(headId), manifestContext)),
    )
  } else if (headId !== null) {
    remoteManifest = baseManifest
  }

  const plan = computeSyncPlan({
    base: baseManifest,
    local: localManifest,
    remote: remoteManifest,
    exclude: (storePath) => excluded(storePath) || ledger.isExcluded(storePath),
  })
  const active = plan.files.filter((file) => {
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined) return false
    const entry = file.local ?? file.remote
    return entry !== null && entrySyncable(entry, surface)
  })
  plan.files = active

  // The stored layout carries link knowledge forward: a link a previous run saw
  // is recreated when the layout says it belongs there, even if it is missing now.
  const layoutByPath = new Map<string, LocalLayout['entries'][number]>()
  for (const entry of state.getLayout(deviceId)?.entries ?? []) layoutByPath.set(entry.path, entry)
  for (const entry of scanResult.layout.entries) layoutByPath.set(entry.path, entry)
  const layout: LocalLayout = {
    deviceId,
    entries: [...layoutByPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
  }
  state.saveLayout(layout)

  const declaredByStorePath = new Map<string, string>()
  for (const entry of scanResult.entries) {
    if (entry.storePath !== null) declaredByStorePath.set(entry.storePath, entry.localPath)
  }
  const pathMappings = new Map<SurfaceId, PathMapping[]>()
  for (const mapping of scanResult.pathMap) {
    const list = pathMappings.get(mapping.surfaceId)
    if (list === undefined) pathMappings.set(mapping.surfaceId, [mapping])
    else list.push(mapping)
  }
  /** Resolves a re-keyed store path (Claude memory) back to this machine's directory. */
  const mappedLocalPath = (surfaceId: SurfaceId, storePath: string): string | null => {
    for (const mapping of pathMappings.get(surfaceId) ?? []) {
      const resolved = localPathForMapping(mapping, storePath)
      if (resolved !== null) return resolved
    }
    return null
  }
  const declaredPathFor = (file: PlanFile): string | null => {
    const known = declaredByStorePath.get(file.storePath)
    if (known !== undefined) return known
    const mapped = mappedLocalPath(file.surfaceId, file.storePath)
    if (mapped !== null) return mapped
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined) return null
    const root = surface.path.replace(/[/\\]+$/, '')
    if (file.storePath === root) return expand(root, tokenEnv)
    if (!file.storePath.startsWith(`${root}/`)) return null
    const relative = file.storePath.slice(root.length + 1)
    return path.join(expand(root, tokenEnv), ...relative.split('/'))
  }
  const planPaths = new Set<string>()
  for (const entry of scanResult.entries) planPaths.add(entry.localPath)
  for (const layoutEntry of layout.entries) {
    if (layoutEntry.mode === 'symlink' && layoutEntry.linkTarget !== undefined) {
      planPaths.add(path.resolve(path.dirname(layoutEntry.path), layoutEntry.linkTarget))
    }
  }
  for (const file of active) {
    const declared = declaredPathFor(file)
    if (declared !== null) planPaths.add(declared)
  }
  const applier = new Applier({
    state,
    planPaths: [...planPaths],
    layout,
    platform: ctx.platform,
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
    now,
  })
  const gate = new QuiescenceGate(options.quiescence ?? {})

  const changed: string[] = []
  const conflicts: ConflictArtifact[] = []
  const blocked: string[] = []
  const deferred: string[] = []
  const tombstones = new Set<string>()
  const uploadedRefs = new Map<string, BlobRef>()
  let uploaded = 0
  let downloaded = 0

  const defer = (storePath: string, reason: string): void => {
    deferred.push(storePath)
    state.enqueueOp({
      kind: 'retry',
      payload: JSON.stringify({ storePath, reason }),
      createdAt: now().toISOString(),
    })
  }

  const sealUpload = async (projection: string): Promise<BlobRef> => {
    const sealed = sealText(key, 'content', projection, fileContext)
    const ref = await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
    uploadedRefs.set(hashContent(projection), ref)
    uploaded += 1
    return ref
  }

  /** Merge paths handle marker blocks themselves, so their projections skip that kind. */
  const contentKinds = (surface: Surface): TransformKind[] =>
    surface.transforms.map((spec) => spec.kind).filter((kind) => kind !== 'markerBlocks')
  const allKinds = (surface: Surface): TransformKind[] =>
    surface.transforms.map((spec) => spec.kind)

  const project = (
    surface: Surface,
    file: PlanFile,
    direction: 'toStore' | 'fromStore',
    content: string,
    localContent: string | null,
    kinds: readonly TransformKind[],
  ): string =>
    applyTransforms({
      surface,
      storePath: file.storePath,
      direction,
      tokenEnv,
      content,
      localContent,
      kinds,
    }).content

  /** The exact bytes an upload would carry: transforms plus secret rules, or a block reason. */
  const uploadProjection = (
    surface: Surface,
    file: PlanFile,
    content: string,
    kinds: readonly TransformKind[],
  ): { content: string; blocked: string | null } => {
    const transformed = project(surface, file, 'toStore', content, null, kinds)
    return enforceUploadRules(surface, file.storePath, transformed)
  }

  const uploadLocalFile = async (file: PlanFile, declaredPath: string): Promise<boolean> => {
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined || file.local === null) return false
    const content = readTextOrNull(declaredPath)
    if (content === null) return false
    let outcome: { content: string; blocked: string | null }
    try {
      if (markerSurface(surface)) {
        state.saveMarkers(declaredPath, parseLocalBlocks(declaredPath, content))
      }
      outcome = uploadProjection(surface, file, content, allKinds(surface))
    } catch {
      blocked.push(file.storePath)
      return false
    }
    if (outcome.blocked !== null) {
      blocked.push(file.storePath)
      return false
    }
    await sealUpload(outcome.content)
    changed.push(file.storePath)
    return true
  }

  const reinsert = (file: PlanFile, declaredPath: string, remoteText: string): string | null => {
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined || !markerSurface(surface)) return remoteText
    const current = readTextOrNull(declaredPath)
    try {
      if (current !== null) {
        const blocks = parseLocalBlocks(declaredPath, current)
        state.saveMarkers(declaredPath, blocks)
        return reinsertLocalBlocks(remoteText, blocks)
      }
      // The working copy vanished between plan and apply; the last known blocks
      // still belong at their anchors rather than being dropped.
      const stored = state.getMarkers(declaredPath)
      return stored.length > 0 ? reinsertLocalBlocks(remoteText, stored) : remoteText
    } catch {
      return null
    }
  }

  /** Apply-side pipeline: marker re-insertion first, then transforms into local machine state. */
  const fromStore = (file: PlanFile, declaredPath: string, remoteText: string): string | null => {
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined) return null
    try {
      const withMarkers = reinsert(file, declaredPath, remoteText)
      if (withMarkers === null) return null
      return project(
        surface,
        file,
        'fromStore',
        withMarkers,
        readTextOrNull(declaredPath),
        contentKinds(surface),
      )
    } catch {
      return null
    }
  }

  const guard = (declaredPath: string): ReturnType<Applier['fingerprint']> =>
    applier.fingerprint(declaredPath)

  /** True when the local file still matches the scan that produced the plan. */
  const unchangedSinceScan = (
    file: PlanFile,
    declaredPath: string,
    actual: FileFingerprint | null,
  ): boolean => {
    if (actual === null) return file.local === null
    if (file.local === null) return false
    if (actual.hash === file.local.hash) return true
    // Manifest hashes are over the projection, so a projected file re-reads through the pipeline.
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined) return false
    const content = readTextOrNull(declaredPath)
    if (content === null) return false
    try {
      const outcome = uploadProjection(surface, file, content, allKinds(surface))
      return outcome.blocked === null && hashContent(outcome.content) === file.local.hash
    } catch {
      return false
    }
  }

  for (const file of active) {
    if (file.resolution !== 'download') continue
    const declaredPath = declaredPathFor(file)
    const remoteEntry = file.remote
    if (declaredPath === null || !isFile(remoteEntry) || remoteEntry.blob === undefined) continue
    const bytes = await remote.getBlob(remoteEntry.blob.id)
    const remoteText = openText(key, 'content', bytes, fileContext)
    const content = fromStore(file, declaredPath, remoteText)
    if (content === null) {
      defer(file.storePath, 'broken marker block in local file')
      continue
    }
    const before = guard(declaredPath)
    if (!unchangedSinceScan(file, declaredPath, before)) {
      defer(file.storePath, 'local file changed since the scan')
      continue
    }
    if (before !== null) gate.prime(declaredPath, before.mtimeMs)
    const current = guard(declaredPath)
    if (current !== null && gate.observe(declaredPath, current.mtimeMs) !== 'quiescent') {
      defer(file.storePath, 'local file recently written')
      continue
    }
    try {
      applier.write({
        storePath: file.storePath,
        declaredPath,
        content,
        mode: remoteEntry.mode,
        expected: before,
      })
      changed.push(file.storePath)
      downloaded += 1
    } catch (error) {
      if (error instanceof StaleWriteError) defer(file.storePath, 'changed while applying')
      else throw error
    }
  }

  for (const file of active) {
    if (file.resolution !== 'merge') continue
    const declaredPath = declaredPathFor(file)
    const remoteEntry = file.remote
    const surface = surfaces.get(file.surfaceId)
    if (declaredPath === null || !isFile(remoteEntry) || remoteEntry.blob === undefined) continue
    if (surface === undefined) continue
    const remoteText = openText(
      key,
      'content',
      await remote.getBlob(remoteEntry.blob.id),
      fileContext,
    )
    const baseText =
      isFile(file.base) && file.base.blob !== undefined
        ? openText(key, 'content', await remote.getBlob(file.base.blob.id), fileContext)
        : remoteText

    const before = guard(declaredPath)
    if (before !== null) gate.prime(declaredPath, before.mtimeMs)
    let merged = false
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS && !merged; attempt += 1) {
      const current = guard(declaredPath)
      if (current !== null && gate.observe(declaredPath, current.mtimeMs) !== 'quiescent') {
        defer(file.storePath, 'local file recently written')
        break
      }
      const localRaw = readTextOrNull(declaredPath)
      if (localRaw === null) break
      let localText: string
      try {
        const outcome = uploadProjection(surface, file, localRaw, contentKinds(surface))
        if (outcome.blocked !== null) {
          defer(file.storePath, 'local file blocked by secret rules')
          break
        }
        localText = outcome.content
      } catch {
        defer(file.storePath, 'local projection failed')
        break
      }
      const result = merge(
        {
          strategy: surface.merge,
          base: baseText,
          local: localText,
          remote: remoteText,
        },
        { markerBlocks: markerSurface(surface) },
      )
      if (result.status === 'conflicted') {
        const copy = createConflictArtifact({
          sourcePath: declaredPath,
          content: remoteText,
          device: String(deviceId),
          createdAt: now().toISOString(),
        })
        const existing = readTextOrNull(copy.path)
        if (existing !== copy.content) {
          applier.write({
            storePath: file.storePath,
            declaredPath: copy.path,
            content: copy.content,
          })
        }
        ledger.add(conflictRecord(copy, declaredPath))
        state.setMeta(CONFLICT_LEDGER_META_KEY, ledger.toJSON())
        conflicts.push(copy)
        if (await uploadLocalFile(file, declaredPath)) merged = true
        break
      }
      if (result.status === 'unchanged') {
        if (await uploadLocalFile(file, declaredPath)) merged = true
        break
      }
      let writeContent: string
      try {
        writeContent = project(
          surface,
          file,
          'fromStore',
          result.content,
          localRaw,
          contentKinds(surface),
        )
      } catch {
        break
      }
      try {
        applier.write({
          storePath: file.storePath,
          declaredPath,
          content: writeContent,
          mode: file.local?.mode ?? remoteEntry.mode,
          expected: attempt === 0 ? before : guard(declaredPath),
        })
        if (await uploadLocalFile(file, declaredPath)) {
          merged = true
        }
      } catch (error) {
        if (!(error instanceof StaleWriteError)) throw error
      }
    }
    if (!merged) defer(file.storePath, 'merge could not settle')
  }

  for (const file of active) {
    if (file.resolution !== 'delete-local') continue
    const declaredPath = declaredPathFor(file)
    if (declaredPath === null) continue
    const before = guard(declaredPath)
    if (before === null) continue
    if (!unchangedSinceScan(file, declaredPath, before)) {
      defer(file.storePath, 'local file changed since the scan')
      continue
    }
    gate.prime(declaredPath, before.mtimeMs)
    const current = guard(declaredPath)
    if (current !== null && gate.observe(declaredPath, current.mtimeMs) !== 'quiescent') {
      defer(file.storePath, 'local file recently written')
      continue
    }
    applier.remove({
      storePath: file.storePath,
      surfaceId: file.surfaceId,
      declaredPath,
      baseRevision: null,
    })
    changed.push(file.storePath)
  }

  for (const file of active) {
    if (file.resolution === 'delete-remote') {
      tombstones.add(file.storePath)
      changed.push(file.storePath)
      continue
    }
    if (file.resolution !== 'upload') continue
    const declaredPath = declaredPathFor(file)
    if (declaredPath === null) continue
    await uploadLocalFile(file, declaredPath)
  }

  const finalScan = scan({
    adapters: options.adapters,
    ctx,
    deviceId,
    revisionId: createRevisionId(),
    createdAt: now().toISOString(),
  })
  const refByHash = new Map<string, BlobRef>()
  for (const entry of [...(baseManifest?.entries ?? []), ...(remoteManifest?.entries ?? [])]) {
    if (isFile(entry) && entry.blob !== undefined && !refByHash.has(entry.hash)) {
      refByHash.set(entry.hash, entry.blob)
    }
  }
  for (const [hash, ref] of uploadedRefs) refByHash.set(hash, ref)

  const baseByPath = entryMap(baseManifest)
  const remoteByPath = entryMap(remoteManifest)
  const newEntries: ManifestEntry[] = []
  for (const entry of finalScan.manifest.entries) {
    if (ledger.isExcluded(entry.path) || excluded(entry.path)) continue
    if (!entrySyncable(entry, surfaces.get(entry.surfaceId))) continue
    const manifestEntry: ManifestEntry = {
      surfaceId: entry.surfaceId,
      path: entry.path,
      kind: 'file',
      policy: entry.policy,
      hash: entry.hash,
      size: entry.size,
      mode: entry.mode,
    }
    const ref = refByHash.get(entry.hash)
    if (ref !== undefined) {
      manifestEntry.blob = ref
      newEntries.push(manifestEntry)
      continue
    }
    // A blocked or unpushed local edit keeps the last synced remote version.
    const fallback = baseByPath.get(entry.path) ?? remoteByPath.get(entry.path)
    if (fallback !== undefined && isFile(fallback) && fallback.blob !== undefined) {
      newEntries.push(fallback)
    }
  }
  for (const storePath of [...tombstones].sort()) {
    const source = baseByPath.get(storePath) ?? remoteByPath.get(storePath)
    const surfaceId =
      source?.surfaceId ?? active.find((file) => file.storePath === storePath)?.surfaceId
    if (surfaceId === undefined) continue
    newEntries.push({
      surfaceId,
      path: storePath,
      kind: 'tombstone',
      policy: source?.policy ?? 'sync',
      hash: '',
      size: 0,
      mode: 0,
    })
  }
  // A device that has an opt-in surface disabled still carries its remote entries
  // forward. Dropping them would read as a remote deletion on every other device.
  const carried = new Map<string, ManifestEntry>()
  for (const entry of [...(baseManifest?.entries ?? []), ...(remoteManifest?.entries ?? [])]) {
    const surface = surfaces.get(entry.surfaceId)
    if (surface === undefined || entry.policy !== 'opt-in' || optInEnabled(surface)) continue
    carried.set(entry.path, entry)
  }
  const present = new Set(newEntries.map((entry) => entry.path))
  for (const [, entry] of [...carried].sort(([a], [b]) => a.localeCompare(b))) {
    if (!present.has(entry.path)) newEntries.push(entry)
  }
  newEntries.sort((a, b) => a.surfaceId.localeCompare(b.surfaceId) || a.path.localeCompare(b.path))

  const report: SyncReport = {
    revisionId: null,
    changed: [...new Set(changed)].sort(),
    conflicts,
    blocked: [...new Set(blocked)].sort(),
    deferred: [...new Set(deferred)].sort(),
    uploaded,
    downloaded,
  }

  const headMeta = headId === null ? undefined : revisionList.revisions.at(-1)
  const filesOnly = (entries: readonly ManifestEntry[]): ManifestEntry[] =>
    entries.filter((entry) => entry.kind === 'file')
  const remoteMatches =
    remoteManifest !== null && sameEntries(filesOnly(newEntries), filesOnly(remoteManifest.entries))
  const baseMatches =
    baseManifest !== null && sameEntries(filesOnly(newEntries), filesOnly(baseManifest.entries))
  if (remoteMatches && headMeta !== undefined) {
    state.saveManifest(revisionRecord(headMeta, 'base'), newEntries)
    state.setBaseRevision(headMeta.id)
    report.revisionId = headMeta.id
    return report
  }
  if (baseMatches && headId === baseRevisionId) {
    report.revisionId = baseRevisionId
    return report
  }

  const revisionId = createRevisionId()
  const createdAt = now().toISOString()
  const manifest: Manifest = { revisionId, deviceId, createdAt, entries: newEntries }
  const sealed = sealText(key, 'manifest', JSON.stringify(manifest), manifestContext)
  await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
  const parents = [headId, baseRevisionId]
    .filter((value): value is RevisionId => value !== null && value !== revisionId)
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, 4)
  const revision: RevisionSummary = {
    id: revisionId,
    storeId,
    deviceId,
    parents,
    manifest: { id: sealed.blobId, size: sealed.bytes.length },
    createdAt,
  }
  const blobs = uniqueBlobs(newEntries)
  const digest = surfaceDigest(newEntries)
  const result = await remote.commit({ revision, blobs, digest })
  if (!result.accepted) {
    throw new Error(`remote rejected the commit; missing blobs: ${result.missing.join(', ')}`)
  }
  state.saveManifest(
    {
      id: revisionId,
      deviceId,
      parents,
      createdAt,
      manifest: revision.manifest,
      digest,
      role: 'base',
    },
    newEntries,
  )
  state.setBaseRevision(revisionId)
  report.revisionId = revisionId
  return report
}

function uniqueBlobs(entries: readonly ManifestEntry[]): BlobRef[] {
  const byId = new Map<string, BlobRef>()
  for (const entry of entries) {
    if (entry.blob !== undefined) byId.set(entry.blob.id, entry.blob)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function surfaceDigest(entries: readonly ManifestEntry[]): SurfaceDigest[] {
  const bySurface = new Map<SurfaceId, { files: number; bytes: number }>()
  for (const entry of entries) {
    if (entry.kind !== 'file') continue
    const current = bySurface.get(entry.surfaceId) ?? { files: 0, bytes: 0 }
    current.files += 1
    current.bytes += entry.size
    bySurface.set(entry.surfaceId, current)
  }
  return [...bySurface.entries()]
    .map(([surfaceId, counts]) => ({ surfaceId, files: counts.files, bytes: counts.bytes }))
    .sort((a, b) => a.surfaceId.localeCompare(b.surfaceId))
}

function revisionRecord(
  meta: RevisionMeta,
  role: 'base' | 'local' | 'remote',
): {
  id: RevisionId
  deviceId: DeviceId
  parents: RevisionId[]
  createdAt: string
  manifest: BlobRef
  digest: RevisionMeta['digest']
  role: 'base' | 'local' | 'remote'
} {
  return {
    id: meta.id,
    deviceId: meta.deviceId,
    parents: [...meta.parents],
    createdAt: meta.createdAt,
    manifest: { id: meta.manifest.id, size: meta.manifest.size },
    digest: [...meta.digest],
    role,
  }
}
