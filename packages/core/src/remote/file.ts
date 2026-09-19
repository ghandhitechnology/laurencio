/**
 * A directory that behaves like the server: one store per user, revision records,
 * content-addressed ciphertext blobs, and the same framing as the crypto layer.
 * This is the offline lever the engine tests against, not a server substitute:
 * there is no auth, no quota, and no GC.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  BlobId,
  BlobRef,
  DeviceRecord,
  RevisionId,
  StoreId,
  KdfParams as WireKdfParams,
} from '@laurencio/protocol'
import { PROTOCOL_VERSION } from '@laurencio/protocol'
import { type KdfParams, kdfParamsFromWire } from '../crypto/kdf'
import type { RevisionMeta, SurfaceDigest } from '../model'
import type {
  BlobUpload,
  Remote,
  RemoteCommit,
  RemoteCommitResult,
  RemoteListOptions,
  RemoteRevisionList,
} from './types'
import { RemoteError } from './types'

interface StoreFile {
  version: 1
  storeId: StoreId
  protocolVersion: number
  createdAt: string
}

export interface FileRemoteOptions {
  dir: string
  /** Seeds a new store. Ignored when the directory already holds one. */
  kdf?: WireKdfParams
  storeId?: StoreId
  now?: () => Date
}

export interface FileRemote extends Remote {
  readonly dir: string
  readonly storeId: StoreId
  /** Test and harness helper: enroll a device record. */
  upsertDevice(device: DeviceRecord): void
}

const BLOB_ID_PATTERN = /^[0-9a-f]{64}$/

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readJsonFile(filePath: string): unknown {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    throw new RemoteError('not-found', `missing file: ${filePath}`)
  }
  try {
    return JSON.parse(raw)
  } catch {
    throw new RemoteError('corrupt-store', `invalid json: ${filePath}`)
  }
}

let tempCounter = 0

function atomicWrite(filePath: string, data: string | Uint8Array): void {
  tempCounter += 1
  const unique = `${process.pid}-${tempCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const tempPath = `${filePath}.tmp-${unique}`
  fs.writeFileSync(tempPath, data)
  fs.renameSync(tempPath, filePath)
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const COMMIT_LOCK_TIMEOUT_MS = 10_000

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    throw new RemoteError('corrupt-store', `${what} is not an object`)
  }
  return value as Record<string, unknown>
}

function parseRevisionMeta(value: unknown, source: string): RevisionMeta {
  const record = asRecord(value, `revision ${source}`)
  if (typeof record.id !== 'string')
    throw new RemoteError('corrupt-store', `revision id in ${source}`)
  if (!Array.isArray(record.parents)) {
    throw new RemoteError('corrupt-store', `revision parents in ${source}`)
  }
  if (typeof record.deviceId !== 'string') {
    throw new RemoteError('corrupt-store', `revision device in ${source}`)
  }
  if (typeof record.createdAt !== 'string') {
    throw new RemoteError('corrupt-store', `revision createdAt in ${source}`)
  }
  const manifest = asRecord(record.manifest, `revision manifest in ${source}`)
  if (typeof manifest.id !== 'string' || typeof manifest.size !== 'number') {
    throw new RemoteError('corrupt-store', `revision manifest ref in ${source}`)
  }
  const digest: RevisionMeta['digest'] = []
  if (Array.isArray(record.digest)) {
    for (const item of record.digest) {
      const entry = asRecord(item, `digest entry in ${source}`)
      if (
        typeof entry.surfaceId === 'string' &&
        typeof entry.files === 'number' &&
        typeof entry.bytes === 'number'
      ) {
        digest.push({
          surfaceId: entry.surfaceId as RevisionMeta['digest'][number]['surfaceId'],
          files: entry.files,
          bytes: entry.bytes,
        })
      }
    }
  }
  return {
    id: record.id as RevisionId,
    parents: record.parents.filter((parent): parent is RevisionId => typeof parent === 'string'),
    deviceId: record.deviceId as RevisionMeta['deviceId'],
    createdAt: record.createdAt,
    manifest: {
      id: manifest.id as BlobId,
      size: manifest.size,
    },
    digest,
  }
}

function revisionFilePath(dir: string, revisionId: RevisionId): string {
  return path.join(dir, 'revisions', `${revisionId}.json`)
}

function listAllRevisions(dir: string): RevisionMeta[] {
  const revisionDir = path.join(dir, 'revisions')
  const names = fs.existsSync(revisionDir) ? fs.readdirSync(revisionDir).sort() : []
  const revisions: RevisionMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    revisions.push(parseRevisionMeta(readJsonFile(path.join(revisionDir, name)), name))
  }
  return revisions
}

function commitLockHolderGone(lockPath: string): boolean {
  try {
    const pid = Number.parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10)
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return false
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
    }
  } catch {
    return true
  }
}

/** Serializes head check plus revision write across processes on one store. */
function withCommitLock<T>(dir: string, action: () => T): T {
  const lockPath = path.join(dir, 'revisions', '.commit.lock')
  const deadline = Date.now() + COMMIT_LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600)
      try {
        fs.writeFileSync(fd, String(process.pid))
        return action()
      } finally {
        fs.closeSync(fd)
        fs.rmSync(lockPath, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (commitLockHolderGone(lockPath)) {
        fs.rmSync(lockPath, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new RemoteError('corrupt-store', 'commit lock was not released in time')
      }
      sleepSync(5)
    }
  }
}

/**
 * Heads are revisions that no other revision names as a parent. Wall-clock
 * `createdAt` may be skewed between devices, so it never decides the head.
 */
function revisionHeads(revisions: readonly RevisionMeta[]): RevisionId[] {
  const referenced = new Set<string>()
  for (const revision of revisions) {
    for (const parent of revision.parents) referenced.add(parent)
  }
  return revisions
    .filter((revision) => !referenced.has(revision.id))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((revision) => revision.id)
}

export function createFileRemote(options: FileRemoteOptions): FileRemote {
  const dir = path.resolve(options.dir)
  const now = options.now ?? (() => new Date())
  fs.mkdirSync(path.join(dir, 'revisions'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true })

  const storePath = path.join(dir, 'store.json')
  let store: StoreFile
  if (fs.existsSync(storePath)) {
    const record = asRecord(readJsonFile(storePath), 'store.json')
    if (record.protocolVersion !== PROTOCOL_VERSION) {
      throw new RemoteError(
        'corrupt-store',
        `store speaks protocol v${String(record.protocolVersion)}, this client speaks v${PROTOCOL_VERSION}`,
      )
    }
    store = {
      version: 1,
      storeId: record.storeId as StoreId,
      protocolVersion: PROTOCOL_VERSION,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : now().toISOString(),
    }
  } else {
    if (options.storeId === undefined) {
      throw new RemoteError('corrupt-store', 'a new file remote needs a store id')
    }
    store = {
      version: 1,
      storeId: options.storeId,
      protocolVersion: PROTOCOL_VERSION,
      createdAt: now().toISOString(),
    }
    atomicWrite(storePath, JSON.stringify(store, null, 2))
  }

  const kdfPath = path.join(dir, 'kdf.json')
  if (!fs.existsSync(kdfPath)) {
    if (options.kdf === undefined) {
      throw new RemoteError('not-found', 'file remote has no kdf parameters')
    }
    atomicWrite(kdfPath, JSON.stringify(options.kdf, null, 2))
  }

  function blobPath(blobId: BlobId): string {
    if (!BLOB_ID_PATTERN.test(blobId)) {
      throw new RemoteError('not-found', `not a blob id: ${blobId}`)
    }
    return path.join(dir, 'blobs', blobId)
  }

  function devices(): DeviceRecord[] {
    const devicesPath = path.join(dir, 'devices.json')
    if (!fs.existsSync(devicesPath)) return []
    const parsed = readJsonFile(devicesPath)
    if (!Array.isArray(parsed))
      throw new RemoteError('corrupt-store', 'devices.json is not an array')
    const records: DeviceRecord[] = []
    for (const item of parsed) {
      const record = asRecord(item, 'device record')
      if (typeof record.id !== 'string' || typeof record.name !== 'string') continue
      if (typeof record.platform !== 'string' || typeof record.createdAt !== 'string') continue
      const device: DeviceRecord = {
        id: record.id as DeviceRecord['id'],
        name: record.name,
        platform: record.platform,
        createdAt: record.createdAt,
      }
      if (typeof record.lastSeenAt === 'string') device.lastSeenAt = record.lastSeenAt
      if (typeof record.revokedAt === 'string') device.revokedAt = record.revokedAt
      records.push(device)
    }
    return records
  }

  return {
    dir,
    storeId: store.storeId,

    async getKdfParams(): Promise<KdfParams | null> {
      if (!fs.existsSync(kdfPath)) return null
      const record = asRecord(readJsonFile(kdfPath), 'kdf.json')
      return kdfParamsFromWire(record as unknown as WireKdfParams)
    },

    async listRevisions(listOptions: RemoteListOptions = {}): Promise<RemoteRevisionList> {
      const all = listAllRevisions(dir)
      all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      const heads = revisionHeads(all)
      let revisions = all
      if (listOptions.since !== undefined) {
        const index = revisions.findIndex((revision) => revision.id === listOptions.since)
        revisions = index === -1 ? revisions : revisions.slice(index + 1)
      }
      if (listOptions.limit !== undefined && listOptions.limit >= 0) {
        revisions = revisions.slice(-listOptions.limit)
      }
      return { revisions, head: heads.length === 1 ? (heads[0] ?? null) : null, heads }
    },

    async getManifest(revisionId: RevisionId): Promise<Uint8Array> {
      const revision = parseRevisionMeta(
        readJsonFile(revisionFilePath(dir, revisionId)),
        revisionId,
      )
      let bytes: Uint8Array
      try {
        bytes = fs.readFileSync(blobPath(revision.manifest.id))
      } catch {
        throw new RemoteError('not-found', `manifest blob missing for revision ${revisionId}`)
      }
      return bytes
    },

    async putBlob(blob: BlobUpload): Promise<BlobRef> {
      const actual = sha256Hex(blob.bytes)
      if (actual !== blob.blobId) {
        throw new RemoteError('blob-mismatch', `blob id ${blob.blobId} does not match its bytes`)
      }
      const target = blobPath(blob.blobId)
      if (fs.existsSync(target)) {
        const existing = fs.statSync(target)
        if (existing.size !== blob.bytes.length) {
          throw new RemoteError('corrupt-store', `blob ${blob.blobId} exists with a different size`)
        }
      } else {
        atomicWrite(target, blob.bytes)
      }
      return { id: blob.blobId, size: blob.bytes.length }
    },

    async getBlob(blobId: BlobId): Promise<Uint8Array> {
      try {
        return fs.readFileSync(blobPath(blobId))
      } catch {
        throw new RemoteError('not-found', `blob not found: ${blobId}`)
      }
    },

    async commit(commit: RemoteCommit): Promise<RemoteCommitResult> {
      const target = revisionFilePath(dir, commit.revision.id)
      if (fs.existsSync(target)) {
        // Idempotent by revision id: a repeat returns the stored result.
        return { revisionId: commit.revision.id, accepted: true, missing: [] }
      }
      // One writer at a time: the head check and the revision write must be
      // atomic, or two devices both see the old head and both land.
      return withCommitLock(dir, () => {
        if (fs.existsSync(target)) {
          return { revisionId: commit.revision.id, accepted: true, missing: [] }
        }
        const current = listAllRevisions(dir)
        const heads = revisionHeads(current)
        const parents = new Set<string>(commit.revision.parents)
        const uncovered = heads.filter((head) => !parents.has(head))
        if (uncovered.length > 0) {
          return {
            revisionId: commit.revision.id,
            accepted: false,
            missing: [],
            reason: 'stale-parents' as const,
            heads,
          }
        }
        const missing: BlobId[] = []
        const referenced = new Set<string>([commit.revision.manifest.id])
        for (const blob of commit.blobs) referenced.add(blob.id)
        for (const blobId of [...referenced].sort()) {
          if (!fs.existsSync(blobPath(blobId as BlobId))) missing.push(blobId as BlobId)
        }
        if (missing.length > 0) {
          return {
            revisionId: commit.revision.id,
            accepted: false,
            missing,
            reason: 'missing-blobs' as const,
          }
        }
        const meta: RevisionMeta = {
          id: commit.revision.id,
          parents: [...commit.revision.parents],
          deviceId: commit.revision.deviceId,
          createdAt: commit.revision.createdAt,
          manifest: { id: commit.revision.manifest.id, size: commit.revision.manifest.size },
          digest: [...(commit.digest as SurfaceDigest[])],
        }
        atomicWrite(target, JSON.stringify(meta, null, 2))
        return { revisionId: commit.revision.id, accepted: true, missing: [] }
      })
    },

    async listDevices(): Promise<DeviceRecord[]> {
      return devices()
    },

    upsertDevice(device: DeviceRecord): void {
      const existing = devices().filter((record) => record.id !== device.id)
      existing.push(device)
      existing.sort((a, b) => a.id.localeCompare(b.id))
      atomicWrite(path.join(dir, 'devices.json'), JSON.stringify(existing, null, 2))
    },
  }
}
