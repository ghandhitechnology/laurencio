import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ToolLockEntry } from '../profile'

export * from './catalog'

export interface DownloadedArtifact {
  bytes: Uint8Array
  finalUrl: string
  redirects: readonly string[]
}

export interface ArtifactSource {
  download(url: string): Promise<DownloadedArtifact>
}

export interface AtomicToolFilesystem {
  /** Creates a private staging directory on the same volume as the destination. */
  stage(destination: string): Promise<string>
  /** Atomically replaces the destination with the completed staging directory. */
  commit(staging: string, destination: string): Promise<void>
  /** Removes an uncommitted staging directory. Must be safe to call after a partial failure. */
  discard(staging: string): Promise<void>
  /** Reads the receipt written after a cache install completed atomically. */
  readReceipt?(destination: string): Promise<ToolInstallReceipt | null>
  /** Writes the receipt into staging so it commits with the unpacked tool. */
  writeReceipt?(staging: string, receipt: ToolInstallReceipt): Promise<void>
}

export interface ToolInstallReceipt {
  sha256: string
  sourceHost: string
}

export interface ToolUnpacker {
  unpack(input: { bytes: Uint8Array; sourceName: string; destination: string }): Promise<void>
}

export interface ToolManagerDependencies {
  artifacts: ArtifactSource
  files: AtomicToolFilesystem
  unpacker: ToolUnpacker
}

export interface ToolInstallRequest {
  platform: 'darwin' | 'win32'
  architecture: 'arm64' | 'x64'
  target: {
    kind: 'session' | 'cache'
    root: string
  }
}

export interface InstalledTool {
  name: string
  platform: 'darwin' | 'win32'
  architecture: 'arm64' | 'x64'
  version: string
  sourceHost: string
  integrity: 'verified'
  target: 'session' | 'cache'
  directory: string
}

export interface ToolPinMetadata {
  name: string
  platform: 'darwin' | 'win32'
  architecture: 'arm64' | 'x64'
  version: string
  sourceHost: string
  integrity: 'sha256-pinned'
}

export type ToolLockChange =
  | { kind: 'add'; after: ToolPinMetadata }
  | { kind: 'remove'; before: ToolPinMetadata }
  | {
      kind: 'update'
      changed: Array<'version' | 'source' | 'integrity'>
      before: ToolPinMetadata
      after: ToolPinMetadata
    }

interface PreparedArtifact {
  lock: ToolLockEntry
  bytes: Uint8Array
  sourceName: string
  sourceHost: string
}

interface PreparedCacheHit {
  lock: ToolLockEntry
  directory: string
  sourceHost: string
}

function checksum(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function compareLocks(left: ToolLockEntry, right: ToolLockEntry): number {
  const leftKey = `${left.name}\0${left.version}`
  const rightKey = `${right.name}\0${right.version}`
  if (leftKey < rightKey) return -1
  if (leftKey > rightKey) return 1
  return 0
}

function lockKey(entry: ToolLockEntry): string {
  return `${entry.name}\0${entry.platform}\0${entry.arch}`
}

function requireHttpsSource(entry: ToolLockEntry): URL {
  let source: URL
  try {
    source = new URL(entry.url)
  } catch {
    throw new Error(`tool ${entry.name} has an invalid source`)
  }
  if (source.protocol !== 'https:') {
    throw new Error(`tool ${entry.name} requires an HTTPS source`)
  }
  return source
}

function requireHttpsRedirects(entry: ToolLockEntry, downloaded: DownloadedArtifact): URL {
  const destinations = [...downloaded.redirects, downloaded.finalUrl]
  for (const destination of destinations) {
    try {
      if (new URL(destination).protocol !== 'https:') {
        throw new Error('insecure')
      }
    } catch {
      throw new Error(`tool ${entry.name} followed a non-HTTPS redirect`)
    }
  }
  return new URL(downloaded.finalUrl)
}

function installDirectory(request: ToolInstallRequest, entry: ToolLockEntry): string {
  return join(request.target.root, entry.name, entry.version, `${entry.platform}-${entry.arch}`)
}

function validReceiptHost(value: string): boolean {
  try {
    const source = new URL(`https://${value}`)
    return (
      source.host === value &&
      source.username === '' &&
      source.password === '' &&
      source.pathname === '/'
    )
  } catch {
    return false
  }
}

function assertNoDuplicatePins(lock: readonly ToolLockEntry[]): void {
  const targets = new Set<string>()
  for (const entry of lock) {
    const target = `${entry.name}/${entry.platform}/${entry.arch}`
    if (targets.has(target)) {
      throw new Error(`duplicate tool pin: ${target}`)
    }
    targets.add(target)
  }
}

function assertExactVersions(lock: readonly ToolLockEntry[]): void {
  const exactVersion =
    /^(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|\d+\.\d+[a-z]|\d{8}-\d{6}-[0-9a-f]+)$/
  for (const entry of lock) {
    if (!exactVersion.test(entry.version)) {
      throw new Error(`tool ${entry.name} has an unpinned version`)
    }
  }
}

function assertSupportedTargets(lock: readonly ToolLockEntry[]): void {
  for (const entry of lock) {
    if (entry.platform !== 'darwin' && entry.platform !== 'win32') {
      throw new Error(`tool ${entry.name} has an unsupported platform: ${entry.platform}`)
    }
    if (entry.arch !== 'arm64' && entry.arch !== 'x64') {
      throw new Error(`tool ${entry.name} has an unsupported architecture: ${entry.arch}`)
    }
  }
}

function assertSafePins(lock: readonly ToolLockEntry[]): void {
  for (const entry of lock) {
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(entry.name)) {
      throw new Error(`tool name is invalid: ${entry.name}`)
    }
    if (!/^[0-9a-f]{64}$/.test(entry.sha256)) {
      throw new Error(`tool ${entry.name} has an invalid sha256 pin`)
    }
  }
}

function assertLock(lock: readonly ToolLockEntry[]): void {
  assertSafePins(lock)
  assertSupportedTargets(lock)
  assertNoDuplicatePins(lock)
  assertExactVersions(lock)
  for (const entry of lock) requireHttpsSource(entry)
}

function redactedPin(entry: ToolLockEntry): ToolPinMetadata {
  const source = requireHttpsSource(entry)
  return {
    name: entry.name,
    platform: entry.platform,
    architecture: entry.arch as 'arm64' | 'x64',
    version: entry.version,
    sourceHost: source.host,
    integrity: 'sha256-pinned',
  }
}

function assertInstallTarget(request: ToolInstallRequest): void {
  if (request.platform !== 'darwin' && request.platform !== 'win32') {
    throw new Error(`unsupported install platform: ${request.platform}`)
  }
  if (request.architecture !== 'arm64' && request.architecture !== 'x64') {
    throw new Error(`unsupported install architecture: ${request.architecture}`)
  }
}

export class ToolManager {
  readonly #lock: readonly ToolLockEntry[]
  readonly #dependencies: ToolManagerDependencies

  constructor(lock: readonly ToolLockEntry[], dependencies: ToolManagerDependencies) {
    assertLock(lock)
    this.#lock = lock.map((entry) => ({ ...entry }))
    this.#dependencies = dependencies
  }

  diff(nextLock: readonly ToolLockEntry[]): ToolLockChange[] {
    assertLock(nextLock)
    const current = new Map(this.#lock.map((entry) => [lockKey(entry), entry]))
    const next = new Map(nextLock.map((entry) => [lockKey(entry), entry]))
    const keys = [...new Set([...current.keys(), ...next.keys()])].sort()
    const changes: ToolLockChange[] = []

    for (const key of keys) {
      const before = current.get(key)
      const after = next.get(key)
      if (before === undefined && after !== undefined) {
        changes.push({ kind: 'add', after: redactedPin(after) })
        continue
      }
      if (before !== undefined && after === undefined) {
        changes.push({ kind: 'remove', before: redactedPin(before) })
        continue
      }
      if (before === undefined || after === undefined) continue

      const changed: Array<'version' | 'source' | 'integrity'> = []
      if (before.version !== after.version) changed.push('version')
      if (before.url !== after.url) changed.push('source')
      if (before.sha256 !== after.sha256) changed.push('integrity')
      if (changed.length > 0) {
        changes.push({
          kind: 'update',
          changed,
          before: redactedPin(before),
          after: redactedPin(after),
        })
      }
    }
    return changes
  }

  async install(request: ToolInstallRequest): Promise<InstalledTool[]> {
    assertInstallTarget(request)
    const selected = this.#lock
      .filter((entry) => entry.platform === request.platform && entry.arch === request.architecture)
      .sort(compareLocks)
    const prepared: Array<PreparedArtifact | PreparedCacheHit> = []

    for (const entry of selected) {
      const destination = installDirectory(request, entry)
      if (request.target.kind === 'cache' && this.#dependencies.files.readReceipt !== undefined) {
        const receipt = await this.#dependencies.files.readReceipt(destination)
        if (
          receipt !== null &&
          receipt.sha256 === entry.sha256 &&
          validReceiptHost(receipt.sourceHost)
        ) {
          prepared.push({ lock: entry, directory: destination, sourceHost: receipt.sourceHost })
          continue
        }
      }
      const source = requireHttpsSource(entry)
      const downloaded = await this.#dependencies.artifacts.download(entry.url)
      const finalUrl = requireHttpsRedirects(entry, downloaded)
      if (checksum(downloaded.bytes) !== entry.sha256) {
        throw new Error(`checksum mismatch for tool ${entry.name}`)
      }
      prepared.push({
        lock: entry,
        bytes: downloaded.bytes,
        sourceName: source.pathname.split('/').at(-1) || entry.name,
        sourceHost: finalUrl.host,
      })
    }

    const installed: InstalledTool[] = []
    for (const artifact of prepared) {
      if ('directory' in artifact) {
        installed.push({
          name: artifact.lock.name,
          platform: request.platform,
          architecture: request.architecture,
          version: artifact.lock.version,
          sourceHost: artifact.sourceHost,
          integrity: 'verified',
          target: request.target.kind,
          directory: artifact.directory,
        })
        continue
      }
      const destination = installDirectory(request, artifact.lock)
      const staging = await this.#dependencies.files.stage(destination)
      try {
        await this.#dependencies.unpacker.unpack({
          bytes: artifact.bytes,
          sourceName: artifact.sourceName,
          destination: staging,
        })
        if (
          request.target.kind === 'cache' &&
          this.#dependencies.files.writeReceipt !== undefined
        ) {
          await this.#dependencies.files.writeReceipt(staging, {
            sha256: artifact.lock.sha256,
            sourceHost: artifact.sourceHost,
          })
        }
        await this.#dependencies.files.commit(staging, destination)
      } catch (error) {
        await this.#dependencies.files.discard(staging)
        throw error
      }
      installed.push({
        name: artifact.lock.name,
        platform: request.platform,
        architecture: request.architecture,
        version: artifact.lock.version,
        sourceHost: artifact.sourceHost,
        integrity: 'verified',
        target: request.target.kind,
        directory: destination,
      })
    }
    return installed
  }
}
