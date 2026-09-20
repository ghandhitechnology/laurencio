/**
 * Dry-run planning and drift detection. The engine owns execution; this module
 * rebuilds the same decision table over the same three manifests so `sync
 * --dry-run` and `status` can report without writing anything.
 */

import fs from 'node:fs'
import {
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  computeSyncPlan,
  type FileResolution,
  hashContent,
  type Manifest,
  type ManifestEntry,
  type Surface,
  type SyncPlan,
  type SyncState,
} from '@laurencio/core'
import pm from 'picomatch'
import { hasMarkerBlocks, projectedContent } from './layout'
import { type CliSession, type LocalInventory, loadRemoteManifest } from './session'

export interface PlanBundle {
  plan: SyncPlan
  surfaces: Map<string, Surface>
  inventory: LocalInventory
  base: Manifest | null
  remote: Manifest | null
  head: string | null
}

export function readLedger(state: SyncState): ConflictLedger {
  const raw = state.getMeta(CONFLICT_LEDGER_META_KEY)
  if (raw === null) return new ConflictLedger()
  try {
    return ConflictLedger.fromJSON(raw)
  } catch {
    return new ConflictLedger()
  }
}

/** The local manifest, with marker projections hashed the way uploads are. */
export function localManifestWithProjections(inventory: LocalInventory): Manifest {
  const entries: ManifestEntry[] = []
  for (const entry of inventory.scan.manifest.entries) {
    const surface = inventory.surfaces.get(entry.surfaceId)
    if (surface === undefined) continue
    if (!hasMarkerBlocks(surface, entry.path)) {
      entries.push(entry)
      continue
    }
    const scanned = inventory.byStorePath.get(entry.path)
    if (scanned === undefined) continue
    let raw: string
    try {
      raw = fs.readFileSync(scanned.localPath, 'utf8')
    } catch {
      continue
    }
    const projection = projectedContent(surface, scanned.localPath, raw)
    entries.push({
      ...entry,
      hash: hashContent(projection),
      size: Buffer.byteLength(projection),
    })
  }
  return { ...inventory.scan.manifest, entries }
}

export interface PlanOptions {
  state: SyncState
  /** Ignore globs from the device policy. */
  ignore: readonly string[]
  /** Match the engine's `--prune` run: missing roots and gone ignored paths read as deletions. */
  prune?: boolean
  localOverride?: Manifest
}

export async function buildPlan(
  session: CliSession,
  inventory: LocalInventory,
  options: PlanOptions,
): Promise<PlanBundle> {
  const state = options.state
  const baseId = state.getBaseRevision()
  const base = baseId === null ? null : state.getManifest(baseId)
  const view = await loadRemoteManifest(session, baseId)
  const remote = view.manifest ?? base
  const ledger = readLedger(state)
  const prune = options.prune === true
  const ignores = options.ignore.map((pattern) => pm(pattern, { dot: true }))
  const present = new Set<string>()
  for (const entry of inventory.scan.manifest.entries) present.add(entry.path)
  const ignoreProtects = (storePath: string): boolean =>
    ignores.some((matches) => matches(storePath)) && (!prune || present.has(storePath))
  const local = options.localOverride ?? localManifestWithProjections(inventory)
  const plan = computeSyncPlan({
    base,
    local,
    remote,
    exclude: (storePath) => ledger.isExcluded(storePath) || ignoreProtects(storePath),
  })
  const missingRoots = new Set<string>()
  for (const report of inventory.scan.surfaces) {
    if (!report.exists) missingRoots.add(report.surfaceId)
  }
  const active = plan.files.filter((file) => {
    if (!inventory.surfaces.has(file.surfaceId)) return false
    // The engine carries a missing root's entries forward; the dry run must not
    // offer a deletion this run would refuse.
    if (!prune && file.resolution === 'delete-remote' && missingRoots.has(file.surfaceId)) {
      return false
    }
    return true
  })
  plan.files = active
  const filePaths = new Set(active.map((file) => file.storePath))
  plan.ops = plan.ops.filter((op) => filePaths.has(op.storePath))
  return { plan, surfaces: inventory.surfaces, inventory, base, remote, head: view.head }
}

export interface DriftEntry {
  storePath: string
  status: 'new' | 'changed' | 'deleted'
}

/** Local files that differ from the last synced revision. Pure over two manifests. */
export function computeDrift(
  local: Manifest,
  base: Manifest | null,
  activeSurfaceIds?: ReadonlySet<string>,
): DriftEntry[] {
  const baseByPath = new Map<string, ManifestEntry>()
  for (const entry of base?.entries ?? []) {
    if (activeSurfaceIds !== undefined && !activeSurfaceIds.has(entry.surfaceId)) continue
    baseByPath.set(entry.path, entry)
  }
  const localByPath = new Map<string, ManifestEntry>()
  for (const entry of local.entries) {
    if (activeSurfaceIds !== undefined && !activeSurfaceIds.has(entry.surfaceId)) continue
    localByPath.set(entry.path, entry)
  }
  const drift: DriftEntry[] = []
  for (const [storePath, entry] of localByPath) {
    const previous = baseByPath.get(storePath)
    if (previous === undefined || previous.kind === 'tombstone') {
      drift.push({ storePath, status: 'new' })
      continue
    }
    if (previous.hash !== entry.hash) drift.push({ storePath, status: 'changed' })
  }
  for (const [storePath, previous] of baseByPath) {
    if (previous.kind !== 'tombstone' && !localByPath.has(storePath)) {
      drift.push({ storePath, status: 'deleted' })
    }
  }
  return drift.sort((a, b) => a.storePath.localeCompare(b.storePath))
}

export function planSummary(plan: SyncPlan): Record<FileResolution, number> {
  const summary: Record<FileResolution, number> = {
    unchanged: 0,
    upload: 0,
    download: 0,
    merge: 0,
    'delete-local': 0,
    'delete-remote': 0,
  }
  for (const file of plan.files) summary[file.resolution] += 1
  return summary
}
