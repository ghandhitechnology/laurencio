import path from 'node:path'
import type { Platform } from './types'

export type PathErrorCode =
  | 'unknown-token'
  | 'unresolved-token'
  | 'relative-path'
  | 'unrepresentable'
  | 'escaped-path'

export class PathError extends Error {
  readonly code: PathErrorCode

  constructor(code: PathErrorCode, message: string) {
    super(message)
    this.name = 'PathError'
    this.code = code
  }
}

/** Everything token expansion needs. Assembled once at the CLI edge, then passed down pure. */
export interface TokenEnv {
  home: string
  platform: Platform
  env: Record<string, string | undefined>
}

const braced = (name: string): string => `\${${name}}`

const XDG_CONFIG_HOME = braced('XDG_CONFIG_HOME')
const CODEX_HOME = braced('CODEX_HOME')
const CLAUDE_CONFIG_DIR = braced('CLAUDE_CONFIG_DIR')
const HOME_TOKEN = '$HOME'
const APPDATA_TOKEN = '%APPDATA%'

export const PATH_TOKENS: readonly string[] = [
  XDG_CONFIG_HOME,
  CODEX_HOME,
  CLAUDE_CONFIG_DIR,
  HOME_TOKEN,
  APPDATA_TOKEN,
]

const knownTokens = new Set(PATH_TOKENS)

export function tokenValue(token: string, tokenEnv: TokenEnv): string | undefined {
  switch (token) {
    case HOME_TOKEN:
      return tokenEnv.home
    case XDG_CONFIG_HOME:
      return tokenEnv.env.XDG_CONFIG_HOME ?? path.join(tokenEnv.home, '.config')
    case CODEX_HOME:
      return tokenEnv.env.CODEX_HOME ?? path.join(tokenEnv.home, '.codex')
    case CLAUDE_CONFIG_DIR:
      return tokenEnv.env.CLAUDE_CONFIG_DIR ?? path.join(tokenEnv.home, '.claude')
    case APPDATA_TOKEN:
      return tokenEnv.env.APPDATA
    default:
      return undefined
  }
}

/** Absoluteness follows the declared platform, not the host running the tests. */
function isAbsoluteForPlatform(value: string, platform: Platform): boolean {
  if (platform === 'win32') {
    return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  }
  return value.startsWith('/')
}

const tokenPattern = /\$\{([A-Za-z0-9_]+)\}|\$HOME|%APPDATA%/g

/** Expand a tokenized template into an absolute path. Throws rather than guessing. */
export function expand(template: string, tokenEnv: TokenEnv): string {
  const expanded = template.replace(tokenPattern, (match, name: string | undefined) => {
    const token = name === undefined ? match : `\${${name}}`
    const value = tokenValue(token, tokenEnv)
    if (value === undefined) {
      const code: PathErrorCode = knownTokens.has(token) ? 'unresolved-token' : 'unknown-token'
      throw new PathError(code, `cannot expand ${token} on this machine`)
    }
    return value
  })
  if (!isAbsoluteForPlatform(expanded, tokenEnv.platform)) {
    throw new PathError('relative-path', `expanded path is not absolute: ${template}`)
  }
  return tokenEnv.platform === 'win32' ? expanded.replace(/\//g, '\\') : path.normalize(expanded)
}

/**
 * Reverse of `expand`: pick the most specific token whose value contains the path.
 * Absolute paths are never allowed to reach storage, so a path no token covers throws.
 */
export function tokenize(absPath: string, tokenEnv: TokenEnv): string {
  if (!path.isAbsolute(absPath)) {
    throw new PathError('relative-path', `cannot tokenize a relative path: ${absPath}`)
  }
  const normalized = path.normalize(absPath)
  const candidates = PATH_TOKENS.map((token) => ({ token, value: tokenValue(token, tokenEnv) }))
    .filter((entry): entry is { token: string; value: string } => entry.value !== undefined)
    .sort((a, b) => b.value.length - a.value.length)
  for (const { token, value } of candidates) {
    const relative = path.relative(path.normalize(value), normalized)
    if (relative === '') return token
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
      continue
    }
    return `${token}/${relative.split(path.sep).join('/')}`
  }
  throw new PathError('unrepresentable', `no token covers absolute path: ${normalized}`)
}

/** Join a surface's tokenized root with a filesystem-relative path, rejecting escapes. */
export function joinStorePath(root: string, relative: string): string {
  const normalizedRoot = root.replace(/[/\\]+$/, '')
  if (relative === '') return normalizedRoot
  if (path.isAbsolute(relative) || relative.startsWith('/') || relative.startsWith('\\')) {
    throw new PathError('escaped-path', `relative path escapes its surface: ${relative}`)
  }
  const segments = relative.split(/[\\/]+/)
  if (segments.some((segment) => segment === '' || segment === '..' || segment === '.')) {
    throw new PathError('escaped-path', `relative path escapes its surface: ${relative}`)
  }
  return `${normalizedRoot}/${segments.join('/')}`
}
