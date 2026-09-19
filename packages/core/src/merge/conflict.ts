import type { ConflictArtifact } from '../model'

/** Suffix shape written by {@link conflictCopyPath}; the scanner matches this to skip copies. */
const CONFLICT_COPY_PATTERN = /\.conflict-[A-Za-z0-9._-]+-\d{8}T\d{6}Z$/

/** One conflict copy, recorded so later scans can exclude it from manifests. */
export interface ConflictRecord {
  /** Path of the copy itself. */
  path: string
  /** The file the copy sits beside. */
  sourcePath: string
  device: string
  createdAt: string
}

export interface ConflictArtifactInput {
  sourcePath: string
  content: string
  device: string
  createdAt: string
}

export function isConflictCopyPath(path: string): boolean {
  return CONFLICT_COPY_PATTERN.test(path)
}

/** `<file>.conflict-<device>-<timestamp>`, timestamp in compact UTC. */
export function conflictCopyPath(sourcePath: string, device: string, createdAt: string): string {
  return `${sourcePath}.conflict-${sanitizeDevice(device)}-${compactTimestamp(createdAt)}`
}

export function createConflictArtifact(input: ConflictArtifactInput): ConflictArtifact {
  return {
    path: conflictCopyPath(input.sourcePath, input.device, input.createdAt),
    content: input.content,
    device: input.device,
    createdAt: input.createdAt,
  }
}

export function conflictRecord(artifact: ConflictArtifact, sourcePath: string): ConflictRecord {
  return {
    path: artifact.path,
    sourcePath,
    device: artifact.device,
    createdAt: artifact.createdAt,
  }
}

/**
 * Store-relative ledger form. Manifests carry `$HOME/...` paths, so an
 * absolute disk path would never match and the copy could travel.
 */
export function conflictStoreRecord(storePath: string, artifact: ConflictArtifact): ConflictRecord {
  return {
    path: `${storePath}.conflict-${sanitizeDevice(artifact.device)}-${compactTimestamp(artifact.createdAt)}`,
    sourcePath: storePath,
    device: artifact.device,
    createdAt: artifact.createdAt,
  }
}

/**
 * Durable list of conflict copies. The scanner consults it before emitting a
 * manifest so a copy never travels as config.
 */
export class ConflictLedger {
  #records: ConflictRecord[]

  constructor(records: readonly ConflictRecord[] = []) {
    this.#records = [...records]
  }

  add(record: ConflictRecord): void {
    if (!this.#records.some((existing) => existing.path === record.path)) {
      this.#records.push(record)
    }
  }

  isExcluded(path: string): boolean {
    return isConflictCopyPath(path) || this.#records.some((record) => record.path === path)
  }

  records(): readonly ConflictRecord[] {
    return this.#records
  }

  toJSON(): string {
    return JSON.stringify({ version: 1, records: this.#records }, null, 2)
  }

  static fromJSON(text: string): ConflictLedger {
    const parsed: unknown = JSON.parse(text)
    if (!isLedgerShape(parsed)) throw new Error('conflict ledger is malformed')
    return new ConflictLedger(parsed.records)
  }
}

function isLedgerShape(value: unknown): value is { version: number; records: ConflictRecord[] } {
  if (typeof value !== 'object' || value === null || !('records' in value)) return false
  const records = value.records
  return (
    Array.isArray(records) &&
    records.every(
      (record: unknown) =>
        typeof record === 'object' &&
        record !== null &&
        typeof (record as ConflictRecord).path === 'string' &&
        typeof (record as ConflictRecord).sourcePath === 'string' &&
        typeof (record as ConflictRecord).device === 'string' &&
        typeof (record as ConflictRecord).createdAt === 'string',
    )
  )
}

function sanitizeDevice(device: string): string {
  const cleaned = device.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '')
  return cleaned === '' ? 'device' : cleaned
}

function compactTimestamp(createdAt: string): string {
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) throw new Error(`invalid conflict timestamp: ${createdAt}`)
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
}
