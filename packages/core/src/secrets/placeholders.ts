/**
 * Env indirection for MCP definitions.
 *
 * Where a harness expands environment variables natively, the secret value is
 * replaced by that harness's syntax and the real value never enters the
 * projection. Where it does not, the value is handed back to the caller as a
 * `MovedSecret` for the device-local secret store, and a placeholder token
 * takes its place so the projection stays self-describing.
 */

import type { HarnessId } from '../types'
import { allowlistReason, looksLikeHighEntropySecret, scanLineMatches } from './patterns'

export type Indirection = 'claude' | 'opencode' | 'literal'

export interface MovedSecret {
  /** Keychain account name, stable across devices. */
  name: string
  /** Store-relative path the value came from, for the override and audit log. */
  path: string
  value: string
}

export function indirectionFor(harness: HarnessId): Indirection {
  if (harness === 'claude') return 'claude'
  if (harness === 'opencode') return 'opencode'
  return 'literal'
}

export const PLACEHOLDER_PREFIX = 'laurencio:secret:'

export function placeholderToken(name: string): string {
  return `${PLACEHOLDER_PREFIX}${name}`
}

export function isPlaceholder(value: string): boolean {
  return value.startsWith(PLACEHOLDER_PREFIX)
}

export function placeholderName(value: string): string | null {
  return isPlaceholder(value) ? value.slice(PLACEHOLDER_PREFIX.length) : null
}

/** Resolves a placeholder against a lookup; used on apply, never on upload. */
export function resolvePlaceholder(
  value: string,
  lookup: (name: string) => string | undefined,
): string | undefined {
  const name = placeholderName(value)
  if (name === null) return value
  return lookup(name)
}

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function envVarName(scope: string, key: string): string {
  const normalized = `${scope}_${key}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  return ENV_NAME_PATTERN.test(normalized) ? normalized : `MCP_${normalized}`
}

function nativeReference(harness: HarnessId, envName: string): string | null {
  const indirection = indirectionFor(harness)
  if (indirection === 'claude') return `\${${envName}}`
  if (indirection === 'opencode') return `{env:${envName}}`
  return null
}

export interface RewriteContext {
  /** Store-relative path of the file holding the value. */
  path: string
  /** Keychain account prefix, for example the MCP server name. */
  scope: string
}

export interface RewriteOutcome {
  value: string
  moved: MovedSecret | null
}

/** True when a value already carries a secret, by shape or by entropy. */
export function looksLikeSecretValue(value: string): boolean {
  return looksLikeHighEntropySecret(value) || scanLineMatches(value).length > 0
}

/**
 * Rewrites one MCP env or header value. Values that are already indirected, or
 * that are already placeholders, pass through. A literal that does not look
 * like a secret is left alone, so ordinary settings like `LOG_LEVEL` are not
 * rewritten into indirection they do not need.
 */
export function rewriteValue(
  harness: HarnessId,
  context: RewriteContext,
  key: string,
  value: string,
): RewriteOutcome {
  if (isPlaceholder(value)) return { value, moved: null }
  if (value.includes('${') || value.includes('{env:')) return { value, moved: null }
  if (!looksLikeSecretValue(value) || allowlistReason(value) !== null) return { value, moved: null }
  const envName = envVarName(context.scope, key)
  const reference = nativeReference(harness, envName)
  if (reference !== null) return { value: reference, moved: null }
  return {
    value: placeholderToken(envName),
    moved: { name: envName, path: context.path, value },
  }
}

export interface RewriteResult<T> {
  values: T
  moved: MovedSecret[]
}

export function rewriteEnv(
  harness: HarnessId,
  context: RewriteContext,
  env: Record<string, string>,
): RewriteResult<Record<string, string>> {
  const values: Record<string, string> = {}
  const moved: MovedSecret[] = []
  for (const [key, value] of Object.entries(env)) {
    const outcome = rewriteValue(harness, context, key, value)
    values[key] = outcome.value
    if (outcome.moved !== null) moved.push(outcome.moved)
  }
  return { values, moved }
}

/** Header names are not env names, so they are namespaced before indirection. */
export function rewriteHeaders(
  harness: HarnessId,
  context: RewriteContext,
  headers: Record<string, string>,
): RewriteResult<Record<string, string>> {
  const values: Record<string, string> = {}
  const moved: MovedSecret[] = []
  for (const [key, value] of Object.entries(headers)) {
    const outcome = rewriteValue(harness, context, `header_${key}`, value)
    values[key] = outcome.value
    if (outcome.moved !== null) moved.push(outcome.moved)
  }
  return { values, moved }
}
