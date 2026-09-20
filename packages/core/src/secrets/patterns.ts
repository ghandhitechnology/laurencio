import { visit } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

/**
 * Key-shape rules for the pre-upload secret scanner.
 *
 * The rules are shape-based, plus one entropy heuristic for structured config
 * values where no known prefix exists. Every rule pairs with an allowlist so
 * public values that look random (hashes, public keys, docs examples, paths,
 * URLs) do not block a sync. `test/fixtures/secrets/corpus.json` is the
 * contract for both directions.
 */

export type SecretSeverity = 'high' | 'medium' | 'low'

export type SecretRuleId =
  | 'openai-key'
  | 'anthropic-key'
  | 'github-token'
  | 'github-pat'
  | 'slack-token'
  | 'aws-access-key'
  | 'bearer-token'
  | 'pem-private-key'
  | 'jwt'
  | 'entropy-string'
  | 'sensitive-field'

/** Field intent catches short or low-entropy credentials that shape rules cannot. */
export function isSensitiveSecretValue(key: string, value: string): boolean {
  const normalized = key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/-/g, '_')
    .toLowerCase()
  if (
    !/^(?:authorization|proxy_authorization|cookie|set_cookie|api_key|apikey|password|passwd|secret|token|private_key|.*_(?:api_key|apikey|password|passwd|secret|token))$/.test(
      normalized,
    )
  )
    return false
  if (
    value.trim() === '' ||
    /\$\{[A-Za-z_][A-Za-z0-9_]*\}|\{env:[A-Za-z_][A-Za-z0-9_]*\}/.test(value) ||
    value.startsWith('laurencio:secret:')
  )
    return false
  // Explicit documentation placeholders are public; a digest-shaped API key is not.
  const reason = allowlistReason(value)
  return reason?.startsWith('marker:') !== true && !/^(?:<[^>]+>|\{\{.*\}\})$/.test(value)
}

export interface SecretFinding {
  path: string
  line?: number
  rule: SecretRuleId
  /** Always redacted. The raw secret never leaves this module. */
  match: string
  severity: SecretSeverity
}

export interface SecretRule {
  id: SecretRuleId
  severity: SecretSeverity
  pattern: RegExp
}

/** Order matters only for reporting; the scanner reports every rule that fires. */
export const SECRET_RULES: SecretRule[] = [
  {
    id: 'anthropic-key',
    severity: 'high',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  },
  {
    id: 'openai-key',
    severity: 'high',
    pattern: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g,
  },
  {
    id: 'github-pat',
    severity: 'high',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  },
  {
    id: 'github-token',
    severity: 'high',
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}/g,
  },
  {
    id: 'slack-token',
    severity: 'high',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  },
  {
    id: 'aws-access-key',
    severity: 'high',
    pattern: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA|AGPA)[A-Z0-9]{16}\b/g,
  },
  {
    id: 'bearer-token',
    severity: 'high',
    pattern: /\bBearer\s+(?!\$\{|\{env:|\{\{|<)[A-Za-z0-9._~+/-]{20,}=*/g,
  },
  {
    id: 'jwt',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
]

const PEM_PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g

export const ENTROPY_MIN_LENGTH = 24
export const ENTROPY_MAX_LENGTH = 512
export const ENTROPY_THRESHOLD_BITS = 3.6

export type StructuredFormat = 'json' | 'jsonc' | 'toml'

export function structuredFormat(path: string): StructuredFormat | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.json')) return 'json'
  if (lower.endsWith('.jsonc')) return 'jsonc'
  if (lower.endsWith('.toml')) return 'toml'
  return null
}

export function shannonEntropy(value: string): number {
  const counts = new Map<string, number>()
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1)
  let bits = 0
  for (const count of counts.values()) {
    const probability = count / value.length
    bits -= probability * Math.log2(probability)
  }
  return bits
}

export function characterClasses(value: string): number {
  let classes = 0
  if (/[a-z]/.test(value)) classes += 1
  if (/[A-Z]/.test(value)) classes += 1
  if (/[0-9]/.test(value)) classes += 1
  if (/[^A-Za-z0-9]/.test(value)) classes += 1
  return classes
}

const ALLOWLIST_MARKERS = [
  'example',
  'placeholder',
  'changeme',
  'change-me',
  'your-',
  'your_',
  'yourtoken',
  'not-a-real',
  'notreal',
  'redacted',
  'dummy',
  'sample',
  'fake',
  'xxxx',
  'abcd1234',
]

const ALLOWLIST_PATTERNS: RegExp[] = [
  // Digests and object ids: sha1, sha256, sha512, and SRI integrity strings.
  /^[0-9a-f]{40}$/i,
  /^[0-9a-f]{64}$/i,
  /^[0-9a-f]{128}$/i,
  /^sha1:[0-9a-f]{40}$/i,
  /^sha256:[0-9a-f]{64}$/i,
  /^sha512:[0-9a-f]{128}$/i,
  /^[0-9a-f]{64}(?:,[0-9a-f]{64})+$/i,
  /^sha(?:256|384|512)-[A-Za-z0-9+/=]{20,}$/,
  // UUIDs.
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  // Public keys and certificates.
  /^ssh-(?:rsa|ed25519|ecdsa)\s+[A-Za-z0-9+/=]{40,}/,
  /^ecdsa-sha2-[A-Za-z0-9-]+\s+[A-Za-z0-9+/=]{40,}/,
  /^-----BEGIN (?:PUBLIC KEY|CERTIFICATE|RSA PUBLIC KEY)-----/,
  /^data:[a-z/+.-]+;base64,/,
  // Template and indirection syntax: harness-native expansion or our own placeholders.
  /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^\{env:[A-Za-z_][A-Za-z0-9_]*\}$/,
  /^\{\{.*\}\}$/,
  /^<[^>]+>$/,
  /^%[sdv]/,
  /^laurencio:secret:[A-Za-z0-9_.-]+$/,
  // Kebab-case identifiers: model ids, plugin names, feature flags. Lowercase
  // only, which random secrets almost never are, and at least three segments.
  /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/,
  // Environment variable names used as values. Must contain an underscore, so
  // an all-uppercase random key is not waved through.
  /^[A-Z][A-Z0-9]*_[A-Z0-9_]*$/,
  // Absolute paths and XDG-style locations.
  /^(?:~\/|\$HOME|\$\{[A-Z_]+\}|\/|[A-Za-z]:\\|\\\\)[^\s]*$/,
  // Relative paths: at least two segments, no base64 alphabet markers.
  /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+){1,}$/,
  // iCalendar recurrence values stored in Codex automation definitions.
  /^(?:DTSTART(?:;TZID=[A-Za-z0-9/_+-]+)?:\d{8}T\d{6}Z?(?:\\n|\r?\n))?RRULE:[A-Z]+=[A-Z0-9,+-]+(?:;[A-Z]+=[A-Z0-9,+-]+)*$/,
]

const URL_PATTERN = /^(?:https?|file|git\+https?|ssh|s3|gs):\/\/\S+$/

/** Query parameters and userinfo that turn an ordinary URL into a credential. */
const URL_SECRET_MARKERS =
  /(?:@[^/]*:)|[?&](?:token|key|secret|sig|signature|auth|access_token|api_key|apikey|password)=/i

export function allowlistReason(value: string): string | null {
  const lowered = value.toLowerCase()
  for (const marker of ALLOWLIST_MARKERS) {
    if (lowered.includes(marker)) return `marker:${marker}`
  }
  for (const pattern of ALLOWLIST_PATTERNS) {
    if (pattern.test(value)) return 'shape'
  }
  if (URL_PATTERN.test(value) && !URL_SECRET_MARKERS.test(value)) return 'url'
  return null
}

/**
 * The entropy heuristic for JSON and TOML string values. Deliberately narrow:
 * a candidate must be long, space-free, high-entropy, and mixed-class, and must
 * survive the allowlist. False negatives here are covered by the shape rules.
 */
export function looksLikeHighEntropySecret(value: string): boolean {
  if (value.length < ENTROPY_MIN_LENGTH || value.length > ENTROPY_MAX_LENGTH) return false
  if (/\s/.test(value)) return false
  if (characterClasses(value) < 3) return false
  if (shannonEntropy(value) < ENTROPY_THRESHOLD_BITS) return false
  return allowlistReason(value) === null
}

/** Redaction keeps at most eight real characters, never a usable secret. */
export function redact(value: string): string {
  const firstLine = value.split('\n', 1)[0] ?? value
  if (firstLine.startsWith('-----BEGIN')) return `${firstLine} ...`
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}...${value.slice(-4)}`
}

export interface LineMatch {
  rule: SecretRuleId
  severity: SecretSeverity
  match: string
}

export interface RawLineMatch {
  rule: SecretRuleId
  severity: SecretSeverity
  raw: string
}

/** Raw (unredacted) matches, for callers that need to reason about overlap. */
export function scanLineRawMatches(line: string): RawLineMatch[] {
  const matches: RawLineMatch[] = []
  for (const rule of SECRET_RULES) {
    for (const match of line.matchAll(rule.pattern)) {
      const text = match[0]
      if (allowlistReason(text) !== null) continue
      matches.push({ rule: rule.id, severity: rule.severity, raw: text })
    }
  }
  for (const match of line.matchAll(PEM_PRIVATE_KEY)) {
    matches.push({ rule: 'pem-private-key', severity: 'high', raw: match[0] })
  }
  return matches
}

export function scanLineMatches(line: string): LineMatch[] {
  return scanLineRawMatches(line).map((match) => ({
    rule: match.rule,
    severity: match.severity,
    match: redact(match.raw),
  }))
}

export function entropyMatch(value: string): LineMatch | null {
  if (!looksLikeHighEntropySecret(value)) return null
  return { rule: 'entropy-string', severity: 'medium', match: redact(value) }
}

function lineOfOffset(content: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) line += 1
  }
  return line
}

/** Quoted string values in a structured config file, with their line numbers. */
export function structuredValues(
  content: string,
  format: StructuredFormat,
): { value: string; line: number; key?: string; referenceMap?: boolean }[] {
  const values: { value: string; line: number; key?: string; referenceMap?: boolean }[] = []
  if (format !== 'toml') {
    visit(
      content,
      {
        onLiteralValue(value, _offset, _length, startLine, _startCharacter, pathSupplier) {
          if (typeof value === 'string' && value.length > 0) {
            const parts = pathSupplier()
            const key = parts.at(-1)
            values.push({
              value,
              line: startLine + 1,
              ...(typeof key === 'string' ? { key } : {}),
              referenceMap: parts.at(-2) === 'env_http_headers',
            })
          }
        },
      },
      { allowTrailingComma: true, disallowComments: false },
    )
    return values
  }

  try {
    const walk = (value: unknown, parts: string[]): void => {
      if (typeof value === 'string' && value.length > 0) {
        const key = parts.at(-1)
        values.push({
          value,
          line: lineOfOffset(content, Math.max(0, content.indexOf(value))),
          ...(key === undefined ? {} : { key }),
          referenceMap: parts.at(-2) === 'env_http_headers',
        })
      } else if (Array.isArray(value)) for (const entry of value) walk(entry, [...parts, ''])
      else if (typeof value === 'object' && value !== null)
        for (const [key, entry] of Object.entries(value)) walk(entry, [...parts, key])
    }
    walk(parseToml(content), [])
    return values
  } catch {
    // Retain conservative scanning for incomplete TOML while users are editing it.
  }
  const pattern = /^[ \t]*([A-Za-z0-9_.-]+)[ \t]*=[ \t]*(["'])((?:\\.|(?!\2)[^\\])*)\2/gm
  for (const match of content.matchAll(pattern)) {
    const value = match[3]
    if (value === undefined || value.length === 0) continue
    values.push({
      value: value.replace(/\\"/g, '"'),
      line: lineOfOffset(content, match.index ?? 0),
      ...(match[1] === undefined ? {} : { key: match[1] }),
    })
  }
  return values
}
