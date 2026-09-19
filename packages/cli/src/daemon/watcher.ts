/**
 * File watching over the enabled surfaces. One recursive watch per distinct
 * surface root, coalesced by a debounce window so a harness writing twenty
 * files in a burst schedules one sync, not twenty. Watchers are only a hint:
 * the engine's quiescence gate still decides what may be replaced.
 */

import fs from 'node:fs'
import path from 'node:path'
import { type AdapterContext, expand, type HarnessAdapter } from '@laurencio/core'

export const DEFAULT_DEBOUNCE_MS = 750

function statOrNull(candidate: string): fs.Stats | null {
  try {
    return fs.statSync(candidate)
  } catch {
    return null
  }
}

/**
 * Watchable roots are existing directories, so a file surface contributes its
 * parent and a missing tree contributes its nearest existing ancestor. The home
 * directory is never a root: `~/.laurencio` state churn would trigger syncs, so
 * a surface that resolves directly under home (like `~/.claude.json`) relies on
 * the interval instead.
 */
function rootFor(
  kind: 'tree' | 'file' | 'keyed-file',
  resolvedPath: string,
  home: string,
): string | null {
  if (kind === 'tree') {
    let candidate = resolvedPath
    for (;;) {
      const stats = statOrNull(candidate)
      if (stats !== null) {
        return stats.isDirectory() ? candidate : null
      }
      const parent = path.dirname(candidate)
      if (parent === candidate || parent === home) return null
      candidate = parent
    }
  }
  const parent = path.dirname(resolvedPath)
  if (parent === home) return null
  return statOrNull(parent)?.isDirectory() === true ? parent : null
}

/** Resolved watch roots for the adapters that are active on this device. */
export function surfaceWatchRoots(
  adapters: readonly HarnessAdapter[],
  ctx: AdapterContext,
): string[] {
  const roots = new Set<string>()
  for (const adapter of adapters) {
    for (const surface of adapter.surfaces(ctx)) {
      if (surface.policy === 'never') continue
      let resolved: string
      try {
        resolved = expand(surface.path, ctx)
      } catch {
        // A surface the platform cannot resolve cannot be watched.
        continue
      }
      const root = rootFor(surface.kind, resolved, ctx.home)
      if (root !== null) roots.add(root)
    }
  }
  const sorted = [...roots].sort()
  return sorted.filter(
    (root, index) =>
      !sorted.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          root.startsWith(`${other}${path.sep}`) &&
          other.length < root.length,
      ),
  )
}

export type WatchListener = (event: string, filename: string | Buffer | null) => void
export type WatchFn = (
  path: string,
  options: { recursive: boolean },
  listener: WatchListener,
) => fs.FSWatcher

export interface WatcherOptions {
  roots: readonly string[]
  debounceMs?: number
  onChange: () => void
  /** Test lever; defaults to `node:fs.watch`. */
  watch?: WatchFn
  onError?: (message: string) => void
}

export interface SurfaceWatcher {
  readonly roots: string[]
  close(): void
}

/** Starts one watcher per root and debounces every event into `onChange`. */
export function startSurfaceWatchers(options: WatcherOptions): SurfaceWatcher {
  const watch =
    options.watch ?? ((target, watchOptions, listener) => fs.watch(target, watchOptions, listener))
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const watchers: fs.FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const fire = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      options.onChange()
    }, debounceMs)
  }

  for (const root of options.roots) {
    let watcher: fs.FSWatcher
    try {
      watcher = watch(root, { recursive: true }, () => fire())
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      options.onError?.(`cannot watch ${root}: ${reason}`)
      continue
    }
    watcher.on('error', (error) => {
      options.onError?.(`watcher error on ${root}: ${error.message}`)
    })
    watchers.push(watcher)
  }

  return {
    roots: [...options.roots],
    close() {
      if (timer !== null) clearTimeout(timer)
      timer = null
      for (const watcher of watchers) watcher.close()
      watchers.length = 0
    },
  }
}
