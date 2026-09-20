/**
 * Pre-upload scanning. Policy is fail closed: any finding blocks the whole
 * surface, and only an explicit override, recorded with its path and rule,
 * lets the caller proceed. The scanner never returns raw secret text.
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  entropyMatch,
  isSensitiveSecretValue,
  type SecretFinding,
  type SecretRuleId,
  scanLineMatches,
  scanLineRawMatches,
  structuredFormat,
  structuredValues,
} from './patterns'

/** The device-local directory that is never a sync surface. */
export const LAURENCIO_DIR = '.laurencio'

export interface ScanFile {
  /** Store-relative path, used for reporting only. */
  path: string
  content: string
}

export interface ScanReport {
  findings: SecretFinding[]
  /** Paths with at least one finding. A blocked surface is blocked whole. */
  blocked: string[]
  clean: boolean
}

export class SecretBlockedError extends Error {
  readonly findings: SecretFinding[]
  readonly blocked: string[]

  constructor(report: ScanReport) {
    const rules = [...new Set(report.findings.map((finding) => finding.rule))].sort()
    super(`secret scan blocked ${report.blocked.length} path(s) [${rules.join(', ')}]`)
    this.name = 'SecretBlockedError'
    this.findings = report.findings
    this.blocked = report.blocked
  }
}

export interface ScanOptions {
  /** Paths the user has explicitly overridden. Their findings are reported but do not block. */
  overrides?: string[]
}

function findingKey(finding: SecretFinding): string {
  return `${finding.path}\u0000${finding.line ?? 0}\u0000${finding.rule}\u0000${finding.match}`
}

export function scanText(path: string, content: string): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (line === undefined) continue
    for (const match of scanLineMatches(line)) {
      findings.push({
        path,
        line: index + 1,
        rule: match.rule,
        match: match.match,
        severity: match.severity,
      })
    }
  }
  const format = structuredFormat(path)
  if (format !== null) {
    for (const entry of structuredValues(content, format)) {
      // A value that already matches a shape rule is reported by that rule only.
      if (scanLineRawMatches(entry.value).length > 0) continue
      const match =
        entropyMatch(entry.value) ??
        (entry.key !== undefined &&
        !entry.referenceMap &&
        isSensitiveSecretValue(entry.key, entry.value)
          ? { rule: 'sensitive-field' as const, severity: 'high' as const, match: '****' }
          : null)
      if (match === null) continue
      findings.push({
        path,
        line: entry.line,
        rule: match.rule,
        match: match.match,
        severity: match.severity,
      })
    }
  }
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = findingKey(finding)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function scanFiles(files: ScanFile[], options: ScanOptions = {}): ScanReport {
  const overridden = new Set(options.overrides ?? [])
  const findings: SecretFinding[] = []
  for (const file of files) findings.push(...scanText(file.path, file.content))
  const blocked = [...new Set(findings.map((finding) => finding.path))]
    .filter((path) => !overridden.has(path))
    .sort()
  return { findings, blocked, clean: blocked.length === 0 }
}

/** Fail closed. Throws unless every finding sits on an overridden path. */
export function assertClean(report: ScanReport): void {
  if (!report.clean) throw new SecretBlockedError(report)
}

export function overrideLogPath(home: string): string {
  return `${home}/${LAURENCIO_DIR}/secret-overrides.log`
}

export interface OverrideRecord {
  at: string
  path: string
  rule: SecretRuleId | 'unknown'
  line?: number
  reason: string
}

function escapeField(value: string): string {
  return value.replace(/[\t\r\n]/g, ' ')
}

export function formatOverrideRecord(record: OverrideRecord): string {
  const line = record.line === undefined ? '' : String(record.line)
  return [record.at, record.path, record.rule, line, record.reason].map(escapeField).join('\t')
}

export function parseOverrideRecord(raw: string): OverrideRecord | null {
  const fields = raw.split('\t')
  if (fields.length < 5) return null
  const [at, path, rule, lineField, reason] = fields
  if (at === undefined || path === undefined || rule === undefined || reason === undefined)
    return null
  const parsedLine = lineField === '' ? undefined : Number(lineField)
  const record: OverrideRecord = {
    at,
    path,
    rule: rule as SecretRuleId,
    reason,
  }
  if (parsedLine !== undefined && Number.isInteger(parsedLine)) record.line = parsedLine
  return record
}

/** Records what was overridden and where, then returns the log path. */
export function recordOverrides(home: string, records: OverrideRecord[]): string {
  const logPath = overrideLogPath(home)
  if (records.length === 0) return logPath
  mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
  const body = records.map(formatOverrideRecord).join('\n')
  appendFileSync(logPath, `${body}\n`, { mode: 0o600 })
  return logPath
}

export function readOverrideLog(home: string): OverrideRecord[] {
  const logPath = overrideLogPath(home)
  let raw: string
  try {
    raw = readFileSync(logPath, 'utf8')
  } catch {
    return []
  }
  const records: OverrideRecord[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const record = parseOverrideRecord(line)
    if (record !== null) records.push(record)
  }
  return records
}
