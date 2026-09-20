/**
 * Store path to local path resolution, shared by diff, restore, and the dry-run
 * planner. Mirrors the engine's rule: a scanned path wins, then the surface root
 * expands and the relative part joins it.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  expand,
  hashContent,
  type ScannedEntry,
  type Surface,
  stripLocalBlocks,
  type TokenEnv,
  usesMarkerBlocks,
} from '@laurencio/core'
import type { CommandContext } from './context'
import { cliError } from './errors'

export function tokenEnvFor(ctx: CommandContext): TokenEnv {
  return { home: ctx.home, platform: ctx.platform, env: ctx.env }
}

export function localPathForStorePath(
  surfaces: ReadonlyMap<string, Surface>,
  byStorePath: ReadonlyMap<string, ScannedEntry>,
  ctx: CommandContext,
  storePath: string,
): string | null {
  const scanned = byStorePath.get(storePath)
  if (scanned !== undefined) return scanned.localPath
  const tokenEnv = tokenEnvFor(ctx)
  for (const surface of [...surfaces.values()].sort((a, b) => b.path.length - a.path.length)) {
    const root = surface.path.replace(/[/\\]+$/, '')
    if (storePath === root) return expand(root, tokenEnv)
    if (!storePath.startsWith(`${root}/`)) continue
    const relative = storePath.slice(root.length + 1)
    return path.join(expand(root, tokenEnv), ...relative.split('/'))
  }
  return null
}

export function surfaceIdForStorePath(
  surfaces: ReadonlyMap<string, Surface>,
  byStorePath: ReadonlyMap<string, ScannedEntry>,
  storePath: string,
): string | null {
  const scanned = byStorePath.get(storePath)
  if (scanned !== undefined) return scanned.surfaceId
  for (const surface of surfaces.values()) {
    const root = surface.path.replace(/[/\\]+$/, '')
    if (storePath === root || storePath.startsWith(`${root}/`)) return surface.id
  }
  return null
}

export function hasMarkerBlocks(surface: Surface | undefined, filePath: string): boolean {
  return usesMarkerBlocks(surface, filePath)
}

/** The upload projection of a local file: marker blocks leave, the rest stays. */
export function projectedContent(
  surface: Surface | undefined,
  localPath: string,
  raw: string,
): string {
  if (!hasMarkerBlocks(surface, localPath)) return raw
  return stripLocalBlocks(localPath, raw)
}

export interface LocalFileState {
  localPath: string
  exists: boolean
  content: string | null
  hash: string | null
}

export function readLocalFile(
  surfaces: ReadonlyMap<string, Surface>,
  byStorePath: ReadonlyMap<string, ScannedEntry>,
  ctx: CommandContext,
  storePath: string,
): LocalFileState | null {
  const localPath = localPathForStorePath(surfaces, byStorePath, ctx, storePath)
  if (localPath === null) return null
  let raw: string
  try {
    raw = fs.readFileSync(localPath, 'utf8')
  } catch {
    return { localPath, exists: false, content: null, hash: null }
  }
  const surface = surfaces.get(surfaceIdForStorePath(surfaces, byStorePath, storePath) ?? '')
  const content = projectedContent(surface, localPath, raw)
  return { localPath, exists: true, content, hash: hashContent(content) }
}

/** Keeps selector matching in one place for diff, restore, and resolve. */
export function selectorMatches(selector: string, storePath: string): boolean {
  return storePath === selector || storePath.startsWith(`${selector}/`)
}

export function requireLocalPath(localPath: string | null, storePath: string): string {
  if (localPath === null) {
    throw cliError('unknown-path', `no declared local path for ${storePath}`)
  }
  return localPath
}
