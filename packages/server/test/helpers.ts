import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import type { Hono } from 'hono'
import { type Auth, createAuth } from '../src/auth'
import type { AppBindings } from '../src/context'
import { type Database, migrationsFolder } from '../src/db/client'
import * as schema from '../src/db/schema'
import { type EnvSource, loadEnv, type ServerEnv } from '../src/env'
import { createApp } from '../src/index'
import type { Logger } from '../src/log'
import { FsBlobStore } from '../src/storage/fs'

export const TEST_ORIGIN = 'http://localhost:8787'
export const TEST_CLIENT_ID = 'laurencio-cli'
export const DEV_PASSWORD = 'laurencio-dev-password'

export interface TestServer {
  app: Hono<AppBindings>
  db: Database
  auth: Auth
  env: ServerEnv
  storage: FsBlobStore
  dataDir: string
  close(): Promise<void>
}

export async function createTestServer(
  extraEnv: EnvSource = {},
  options: { pglite?: PGlite; logger?: Logger } = {},
): Promise<TestServer> {
  const dataDir = await mkdtemp(join(tmpdir(), 'laurencio-test-'))
  const pglite = options.pglite ?? new PGlite()
  const db = drizzle(pglite, { schema })
  await migrate(db, { migrationsFolder })
  const env = loadEnv({
    NODE_ENV: 'test',
    BETTER_AUTH_URL: TEST_ORIGIN,
    BETTER_AUTH_SECRET: 'test-secret',
    ALLOW_DEV_SIGNIN: '1',
    DEVICE_POLL_INTERVAL: '0s',
    LOG_LEVEL: 'error',
    FS_STORAGE_DIR: join(dataDir, 'blobs'),
    FS_STORAGE_SECRET: 'test-fs-secret',
    ...extraEnv,
  })
  if (env.storage.kind !== 'fs') throw new Error('tests run against the filesystem store')
  const storage = new FsBlobStore(env.storage)
  const auth = createAuth({ db, env })
  const app = createApp({
    env,
    db,
    storage,
    auth,
    ...(options.logger ? { logger: options.logger } : {}),
  })
  return {
    app,
    db,
    auth,
    env,
    storage,
    dataDir,
    close: () => pglite.close(),
  }
}

export interface TestClient {
  request(path: string, init?: RequestInit): Promise<Response>
  json<T = unknown>(path: string, init?: RequestInit): Promise<T>
  expectStatus(path: string, status: number, init?: RequestInit): Promise<Response>
  cookies: Map<string, string>
}

export interface TestClientOptions {
  /** Most clients send the protocol header automatically; tests for its absence opt out. */
  protocolHeader?: boolean
}

export function createClient(app: Hono<AppBindings>, options: TestClientOptions = {}): TestClient {
  const cookies = new Map<string, string>()
  const sendProtocolHeader = options.protocolHeader ?? true
  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers)
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json')
    // Tests may pin a foreign origin to exercise the web origin check.
    if (!headers.has('origin')) headers.set('origin', TEST_ORIGIN)
    if (cookies.size > 0) {
      headers.set(
        'cookie',
        [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      )
    }
    if (
      sendProtocolHeader &&
      path.startsWith('/v1') &&
      !headers.has('x-laurencio-protocol-version')
    ) {
      headers.set('x-laurencio-protocol-version', '1')
    }
    const response = await app.request(
      new Request(`${TEST_ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }),
    )
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value === '') cookies.delete(name)
      else cookies.set(name, value)
    }
    return response
  }
  const json = async <T = unknown>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(path, init)
    return (await response.json()) as T
  }
  const expectStatus = async (
    path: string,
    status: number,
    init?: RequestInit,
  ): Promise<Response> => {
    const response = await request(path, init)
    if (response.status !== status) {
      throw new Error(
        `expected ${status} from ${init?.method ?? 'GET'} ${path}, got ${response.status}: ${await response.text()}`,
      )
    }
    return response
  }
  return { request, json, expectStatus, cookies }
}

export interface EnrolledDevice {
  token: string
  deviceId: string
  userId: string
  code: string
}

/** Walks the whole RFC 8628 flow plus device enrollment, like the CLI does. */
export async function enrollDevice(
  client: TestClient,
  options: { name?: string; platform?: string; email?: string } = {},
): Promise<EnrolledDevice> {
  const code = await client.json<{
    device_code: string
    user_code: string
  }>('/api/auth/device/code', {
    method: 'POST',
    body: JSON.stringify({ client_id: TEST_CLIENT_ID }),
  })
  await signInDev(client, options.email ?? 'dev@example.com')
  await claimDeviceCode(client, code.user_code)
  await client.expectStatus('/api/auth/device/approve', 200, {
    method: 'POST',
    body: JSON.stringify({ userCode: code.user_code }),
  })
  const token = await client.json<{ access_token: string }>('/api/auth/device/token', {
    method: 'POST',
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
      client_id: TEST_CLIENT_ID,
    }),
  })
  const enrolled = await client.json<{ device: { id: string }; token: string }>('/v1/devices', {
    method: 'POST',
    headers: { authorization: `Bearer ${token.access_token}` },
    body: JSON.stringify({
      name: options.name ?? 'test-laptop',
      platform: options.platform ?? 'darwin',
    }),
  })
  const me = await client.json<{ userId: string }>('/v1/me', {
    headers: { authorization: `Bearer ${enrolled.token}` },
  })
  return {
    token: enrolled.token,
    deviceId: enrolled.device.id,
    userId: me.userId,
    code: code.user_code,
  }
}

/** The signed-in session claims the code before it can approve or deny it. */
export async function claimDeviceCode(client: TestClient, userCode: string): Promise<void> {
  await client.expectStatus(`/api/auth/device?user_code=${encodeURIComponent(userCode)}`, 200)
}

export async function signInDev(client: TestClient, email: string): Promise<void> {
  const response = await client.request('/sign-in/dev', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, next: '/account/devices' }).toString(),
  })
  if (response.status !== 303 && response.status !== 200) {
    throw new Error(`dev sign-in failed with ${response.status}: ${await response.text()}`)
  }
}

export function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

/** Typed JSON read for plain `Response` values, which carry no type parameter. */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T
}

/** Blob ids are the sha256 of the (ciphertext) bytes, so tests derive them the same way. */
export function blobIdFor(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function bytesFor(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

export interface TestUser extends EnrolledDevice {
  client: TestClient
  storeId: string
  email: string
}

/** A signed-in user with one enrolled device and its store, ready for /v1 calls. */
export async function createUser(
  server: TestServer,
  email: string,
  name = 'laptop',
): Promise<TestUser> {
  const client = createClient(server.app)
  const device = await enrollDevice(client, { email, name })
  const me = await client.json<{ storeId: string }>('/v1/me', {
    headers: authHeaders(device.token),
  })
  return { ...device, client, storeId: me.storeId, email }
}

/** Uploads bytes through the presigned URL the server returned. */
export async function uploadBlob(
  client: TestClient,
  token: string,
  storeId: string,
  bytes: Uint8Array,
  blobId: string,
): Promise<void> {
  const presign = await client.json<{ url: string }>(`/v1/stores/${storeId}/blobs/presign`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ blob: { id: blobId, size: bytes.byteLength } }),
  })
  const url = new URL(presign.url)
  const response = await client.request(`${url.pathname}${url.search}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  })
  if (!response.ok) throw new Error(`upload failed: ${response.status} ${await response.text()}`)
}
