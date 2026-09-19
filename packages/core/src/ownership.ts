import fs from 'node:fs'
import path from 'node:path'
import type { SurfaceId } from '@laurencio/protocol'
import type { RegisteredSurface } from './adapters/types'
import { expand, type TokenEnv } from './paths'

/** A harness referencing a physical tree another surface owns. */
export interface OwnershipRef {
  surfaceId: SurfaceId
  resolvedPath: string
  referencedBy: SurfaceId[]
}

export interface ResolvedSurface {
  registered: RegisteredSurface
  /** Absolute path as declared, with tokens expanded. */
  declaredPath: string
  /** Physical path after following symlinks. Equal to `declaredPath` when nothing links. */
  resolvedPath: string
  exists: boolean
  /** True when the surface root itself is a symlink, not merely under a linked ancestor. */
  rootIsSymlink: boolean
  role: 'owner' | 'reference'
  /** The surface that owns the physical content: self for owners, the owner id for references. */
  owner: SurfaceId
  linkedBy: SurfaceId[]
}

export interface OwnershipResult {
  surfaces: ResolvedSurface[]
  refs: OwnershipRef[]
}

export type OwnershipCollisionReason = 'multiple-owners' | 'cycle'

export class OwnershipCollisionError extends Error {
  readonly resolvedPath: string
  readonly surfaceIds: SurfaceId[]
  readonly reason: OwnershipCollisionReason

  constructor(resolvedPath: string, surfaceIds: SurfaceId[], reason: OwnershipCollisionReason) {
    super(`ownership ${reason} at ${resolvedPath}: ${surfaceIds.join(', ')}`)
    this.name = 'OwnershipCollisionError'
    this.resolvedPath = resolvedPath
    this.surfaceIds = surfaceIds
    this.reason = reason
  }
}

interface PhysicalPath {
  declaredPath: string
  resolvedPath: string
  exists: boolean
  rootIsSymlink: boolean
}

function resolvePhysical(declaredPath: string): PhysicalPath {
  let rootIsSymlink = false
  try {
    rootIsSymlink = fs.lstatSync(declaredPath).isSymbolicLink()
  } catch {
    rootIsSymlink = false
  }
  try {
    return {
      declaredPath,
      resolvedPath: fs.realpathSync(declaredPath),
      exists: true,
      rootIsSymlink,
    }
  } catch {
    // Missing root or broken link: keep the declared path, but follow one lexical link hop
    // so a dangling link still points at the tree it means to reference.
    let resolvedPath = declaredPath
    try {
      resolvedPath = path.resolve(path.dirname(declaredPath), fs.readlinkSync(declaredPath))
    } catch {
      resolvedPath = declaredPath
    }
    return { declaredPath, resolvedPath, exists: false, rootIsSymlink }
  }
}

function containsPath(parent: string, candidate: string): boolean {
  return candidate !== parent && candidate.startsWith(parent + path.sep)
}

function mostSpecificContainer(
  owners: readonly ResolvedSurface[],
  surface: ResolvedSurface,
): ResolvedSurface | undefined {
  let best: ResolvedSurface | undefined
  for (const candidate of owners) {
    if (candidate === surface) continue
    if (!containsPath(candidate.resolvedPath, surface.resolvedPath)) continue
    if (best === undefined || candidate.resolvedPath.length > best.resolvedPath.length) {
      best = candidate
    }
  }
  return best
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Election rank for surfaces sharing one physical path. A direct declaration outranks a link;
 * a non-shared declaration outranks a shared one, which explicitly gives up ownership.
 */
function rank(surface: ResolvedSurface): number {
  const linked = surface.rootIsSymlink ? 1 : 0
  const declared = surface.registered.surface
  const shared = declared.kind === 'tree' && declared.shared === true
  return linked + (shared ? 2 : 0)
}

export function resolveOwnership(
  registered: readonly RegisteredSurface[],
  tokenEnv: TokenEnv,
): OwnershipResult {
  const surfaces: ResolvedSurface[] = registered.map((entry) => {
    const physical = resolvePhysical(expand(entry.surface.path, tokenEnv))
    return {
      registered: entry,
      declaredPath: physical.declaredPath,
      resolvedPath: physical.resolvedPath,
      exists: physical.exists,
      rootIsSymlink: physical.rootIsSymlink,
      role: 'owner',
      owner: entry.surface.id,
      linkedBy: [],
    }
  })

  const groups = new Map<string, ResolvedSurface[]>()
  for (const surface of surfaces) {
    const group = groups.get(surface.resolvedPath)
    if (group === undefined) groups.set(surface.resolvedPath, [surface])
    else group.push(surface)
  }

  for (const [resolvedPath, group] of groups) {
    if (group.length === 1) continue
    const ordered = [...group].sort((a, b) => rank(a) - rank(b))
    const owner = ordered[0]
    const runnerUp = ordered[1]
    if (owner === undefined || runnerUp === undefined) continue
    if (rank(owner) === rank(runnerUp)) {
      const ids = group.map((surface) => surface.registered.surface.id).sort()
      throw new OwnershipCollisionError(resolvedPath, ids, 'multiple-owners')
    }
    for (const surface of group) {
      if (surface === owner) continue
      surface.role = 'reference'
      surface.owner = owner.registered.surface.id
    }
  }

  // A surface whose root is a link and lands inside another owned tree is a reference to
  // that tree, not a second owner of the files.
  const owners = surfaces.filter((surface) => surface.role === 'owner')
  for (const surface of surfaces) {
    if (surface.role !== 'owner') continue
    if (!surface.rootIsSymlink) continue
    const container = mostSpecificContainer(owners, surface)
    if (container === undefined || container === surface) continue
    surface.role = 'reference'
    surface.owner = container.registered.surface.id
  }

  const byId = new Map<SurfaceId, ResolvedSurface>(
    surfaces.map((surface) => [surface.registered.surface.id, surface]),
  )
  const ultimateOwner = (start: ResolvedSurface): SurfaceId => {
    let current = start
    const seen = new Set<SurfaceId>([start.registered.surface.id])
    while (current.role === 'reference') {
      const next = byId.get(current.owner)
      if (next === undefined || seen.has(next.registered.surface.id)) {
        throw new OwnershipCollisionError(current.resolvedPath, [...seen].sort(), 'cycle')
      }
      seen.add(next.registered.surface.id)
      current = next
    }
    return current.registered.surface.id
  }
  for (const surface of surfaces) {
    if (surface.role === 'reference') surface.owner = ultimateOwner(surface)
  }

  const refs = new Map<string, { surfaceId: SurfaceId; resolvedPath: string; by: Set<SurfaceId> }>()
  for (const surface of surfaces) {
    if (surface.role !== 'reference') continue
    const key = `${surface.owner}|${surface.resolvedPath}`
    let ref = refs.get(key)
    if (ref === undefined) {
      ref = { surfaceId: surface.owner, resolvedPath: surface.resolvedPath, by: new Set() }
      refs.set(key, ref)
    }
    ref.by.add(surface.registered.surface.id)
  }
  const refList: OwnershipRef[] = [...refs.values()]
    .map((ref) => ({
      surfaceId: ref.surfaceId,
      resolvedPath: ref.resolvedPath,
      referencedBy: [...ref.by].sort(),
    }))
    .sort(
      (a, b) =>
        compareStrings(a.surfaceId, b.surfaceId) || compareStrings(a.resolvedPath, b.resolvedPath),
    )
  for (const ref of refList) {
    const owner = byId.get(ref.surfaceId)
    if (owner !== undefined) owner.linkedBy = [...ref.referencedBy]
  }

  surfaces.sort((a, b) => compareStrings(a.registered.surface.id, b.registered.surface.id))
  return { surfaces, refs: refList }
}
