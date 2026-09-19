/**
 * Applying `LocalLayout`: a declared path may be a symlink to the tree that
 * owns the content, and a Windows device has no usable links, so it keeps two
 * real copies instead. Resolution is read-only; link creation happens only
 * when the layout says the link belongs there.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_DIRECTORY_MODE, type LayoutEntry, type LocalLayout } from './model'
import type { Platform } from './types'

export interface LayoutTarget {
  /** Absolute path the plan names. */
  declaredPath: string
  /** Physical paths that receive content, in write order. */
  writePaths: string[]
  /** True when content lives behind a symlink rather than at the declared path. */
  viaLink: boolean
  /** Raw link value when the declared path or one of its ancestors is a symlink. */
  linkTarget: string | null
  /** True when the layout calls for a link but the path is currently missing it. */
  linkMissing: boolean
  /** Where the missing link belongs, when one is missing. */
  linkPath: string | null
  /** Windows-style path: real copies on both sides, no links. */
  copyMode: boolean
}

export interface ResolveLayoutOptions {
  declaredPath: string
  layout: LocalLayout | null
  platform: Platform
  /** Explicit override; defaults to true on win32. */
  copyMode?: boolean
}

export function copyModeFor(platform: Platform, copyMode?: boolean): boolean {
  return copyMode ?? platform === 'win32'
}

export function layoutEntryFor(
  layout: LocalLayout | null,
  declaredPath: string,
): LayoutEntry | null {
  if (layout === null) return null
  let candidate = declaredPath
  while (true) {
    const entry = layout.entries.find((item) => item.path === candidate)
    if (entry !== undefined) return entry
    const parent = path.dirname(candidate)
    if (parent === candidate) return null
    candidate = parent
  }
}

/** The layout's link destination for a declared path, ancestor-aware. */
function layoutTargetFor(entry: LayoutEntry | null, declaredPath: string): string | null {
  if (entry === null || entry.mode !== 'symlink' || entry.linkTarget === undefined) return null
  const root = path.resolve(path.dirname(entry.path), entry.linkTarget)
  const relative = path.relative(entry.path, declaredPath)
  if (relative === '') return root
  return path.join(root, relative)
}

function tryReadlink(candidate: string): string | null {
  try {
    return fs.readlinkSync(candidate)
  } catch {
    return null
  }
}

function tryRealpath(candidate: string): string | null {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return null
  }
}

/** Physical path from the deepest existing ancestor, so missing files resolve too. */
function physicalPathFor(declaredPath: string): string {
  const rest: string[] = []
  let current = declaredPath
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current)
    if (parent === current) break
    rest.unshift(path.basename(current))
    current = parent
  }
  const real = tryRealpath(current) ?? current
  return rest.length === 0 ? real : path.join(real, ...rest)
}

/** Raw readlink of the nearest symlinked component, for reporting. */
function nearestLink(declaredPath: string): string | null {
  let current = declaredPath
  while (true) {
    const raw = tryReadlink(current)
    if (raw !== null) return raw
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/** Resolves where content for one declared path is written. Never mutates the filesystem. */
export function resolveLayoutTarget(options: ResolveLayoutOptions): LayoutTarget {
  const declaredPath = path.resolve(options.declaredPath)
  const copyMode = copyModeFor(options.platform, options.copyMode)
  const entry = layoutEntryFor(options.layout, declaredPath)
  const physical = physicalPathFor(declaredPath)
  const linked = physical !== declaredPath
  const exists = fs.existsSync(declaredPath)

  if (linked) {
    return {
      declaredPath,
      writePaths: [physical],
      viaLink: true,
      linkTarget: nearestLink(declaredPath),
      linkMissing: false,
      linkPath: null,
      copyMode,
    }
  }

  const layoutTarget = layoutTargetFor(entry, declaredPath)
  if (layoutTarget !== null) {
    if (copyMode) {
      return {
        declaredPath,
        writePaths: distinct([declaredPath, layoutTarget]),
        viaLink: false,
        linkTarget: null,
        linkMissing: false,
        linkPath: null,
        copyMode,
      }
    }
    // The link can only be created where nothing real sits today.
    if (!exists && entry !== null && !fs.existsSync(entry.path)) {
      return {
        declaredPath,
        writePaths: [layoutTarget],
        viaLink: true,
        linkTarget: entry.linkTarget ?? null,
        linkMissing: true,
        linkPath: entry.path,
        copyMode,
      }
    }
  }

  return {
    declaredPath,
    writePaths: [declaredPath],
    viaLink: false,
    linkTarget: null,
    linkMissing: false,
    linkPath: null,
    copyMode,
  }
}

/** Creates the missing link the layout calls for. Returns false when it existed. */
export function ensureLayoutLink(target: LayoutTarget): boolean {
  if (!target.linkMissing || target.copyMode) return false
  if (target.linkTarget === null || target.linkPath === null) return false
  const destination = path.resolve(path.dirname(target.linkPath), target.linkTarget)
  fs.mkdirSync(path.dirname(target.linkPath), { recursive: true })
  try {
    fs.symlinkSync(destination, target.linkPath)
    return true
  } catch (error) {
    // A concurrent writer created the link first: that is the desired state.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
}

export function ensureParentDirectories(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DEFAULT_DIRECTORY_MODE })
}

function distinct(values: string[]): string[] {
  return [...new Set(values)]
}
