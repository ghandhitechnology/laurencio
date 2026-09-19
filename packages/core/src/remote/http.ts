/**
 * The Remote implementation over the Laurencio HTTP protocol.
 *
 * Every `/v1` request states the client protocol version, and a mismatch comes
 * back as a typed `ProtocolVersionError` carrying the server's upgrade message.
 * Retries cover transport failures, 5xx, and 429, honoring `Retry-After` and
 * the `retryAfterSeconds` detail the server sends, with exponential backoff and
 * jitter between attempts. Blobs travel through presigned URLs, so the device
 * token never reaches the storage host.
 */

import type {
  BlobRef,
  DeviceRecord,
  ErrorCode,
  RevisionId,
  RevisionSummary,
  StoreId,
} from '@laurencio/protocol'
import {
  BlobDownloadResponse,
  CommitRequest,
  CommitResponse,
  checkProtocolVersion,
  DeviceListResponse,
  ErrorResponse,
  KdfResponse,
  KdfWriteRequest,
  KdfWriteResponse,
  MeResponse,
  PROTOCOL_VERSION,
  PresignResponse,
  RevisionList,
} from '@laurencio/protocol'
import { blobIdOf } from '../crypto/aead'
import { type KdfParams, kdfParamsFromWire, kdfParamsToWire } from '../crypto/kdf'
import type { RevisionMeta } from '../model'
import type {
  BlobUpload,
  KdfParamsLookup,
  PublishedKdfParams,
  PublishKdfParamsInput,
  Remote,
  RemoteCommit,
  RemoteCommitResult,
  RemoteListOptions,
  RemoteRevisionList,
} from './types'
import { KdfGenerationConflictError, KdfValidationError, RemoteError } from './types'

export const PROTOCOL_HEADER = 'x-laurencio-protocol-version'

/** The server caps a revision page at 500 entries. */
export const MAX_REVISION_PAGE = 500
export const MAX_REVISION_HARD_CAP = 5000

export const DEFAULT_RETRY_ATTEMPTS = 5
export const DEFAULT_RETRY_BASE_MS = 250
export const DEFAULT_RETRY_MAX_MS = 30_000

export interface HttpRetryPolicy {
  /** Total attempts, including the first one. */
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  /** Injectable randomness for deterministic tests. Returns 0..1. */
  random?: () => number
}

export type HttpRemoteErrorCode = ErrorCode | 'network'

export interface HttpRemoteErrorOptions {
  status?: number
  details?: Record<string, unknown>
  retryAfterSeconds?: number | null
  cause?: unknown
}

export class HttpRemoteError extends Error {
  readonly code: HttpRemoteErrorCode
  readonly status: number
  readonly details: Record<string, unknown>
  readonly retryAfterSeconds: number | null

  constructor(code: HttpRemoteErrorCode, message: string, options: HttpRemoteErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HttpRemoteError'
    this.code = code
    this.status = options.status ?? 0
    this.details = options.details ?? {}
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }

  /** A transport failure, a 429, or a 5xx is worth another attempt later. */
  get retryable(): boolean {
    return this.code === 'network' || this.status === 429 || this.status >= 500
  }

  get offline(): boolean {
    return this.code === 'network'
  }
}

/** The client and the server speak different protocol versions. */
export class ProtocolVersionError extends HttpRemoteError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('protocol_mismatch', `laurencio protocol mismatch: ${message}`, {
      status: 400,
      details,
    })
    this.name = 'ProtocolVersionError'
  }
}

/** The device token is unknown, revoked, or expired. */
export class DeviceAuthError extends HttpRemoteError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('unauthenticated', `${message} Sign in again with \`laurencio login\`.`, {
      status: 401,
      details,
    })
    this.name = 'DeviceAuthError'
  }
}

/** The store is over its quota. */
export class QuotaExceededError extends HttpRemoteError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('quota_exceeded', message, { status: 413, details })
    this.name = 'QuotaExceededError'
  }
}

export function isOfflineError(error: unknown): boolean {
  if (error instanceof HttpRemoteError) return error.retryable
  return false
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function fallbackCode(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'invalid_request'
    case 401:
      return 'unauthenticated'
    case 403:
      return 'forbidden'
    case 404:
      return 'not_found'
    case 409:
      return 'conflict'
    case 413:
      return 'quota_exceeded'
    case 429:
      return 'rate_limited'
    default:
      return 'internal'
  }
}

function parseRetryAfter(response: Response, details: Record<string, unknown>): number | null {
  const header = response.headers.get('retry-after')
  if (header !== null && header.trim() !== '') {
    const seconds = Number(header)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
    const date = Date.parse(header)
    if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000))
  }
  const fromDetails = details.retryAfterSeconds
  if (typeof fromDetails === 'number' && Number.isFinite(fromDetails) && fromDetails >= 0) {
    return Math.ceil(fromDetails)
  }
  return null
}

/** Maps a non-2xx response onto the typed error for its protocol code. */
export async function httpErrorFromResponse(
  response: Response,
  label: string,
): Promise<HttpRemoteError> {
  let payload: unknown = null
  let text = ''
  try {
    text = await response.text()
    payload = JSON.parse(text)
  } catch {
    payload = null
  }
  const parsed = ErrorResponse.safeParse(payload)
  const code: ErrorCode = parsed.success ? parsed.data.error.code : fallbackCode(response.status)
  const message = parsed.success
    ? parsed.data.error.message
    : text.slice(0, 200) || response.statusText
  const details = parsed.success ? (parsed.data.error.details ?? {}) : {}
  const retryAfterSeconds = parseRetryAfter(response, details)
  switch (code) {
    case 'protocol_mismatch':
      return new ProtocolVersionError(message, details)
    case 'unauthenticated':
      return new DeviceAuthError(`the server rejected this device token (${message}).`, details)
    case 'quota_exceeded':
      return new QuotaExceededError(`${label} would exceed the store quota: ${message}`, details)
    default:
      return new HttpRemoteError(code, `${label} failed with ${response.status}: ${message}`, {
        status: response.status,
        details,
        retryAfterSeconds,
      })
  }
}

function parseWire<T>(parser: { parse: (value: unknown) => T }, value: unknown, label: string): T {
  try {
    return parser.parse(value)
  } catch (error) {
    throw new RemoteError(
      'corrupt-store',
      `${label} does not match the protocol: ${reasonFor(error)}`,
    )
  }
}

export interface RemoteUsage {
  storeId: StoreId
  devices: DeviceRecord[]
  kdf: KdfParams | null
  blobs: number
  bytes: number
  maxBytes: number
}

export interface HttpRemoteOptions {
  baseUrl: string
  storeId: StoreId
  /** Device token from the OS keychain. */
  token: string
  /** Test lever for negotiation: the version this client claims. */
  protocolVersion?: number
  fetch?: typeof fetch
  retry?: HttpRetryPolicy
  sleep?: (ms: number) => Promise<void>
}

export interface HttpRemote extends Remote {
  readonly baseUrl: string
  readonly storeId: StoreId
  /** Swaps in a freshly minted device token without rebuilding the remote. */
  setToken(token: string): void
  /** Account and quota view from `/v1/me`, for `status` and doctor output. */
  getUsage(): Promise<RemoteUsage>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createHttpRemote(options: HttpRemoteOptions): HttpRemote {
  const base = new URL(options.baseUrl)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const sleep = options.sleep ?? defaultSleep
  const protocolVersion = options.protocolVersion ?? PROTOCOL_VERSION
  const attempts = Math.max(1, options.retry?.attempts ?? DEFAULT_RETRY_ATTEMPTS)
  const baseDelayMs = Math.max(1, options.retry?.baseDelayMs ?? DEFAULT_RETRY_BASE_MS)
  const maxDelayMs = Math.max(baseDelayMs, options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_MS)
  const random = options.retry?.random ?? Math.random
  const storeId = options.storeId
  const revisionCache = new Map<RevisionId, RevisionMeta>()
  let token = options.token

  const apiUrl = (path: string): string => new URL(path, base).toString()

  const assertServerProtocol = (body: unknown): void => {
    if (typeof body !== 'object' || body === null) return
    const version = (body as Record<string, unknown>).protocolVersion
    if (typeof version !== 'number' || version === protocolVersion) return
    const compatibility = checkProtocolVersion(version)
    if (!compatibility.ok) throw new ProtocolVersionError(compatibility.reason)
  }

  const delayFor = (attempt: number, error: HttpRemoteError): number => {
    const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
    const jittered = Math.round(backoff * (0.5 + random() * 0.5))
    if (error.retryAfterSeconds === null) return jittered
    return Math.min(maxDelayMs, Math.max(jittered, error.retryAfterSeconds * 1000))
  }

  const send = async (label: string, url: string, init: RequestInit): Promise<Response> => {
    let last: HttpRemoteError = new HttpRemoteError('network', `${label} was never attempted`)
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response | null = null
      try {
        response = await fetchImpl(url, init)
      } catch (error) {
        last = new HttpRemoteError(
          'network',
          `${label} could not reach the server: ${reasonFor(error)}`,
          {
            cause: error,
          },
        )
      }
      if (response !== null) {
        if (response.ok) return response
        last = await httpErrorFromResponse(response, label)
        if (!last.retryable) throw last
      }
      if (attempt === attempts) break
      await sleep(delayFor(attempt, last))
    }
    throw last
  }

  const apiJson = async <T>(label: string, path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${token}`)
    headers.set(PROTOCOL_HEADER, String(protocolVersion))
    if (init.body !== undefined && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    const response = await send(label, apiUrl(path), { ...init, headers })
    try {
      return (await response.json()) as T
    } catch (error) {
      throw new RemoteError('corrupt-store', `${label} returned invalid JSON: ${reasonFor(error)}`)
    }
  }

  const toRevisionMeta = (summary: RevisionSummary): RevisionMeta => ({
    id: summary.id,
    parents: [...summary.parents],
    deviceId: summary.deviceId,
    createdAt: summary.createdAt,
    manifest: { id: summary.manifest.id, size: summary.manifest.size },
    digest: [],
  })

  const listRevisions = async (
    listOptions: RemoteListOptions = {},
  ): Promise<RemoteRevisionList> => {
    // Heads come from the parent graph, so fetch the whole store (bounded). A store with
    // more revisions than the hard cap reports heads from the newest page only.
    const all: RevisionMeta[] = []
    for (const size of [MAX_REVISION_PAGE, MAX_REVISION_HARD_CAP]) {
      const fetched = await fetchRevisionPage(size)
      if (fetched.length < MAX_REVISION_PAGE || size === MAX_REVISION_HARD_CAP) {
        all.push(...fetched)
        break
      }
      all.length = 0
      all.push(...fetched)
    }
    const seen = new Set<string>()
    const ordered: RevisionMeta[] = []
    for (const revision of all) {
      if (seen.has(revision.id)) continue
      seen.add(revision.id)
      ordered.push(revision)
    }
    const allIds = new Set(ordered.map((revision) => revision.id as string))
    const parentIds = new Set<string>()
    for (const revision of ordered) {
      for (const parent of revision.parents) if (allIds.has(parent)) parentIds.add(parent)
    }
    const heads = ordered
      .filter((revision) => !parentIds.has(revision.id))
      .map((revision) => revision.id)
    let revisions = ordered
    if (listOptions.since !== undefined) {
      const index = revisions.findIndex((revision) => revision.id === listOptions.since)
      if (index !== -1) revisions = revisions.slice(index + 1)
    }
    if (listOptions.limit !== undefined && listOptions.limit >= 0) {
      revisions = revisions.slice(-listOptions.limit)
    }
    for (const revision of ordered) revisionCache.set(revision.id, revision)
    return { revisions, head: heads.length === 1 ? (heads[0] ?? null) : null, heads }
  }

  const fetchRevisionPage = async (size: number): Promise<RevisionMeta[]> => {
    const body = await apiJson<unknown>(
      'revision list',
      `/v1/stores/${storeId}/commits?limit=${size}`,
    )
    assertServerProtocol(body)
    const wire = parseWire(RevisionList, body, 'revision list')
    const page = wire.revisions.map(toRevisionMeta)
    // The server pages newest first; the Remote contract is creation order.
    page.reverse()
    return page
  }

  const getBlob = async (blobId: BlobRef['id']): Promise<Uint8Array> => {
    const body = await apiJson<unknown>(
      'blob download link',
      `/v1/stores/${storeId}/blobs/${blobId}`,
    )
    assertServerProtocol(body)
    const wire = parseWire(BlobDownloadResponse, body, 'blob download response')
    const response = await send('blob download', wire.url, { method: 'GET' })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== wire.size) {
      throw new RemoteError(
        'corrupt-store',
        `blob ${blobId} is ${bytes.length} bytes, the server declared ${wire.size}`,
      )
    }
    if (blobIdOf(bytes) !== blobId) {
      throw new RemoteError('corrupt-store', `blob ${blobId} failed its ciphertext hash check`)
    }
    return bytes
  }

  const getManifest = async (revisionId: RevisionId): Promise<Uint8Array> => {
    let revision = revisionCache.get(revisionId)
    if (revision === undefined) {
      const page = await listRevisions({ limit: MAX_REVISION_PAGE })
      revision = page.revisions.find((item) => item.id === revisionId)
    }
    if (revision === undefined) {
      throw new RemoteError('not-found', `the server does not hold revision ${revisionId}`)
    }
    return getBlob(revision.manifest.id)
  }

  const putBlob = async (upload: BlobUpload): Promise<BlobRef> => {
    const actual = blobIdOf(upload.bytes)
    if (actual !== upload.blobId) {
      throw new RemoteError(
        'blob-mismatch',
        `blob id ${upload.blobId} does not match its ciphertext`,
      )
    }
    const presignBody = await apiJson<unknown>(
      'blob presign',
      `/v1/stores/${storeId}/blobs/presign`,
      {
        method: 'POST',
        body: JSON.stringify({ blob: { id: upload.blobId, size: upload.bytes.length } }),
      },
    )
    const presign = parseWire(PresignResponse, presignBody, 'presign response')
    if (presign.blobId !== upload.blobId) {
      throw new RemoteError('corrupt-store', 'the server presigned a different blob id')
    }
    await send('blob upload', presign.url, {
      method: 'PUT',
      headers: presign.headers,
      body: upload.bytes,
    })
    return { id: upload.blobId, size: upload.bytes.length }
  }

  const commit = async (input: RemoteCommit): Promise<RemoteCommitResult> => {
    // The plaintext note never leaves the device. The protocol keeps the wire
    // field so older clients can still send it.
    const request = parseWire(
      CommitRequest,
      {
        protocolVersion,
        revision: input.revision,
        blobs: input.blobs,
      },
      'commit request',
    )
    const body = await apiJson<unknown>('commit', `/v1/stores/${storeId}/commits`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
    const wire = parseWire(CommitResponse, body, 'commit response')
    return { revisionId: wire.revisionId, accepted: wire.accepted, missing: wire.missing }
  }

  const getKdfParams = async (
    options: KdfParamsLookup = {},
  ): Promise<PublishedKdfParams | null> => {
    const query = options.version === undefined ? '' : `?version=${options.version}`
    const body = await apiJson<unknown>('kdf params', `/v1/stores/${storeId}/kdf-params${query}`)
    assertServerProtocol(body)
    const wire = parseWire(KdfResponse, body, 'kdf response')
    if (wire.kdf === null) return null
    return {
      kdf: kdfParamsFromWire(wire.kdf),
      generation: wire.generation ?? options.version ?? 1,
    }
  }

  const putKdfParams = async (input: PublishKdfParamsInput): Promise<PublishedKdfParams> => {
    let request: KdfWriteRequest
    try {
      request = KdfWriteRequest.parse({
        ...kdfParamsToWire(input.params, input.calibratedAt ?? new Date().toISOString()),
        generation: input.expectedGeneration ?? null,
      })
    } catch (error) {
      throw new KdfValidationError(reasonFor(error))
    }
    let body: unknown
    try {
      body = await apiJson<unknown>('kdf publish', `/v1/stores/${storeId}/kdf-params`, {
        method: 'PUT',
        body: JSON.stringify(request),
      })
    } catch (error) {
      if (error instanceof HttpRemoteError) {
        if (error.status === 409) {
          const actual =
            typeof error.details.generation === 'number' ? error.details.generation : null
          throw new KdfGenerationConflictError(input.expectedGeneration ?? 0, actual)
        }
        if (error.status === 400) throw new KdfValidationError(error.message)
      }
      throw error
    }
    assertServerProtocol(body)
    const parsed = parseWire(KdfWriteResponse, body, 'kdf publish response')
    return {
      kdf: kdfParamsFromWire(parsed.kdf),
      generation: parsed.generation,
    }
  }

  const listDevices = async (): Promise<DeviceRecord[]> => {
    const body = await apiJson<unknown>('device list', '/v1/devices')
    assertServerProtocol(body)
    return parseWire(DeviceListResponse, body, 'device list').devices
  }

  const getUsage = async (): Promise<RemoteUsage> => {
    const body = await apiJson<unknown>('account view', '/v1/me')
    assertServerProtocol(body)
    const wire = parseWire(MeResponse, body, 'account view')
    return {
      storeId: wire.storeId,
      devices: wire.devices,
      kdf: wire.kdf === null ? null : kdfParamsFromWire(wire.kdf),
      blobs: wire.quotas.blobs,
      bytes: wire.quotas.bytes,
      maxBytes: wire.quotas.maxBytes,
    }
  }

  return {
    baseUrl: base.toString(),
    storeId,
    setToken(next): void {
      token = next
    },
    getKdfParams,
    putKdfParams,
    listRevisions,
    getManifest,
    putBlob,
    getBlob,
    commit,
    listDevices,
    getUsage,
  }
}
