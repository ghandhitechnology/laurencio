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
import { parseLocalBlocks, reinsertLocalBlocks, stripLocalBlocks } from './markers'
import { merge } from './merge'
import {
  ConflictLedger,
  conflictStoreRecord,
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
import { parseManifest, StaleParentsError } from './remote/types'
import { type ScannedEntry, scan } from './scan'
import { scanFiles } from './secrets/scan'
import { acquireLock, releaseLock, type SyncState } from './state'
import { type AdapterContext, type HarnessAdapter, isSyncable, type Surface } from './types'

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
/** Bounded re-pull/re-merge cycles when the remote head advances mid-run. */
export const MAX_SYNC_ATTEMPTS = 3

/** A store with several incomparable heads the engine cannot merge safely. */
export class RemoteForkError extends Error {
  readonly heads: readonly RevisionId[]
  readonly storePaths: readonly string[]

  constructor(heads: readonly RevisionId[], storePaths: readonly string[] = []) {
    super(`remote store is forked across heads: ${heads.join(', ')}`)
    this.name = 'RemoteForkError'
    this.heads = heads
    this.storePaths = storePaths
  }
}

export async function sync(options: SyncOptions): Promise<SyncReport> {
  const now = options.now ?? (() => new Date())
  const createRevisionId = options.createRevisionId ?? (() => newId() as RevisionId)
  const home = options.ctx.home

  // The lock comes first: a second process must not reconcile a first
  // process's journal, which would roll back writes that are still in flight.
  const holder = acquireLock(home)
  try {
    options.state.reconcile()
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await runSync(options, now, createRevisionId)
      } catch (error) {
        if (!(error instanceof StaleParentsError) || attempt >= MAX_SYNC_ATTEMPTS) throw error
      }
    }
  } finally {
    releaseLock(home, holder.pid, holder)
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

  const ledger = loadLedger(state)
  const scanResult = scan({
    adapters: options.adapters,
    ctx,
    deviceId,
    revisionId: createRevisionId(),
    createdAt: now().toISOString(),
  })
  const localEntries: ManifestEntry[] = []
  const scannedByStorePath = new Map<string, ScannedEntry>()
  for (const entry of scanResult.entries) {
    if (entry.storePath !== null) scannedByStorePath.set(entry.storePath, entry)
  }
  for (const entry of scanResult.manifest.entries) {
    if (!syncableForManifest(entry, surfaces, harnessDisabled)) continue
    if (ledger.isExcluded(entry.path) || excluded(entry.path)) continue
    const surface = surfaces.get(entry.surfaceId)
    if (surface === undefined) continue
    if (markerSurface(surface)) {
      // Marker files compare and upload as their projection, never the raw bytes.
      const localPath = scannedByStorePath.get(entry.path)?.localPath
      if (localPath === undefined) continue
      const text = readTextOrNull(localPath)
      if (text === null) continue
      let projection: string
      try {
        projection = stripLocalBlocks(localPath, text)
      } catch {
        continue
      }
      localEntries.push({
        ...entry,
        hash: hashContent(projection),
        size: Buffer.byteLength(projection),
      })
      continue
    }
    localEntries.push(entry)
  }
  const localManifest: Manifest = { ...scanResult.manifest, entries: localEntries }

  const baseRevisionId = state.getBaseRevision()
  const baseManifest = baseRevisionId === null ? null : state.getManifest(baseRevisionId)
  const revisionList = await remote.listRevisions()
  const headIds =
    revisionList.heads.length > 0
      ? [...revisionList.heads]
      : revisionList.head === null
        ? []
        : [revisionList.head]
  if (headIds.length > 4) throw new RemoteForkError(headIds)
  const resolved = await resolveRemoteView({
    headIds,
    baseRevisionId,
    baseManifest,
    key,
    remote,
    manifestContext,
    fileContext,
    surfaces,
  })
  const remoteManifest = resolved.manifest
  const headUploads = resolved.uploads

  const plan = computeSyncPlan({
    base: baseManifest,
    local: localManifest,
    remote: remoteManifest,
    exclude: (storePath) => excluded(storePath) || ledger.isExcluded(storePath),
  })
  const active = plan.files.filter((file) => {
    const surface = surfaces.get(file.surfaceId)
    return surface !== undefined && isSyncable(surface) && !harnessDisabled(surface)
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
  const declaredPathFor = (file: PlanFile): string | null => {
    const known = declaredByStorePath.get(file.storePath)
    if (known !== undefined) return known
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
  // Hints queued by the previous run's deferrals. The scan just rediscovered
  // what still needs work, so the rows are consumed instead of left to pile up.
  state.drainPendingOps('retry')
  const uploadedRefs = new Map<string, BlobRef>(headUploads)
  let uploaded = headUploads.size
  let downloaded = 0

  const defer = (storePath: string, reason: string): void => {
    if (deferred.includes(storePath)) return
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

  const uploadLocalFile = async (file: PlanFile, declaredPath: string): Promise<boolean> => {
    const surface = surfaces.get(file.surfaceId)
    if (surface === undefined || file.local === null) return false
    const content = readTextOrNull(declaredPath)
    if (content === null) return false
    let projection: string
    try {
      if (markerSurface(surface)) {
        state.saveMarkers(declaredPath, parseLocalBlocks(declaredPath, content))
        projection = stripLocalBlocks(declaredPath, content)
      } else {
        projection = content
      }
    } catch {
      blocked.push(file.storePath)
      return false
    }
    if (!scanFiles([{ path: file.storePath, content: projection }]).clean) {
      blocked.push(file.storePath)
      return false
    }
    await sealUpload(projection)
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

  const guard = (declaredPath: string): ReturnType<Applier['fingerprint']> =>
    applier.fingerprint(declaredPath)

  /** True when the local file still matches the scan that produced the plan. */
  const unchangedSinceScan = (file: PlanFile, actual: FileFingerprint | null): boolean => {
    if (actual === null) return file.local === null
    return file.local !== null && actual.hash === file.local.hash
  }

  for (const file of active) {
    if (file.resolution !== 'download') continue
    const declaredPath = declaredPathFor(file)
    const remoteEntry = file.remote
    if (declaredPath === null || !isFile(remoteEntry) || remoteEntry.blob === undefined) continue
    const bytes = await remote.getBlob(remoteEntry.blob.id)
    const remoteText = openText(key, 'content', bytes, fileContext)
    const content = reinsert(file, declaredPath, remoteText)
    if (content === null) {
      defer(file.storePath, 'broken marker block in local file')
      continue
    }
    const before = guard(declaredPath)
    if (!unchangedSinceScan(file, before)) {
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
      const localText = readTextOrNull(declaredPath)
      if (localText === null) break
      const localMtimeMs = current?.mtimeMs ?? before?.mtimeMs
      const result = merge(
        {
          strategy: surface.merge,
          base: baseText,
          local: localText,
          remote: remoteText,
          ...(localMtimeMs !== undefined
            ? { localTimestamp: new Date(localMtimeMs).toISOString() }
            : {}),
          ...(remoteManifest !== null ? { remoteTimestamp: remoteManifest.createdAt } : {}),
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
        ledger.add(conflictStoreRecord(file.storePath, copy))
        state.setMeta(CONFLICT_LEDGER_META_KEY, ledger.toJSON())
        conflicts.push(copy)
        if (await uploadLocalFile(file, declaredPath)) merged = true
        break
      }
      if (result.status === 'unchanged') {
        if (await uploadLocalFile(file, declaredPath)) merged = true
        break
      }
      try {
        applier.write({
          storePath: file.storePath,
          declaredPath,
          content: result.content,
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
    if (!unchangedSinceScan(file, before)) {
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
  const finalByStorePath = new Map<string, ScannedEntry>()
  for (const entry of finalScan.entries) {
    if (entry.storePath !== null) finalByStorePath.set(entry.storePath, entry)
  }
  const newEntries: ManifestEntry[] = []
  for (const entry of finalScan.manifest.entries) {
    if (ledger.isExcluded(entry.path) || excluded(entry.path)) continue
    if (!syncableForManifest(entry, surfaces, harnessDisabled)) continue
    const surface = surfaces.get(entry.surfaceId)
    if (surface === undefined || !isSyncable(surface)) continue
    let hash = entry.hash
    let size = entry.size
    if (markerSurface(surface)) {
      const localPath = finalByStorePath.get(entry.path)?.localPath
      if (localPath === undefined) continue
      const text = readTextOrNull(localPath)
      if (text === null) continue
      const projection = stripLocalBlocks(localPath, text)
      hash = hashContent(projection)
      size = Buffer.byteLength(projection)
    }
    const manifestEntry: ManifestEntry = {
      surfaceId: entry.surfaceId,
      path: entry.path,
      kind: 'file',
      hash,
      size,
      mode: entry.mode,
    }
    const ref = refByHash.get(hash)
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
      hash: '',
      size: 0,
      mode: 0,
    })
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

  // A deferred path whose remote side moved is unresolved work: committing now
  // would either revert the remote edit or adopt a base the local copy does not
  // match. Let the next run merge it first.
  const unresolvedRemote = [...new Set(deferred)].some((storePath) => {
    const remoteEntry = remoteByPath.get(storePath) ?? null
    const baseEntry = baseByPath.get(storePath) ?? null
    if (remoteEntry === null || baseEntry === null) return remoteEntry !== baseEntry
    return !sameEntryContent(remoteEntry, baseEntry)
  })
  if (unresolvedRemote) return report

  const filesOnly = (entries: readonly ManifestEntry[]): ManifestEntry[] =>
    entries.filter((entry) => entry.kind === 'file')
  const remoteMatches =
    remoteManifest !== null && sameEntries(filesOnly(newEntries), filesOnly(remoteManifest.entries))
  const baseMatches =
    baseManifest !== null && sameEntries(filesOnly(newEntries), filesOnly(baseManifest.entries))
  // A forked store is always resolved with a real merge revision, never by
  // adopting one head and dropping the other.
  if (headIds.length === 1) {
    const headId = headIds[0] ?? null
    const headMeta =
      headId === null ? undefined : revisionList.revisions.find((r) => r.id === headId)
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
  }

  const revisionId = createRevisionId()
  const createdAt = now().toISOString()
  const manifest: Manifest = { revisionId, deviceId, createdAt, entries: newEntries }
  const sealed = sealText(key, 'manifest', JSON.stringify(manifest), manifestContext)
  await remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
  const parents = [...headIds, baseRevisionId]
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
    if (result.reason === 'stale-parents') throw new StaleParentsError(result.heads ?? [])
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

interface RemoteView {
  manifest: Manifest | null
  /** Blobs sealed while folding a fork, keyed by plaintext hash. */
  uploads: Map<string, BlobRef>
}

async function loadRemoteManifest(
  remote: Remote,
  key: KeyMaterial,
  revisionId: RevisionId,
  manifestContext: BlobContext,
): Promise<Manifest> {
  return parseManifest(
    JSON.parse(openText(key, 'manifest', await remote.getManifest(revisionId), manifestContext)),
  )
}

/**
 * The remote side for planning. One head is just its manifest; several
 * incomparable heads are folded with each surface's merge strategy, so a fork
 * resolves instead of silently dropping one device's edit.
 */
async function resolveRemoteView(args: {
  headIds: readonly RevisionId[]
  baseRevisionId: RevisionId | null
  baseManifest: Manifest | null
  key: KeyMaterial
  remote: Remote
  manifestContext: BlobContext
  fileContext: BlobContext
  surfaces: Map<SurfaceId, Surface>
}): Promise<RemoteView> {
  const uploads = new Map<string, BlobRef>()
  if (args.headIds.length === 0) return { manifest: null, uploads }
  if (args.headIds.length === 1) {
    const only = args.headIds[0]
    if (only === undefined) return { manifest: null, uploads }
    if (only === args.baseRevisionId) return { manifest: args.baseManifest, uploads }
    return {
      manifest: await loadRemoteManifest(args.remote, args.key, only, args.manifestContext),
      uploads,
    }
  }

  const baseByPath = entryMap(args.baseManifest)
  let folded: Manifest | null = null
  for (const headId of args.headIds) {
    const manifest =
      headId === args.baseRevisionId && args.baseManifest !== null
        ? args.baseManifest
        : await loadRemoteManifest(args.remote, args.key, headId, args.manifestContext)
    if (folded === null) {
      folded = { ...manifest, entries: [...manifest.entries] }
      continue
    }
    const foldedManifest: Manifest = folded
    const foldedByPath = entryMap(foldedManifest)
    const unresolved: string[] = []
    for (const entry of manifest.entries) {
      const previous = foldedByPath.get(entry.path)
      if (previous === undefined || sameEntryContent(previous, entry)) continue
      if (
        !isFile(previous) ||
        !isFile(entry) ||
        previous.blob === undefined ||
        entry.blob === undefined
      ) {
        unresolved.push(entry.path)
        continue
      }
      const surface = args.surfaces.get(entry.surfaceId) ?? args.surfaces.get(previous.surfaceId)
      const baseEntry = baseByPath.get(entry.path) ?? null
      const previousText = openText(
        args.key,
        'content',
        await args.remote.getBlob(previous.blob.id),
        args.fileContext,
      )
      const nextText = openText(
        args.key,
        'content',
        await args.remote.getBlob(entry.blob.id),
        args.fileContext,
      )
      const baseText =
        isFile(baseEntry) && baseEntry.blob !== undefined
          ? openText(
              args.key,
              'content',
              await args.remote.getBlob(baseEntry.blob.id),
              args.fileContext,
            )
          : ''
      const result = merge(
        {
          strategy: surface?.merge ?? 'text3way',
          base: baseText,
          local: previousText,
          remote: nextText,
          localTimestamp: foldedManifest.createdAt,
          remoteTimestamp: manifest.createdAt,
        },
        { markerBlocks: surface !== undefined && markerSurface(surface) },
      )
      if (result.status === 'unchanged') continue
      if (result.status === 'conflicted') {
        unresolved.push(entry.path)
        continue
      }
      const hash = hashContent(result.content)
      let ref = uploads.get(hash)
      if (ref === undefined) {
        const sealed = sealText(args.key, 'content', result.content, args.fileContext)
        ref = await args.remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
        uploads.set(hash, ref)
      }
      foldedByPath.set(entry.path, {
        ...previous,
        hash,
        size: Buffer.byteLength(result.content),
        blob: ref,
      })
    }
    if (unresolved.length > 0) throw new RemoteForkError(args.headIds, unresolved)
    folded = {
      ...foldedManifest,
      entries: [...foldedByPath.values()].sort(
        (a, b) => a.surfaceId.localeCompare(b.surfaceId) || a.path.localeCompare(b.path),
      ),
    }
  }
  return { manifest: folded, uploads }
}

function sameEntryContent(a: ManifestEntry, b: ManifestEntry): boolean {
  return a.kind === b.kind && a.hash === b.hash
}

function uniqueBlobs(entries: readonly ManifestEntry[]): BlobRef[] {
  const byId = new Map<string, BlobRef>()
  for (const entry of entries) {
    if (entry.blob !== undefined) byId.set(entry.blob.id, entry.blob)
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function syncableForManifest(
  entry: ManifestEntry,
  surfaces: Map<SurfaceId, Surface>,
  disabled: (surface: Surface) => boolean,
): boolean {
  const surface = surfaces.get(entry.surfaceId)
  return surface !== undefined && isSyncable(surface) && !disabled(surface)
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
