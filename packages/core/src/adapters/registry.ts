import type { AdapterContext, HarnessAdapter, Surface } from '../types'
import { claudeAdapter } from './claude'
import { codexAdapter } from './codex'
import { opencodeAdapter } from './opencode'
import type { RegisteredSurface } from './types'

/** Adapters shipped with the CLI. Each adapter phase appends its own. */
export const builtinAdapters: readonly HarnessAdapter[] = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
]

export type AdapterRegistryErrorKind = 'duplicate-adapter' | 'duplicate-surface' | 'duplicate-path'

export class AdapterRegistryError extends Error {
  readonly kind: AdapterRegistryErrorKind
  readonly ids: string[]
  readonly paths: string[]

  constructor(kind: AdapterRegistryErrorKind, ids: string[], paths: string[]) {
    const detail = paths.length > 0 ? `${ids.join(', ')} at ${paths.join(', ')}` : ids.join(', ')
    super(`${kind}: ${detail}`)
    this.name = 'AdapterRegistryError'
    this.kind = kind
    this.ids = ids
    this.paths = paths
  }
}

export interface AdapterRegistry {
  readonly adapters: readonly HarnessAdapter[]
  /** Declared surfaces for one context, sorted by surface id. Validates ids and declared paths. */
  inventory(ctx: AdapterContext): RegisteredSurface[]
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const repeated = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) repeated.add(value)
    seen.add(value)
  }
  return [...repeated].sort()
}

/**
 * A shared tree declares that another surface owns the same physical path, so a shared
 * declaration never collides with the direct owner. Two direct declarations do.
 */
function duplicatePaths(registered: readonly RegisteredSurface[]): {
  ids: string[]
  paths: string[]
} {
  const groups = new Map<string, RegisteredSurface[]>()
  for (const entry of registered) {
    const group = groups.get(entry.surface.path)
    if (group === undefined) groups.set(entry.surface.path, [entry])
    else group.push(entry)
  }
  const ids: string[] = []
  const paths: string[] = []
  for (const [declaredPath, group] of groups) {
    const direct = group.filter((entry) => !isSharedTree(entry.surface))
    if (direct.length > 1) {
      paths.push(declaredPath)
      for (const entry of direct) ids.push(entry.surface.id)
    }
  }
  return { ids: [...ids].sort(), paths: [...paths].sort() }
}

/** A shared tree declares that another surface may own the same physical path. */
function isSharedTree(surface: Surface): boolean {
  return surface.kind === 'tree' && surface.shared === true
}

export function createAdapterRegistry(adapters: readonly HarnessAdapter[]): AdapterRegistry {
  const duplicateAdapters = duplicates(adapters.map((adapter) => adapter.id))
  if (duplicateAdapters.length > 0) {
    throw new AdapterRegistryError('duplicate-adapter', duplicateAdapters, [])
  }
  return {
    adapters: [...adapters],
    inventory(ctx) {
      const registered: RegisteredSurface[] = []
      for (const adapter of adapters) {
        for (const surface of adapter.surfaces(ctx)) registered.push({ adapter, surface })
      }
      const byId = new Map<string, RegisteredSurface>()
      for (const entry of registered) {
        if (byId.has(entry.surface.id)) {
          throw new AdapterRegistryError('duplicate-surface', [entry.surface.id], [])
        }
        byId.set(entry.surface.id, entry)
      }
      const duplicates = duplicatePaths(registered)
      if (duplicates.paths.length > 0) {
        throw new AdapterRegistryError('duplicate-path', duplicates.ids, duplicates.paths)
      }
      return registered.sort((a, b) =>
        a.surface.id < b.surface.id ? -1 : a.surface.id > b.surface.id ? 1 : 0,
      )
    },
  }
}
