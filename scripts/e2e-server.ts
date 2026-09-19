/**
 * The real-server end-to-end harness. Boots the actual Hono app on a random
 * local port with PGlite and the filesystem blob store, enrolls two fake HOMEs
 * as two devices of one account, and drives the real SyncLoop over HTTP.
 *
 * Asserts convergence, the offline queue, revoked devices, the wrong
 * passphrase, protocol mismatch messaging, idempotent duplicate commits, and
 * that the store holds ciphertext only.
 *
 * Run: bun run e2e:server
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EnvelopeError, openText, sealText } from '../packages/core/src/crypto/aead'
import type { KeyMaterial } from '../packages/core/src/crypto/kdf'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../packages/core/src/crypto/kdf'
import { type CredentialStore, openKeyCache } from '../packages/core/src/crypto/keyring'
import { rotateStore } from '../packages/core/src/crypto/rotate'
import { createHttpRemote, ProtocolVersionError } from '../packages/core/src/remote/http'
import type { Remote } from '../packages/core/src/remote/types'
import { KdfGenerationConflictError, parseManifest } from '../packages/core/src/remote/types'
import { SyncState, stateDbPath } from '../packages/core/src/state'
import {
  type DeviceLoginResult,
  loadCredentials,
  loginWithDeviceCode,
  type SyncCredentials,
  storeCredentials,
} from '../packages/core/src/sync/credentials'
import { SyncLoop, type SyncRunResult } from '../packages/core/src/sync/loop'
import { enqueueUpload } from '../packages/core/src/sync/queue'
import { file, testAdapter, tree } from '../packages/core/test/helpers/adapter-fixtures'
import { buildFakeHome, type FakeHome } from '../packages/core/test/helpers/fake-home'
import {
  type BlobRef,
  newId,
  PROTOCOL_VERSION,
  type RevisionId as RevisionIdType,
  type RevisionSummary,
} from '../packages/protocol/src/index'
import { createAuth } from '../packages/server/src/auth'
import { openDatabase } from '../packages/server/src/db/client'
import { loadEnv } from '../packages/server/src/env'
import { createApp } from '../packages/server/src/index'
import { createLogger } from '../packages/server/src/log'
import { createBlobStore, FsBlobStore } from '../packages/server/src/storage'

const NOW = '2026-09-19T12:00:00.000Z'
const PASSPHRASE = 'e2e-server-passphrase'
const ROTATED_PASSPHRASE = 'e2e-server-rotated-passphrase'
const WRONG_PASSPHRASE = 'e2e-server-not-the-passphrase'
const SECRET_CANARY = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'
const MARKER_LOCAL = 'A local secret'
const KDF: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 19_456,
  t: 2,
  p: 1,
  version: 0x13,
}
const ROTATED_KDF: KdfParams = { ...KDF, salt: '11'.repeat(16) }
const KEY = deriveMasterKey(PASSPHRASE, KDF)
const WRONG_KEY = deriveMasterKey(WRONG_PASSPHRASE, KDF)

let failures = 0
let stepNumber = 0

function step(label: string): void {
  stepNumber += 1
  console.log(`\n[${String(stepNumber).padStart(2, '0')}] ${label}`)
}

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}${detail === undefined ? '' : ` (${detail})`}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`)
}

function reasonFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-e2e-server-'))
}

function memoryKeychain(): CredentialStore {
  const entries = new Map<string, Uint8Array>()
  const key = (service: string, account: string): string => `${service}\u0000${account}`
  return {
    backend: 'keychain',
    get: async (service, account) => entries.get(key(service, account))?.slice() ?? null,
    set: async (service, account, secret) => {
      entries.set(key(service, account), secret.slice())
    },
    delete: async (service, account) => {
      entries.delete(key(service, account))
    },
  }
}

class Http {
  readonly baseUrl: string
  #cookies = new Map<string, string>()

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('origin', this.baseUrl)
    if (init.body !== undefined && typeof init.body === 'string' && !headers.has('content-type')) {
      headers.set('content-type', 'application/json')
    }
    if (this.#cookies.size > 0) {
      headers.set(
        'cookie',
        [...this.#cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      )
    }
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers,
      redirect: 'manual',
    })
    for (const raw of response.headers.getSetCookie()) {
      const [pair = ''] = raw.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const name = pair.slice(0, separator)
      const value = pair.slice(separator + 1)
      if (value === '') this.#cookies.delete(name)
      else this.#cookies.set(name, value)
    }
    return response
  }

  async ok(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.request(path, init)
    if (!response.ok) {
      throw new Error(`${init.method ?? 'GET'} ${path} failed with ${response.status}`)
    }
    return response
  }
}

interface ServerHandle {
  baseUrl: string
  storageDir: string
  dataDir: string
  storage: FsBlobStore
  start(): Promise<void>
  stop(): Promise<void>
  close(): Promise<void>
}

async function reservePort(): Promise<number> {
  const probe = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Response('ok'),
  })
  const port = probe.port
  await probe.stop(true)
  if (port === undefined) throw new Error('the probe server did not report a port')
  return port
}

async function bootServer(): Promise<ServerHandle> {
  const dataDir = tempDir()
  const port = await reservePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const env = loadEnv({
    NODE_ENV: 'test',
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: 'e2e-server-secret-0123456789abcdefghijklmnopqrstuvwxyz',
    ALLOW_DEV_SIGNIN: '1',
    DEVICE_POLL_INTERVAL: '0s',
    LOG_LEVEL: 'error',
    FS_STORAGE_DIR: path.join(dataDir, 'blobs'),
    FS_STORAGE_SECRET: 'e2e-fs-secret',
    FS_STORAGE_BASE_URL: baseUrl,
    PGLITE_DATA_DIR: path.join(dataDir, 'pglite'),
    RATE_LIMIT_CAPACITY: '1000',
    RATE_LIMIT_REFILL_PER_SECOND: '1000',
  })
  const handle = openDatabase(env)
  await handle.migrate()
  const storage = createBlobStore(env)
  if (!(storage instanceof FsBlobStore)) throw new Error('the harness needs the filesystem store')
  const auth = createAuth({ db: handle.db, env })
  const app = createApp({ env, db: handle.db, storage, auth, logger: createLogger('error') })
  let server: ReturnType<typeof Bun.serve> | null = null
  const start = async (): Promise<void> => {
    if (server !== null) return
    server = Bun.serve({ port, hostname: '127.0.0.1', fetch: app.fetch })
  }
  const stop = async (): Promise<void> => {
    if (server === null) return
    await server.stop(true)
    server = null
  }
  await start()
  return {
    baseUrl,
    storageDir: path.join(dataDir, 'blobs'),
    dataDir,
    storage,
    start,
    stop,
    close: async () => {
      await stop()
      await handle.close()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

function surfaces() {
  return [
    file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' }),
    file({
      id: 'claude.settings',
      path: '$HOME/.claude/settings.json',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
    }),
    tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
    tree({
      id: 'claude.shared-skills',
      path: '$HOME/.agents/skills',
      transforms: [{ kind: 'markerBlocks' }],
    }),
  ]
}

function sharedLayout() {
  return [
    { kind: 'dir' as const, path: '.claude' },
    { kind: 'dir' as const, path: '.agents/skills' },
    { kind: 'dir' as const, path: '.claude/skills', link: '$HOME/.agents/skills' },
    { kind: 'file' as const, path: '.claude/CLAUDE.md', content: '# shared rules\n' },
  ]
}

interface HomeBox {
  home: FakeHome
  credentials: SyncCredentials
}

async function enroll(
  http: Http,
  home: FakeHome,
  name: string,
  keychain: CredentialStore,
): Promise<DeviceLoginResult> {
  return loginWithDeviceCode({
    baseUrl: http.baseUrl,
    home: home.home,
    deviceName: name,
    platform: 'darwin',
    keychain,
    onPrompt: async (prompt) => {
      await http.ok(`/api/auth/device?user_code=${encodeURIComponent(prompt.userCode)}`)
      await http.ok('/api/auth/device/approve', {
        method: 'POST',
        body: JSON.stringify({ userCode: prompt.userCode }),
      })
    },
  })
}

async function openBox(
  home: FakeHome,
  login: DeviceLoginResult,
  keychain: CredentialStore,
  key: KeyMaterial,
): Promise<HomeBox> {
  const cache = await openKeyCache({ home: home.home, keychain })
  await cache.save(login.identity.storeId, key)
  const credentials = await loadCredentials({ home: home.home, keychain })
  return { home, credentials }
}

async function runHome(
  baseUrl: string,
  box: HomeBox,
  options: { remote?: Remote; key?: KeyMaterial } = {},
): Promise<SyncRunResult> {
  const key = options.key ?? box.credentials.key
  const state = SyncState.open({ path: stateDbPath(box.home.home) })
  try {
    const remote =
      options.remote ??
      createHttpRemote({
        baseUrl,
        storeId: box.credentials.storeId,
        token: box.credentials.token,
      })
    const loop = new SyncLoop({
      adapters: [testAdapter('claude', surfaces())],
      ctx: box.home.ctx,
      deviceId: box.credentials.deviceId,
      storeId: box.credentials.storeId,
      key,
      state,
      remote,
      quiescence: { windowMs: 0 },
    })
    return await loop.runOnce()
  } finally {
    state.close()
  }
}

function readStoreBytes(dir: string): string {
  const chunks: string[] = []
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else chunks.push(fs.readFileSync(full, 'latin1'))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return chunks.join('\n')
}

function pendingKinds(home: FakeHome): string[] {
  const state = SyncState.open({ path: stateDbPath(home.home) })
  try {
    return state.listPendingOps().map((op) => op.kind)
  } finally {
    state.close()
  }
}

async function main(): Promise<void> {
  const keychain = memoryKeychain()
  const server = await bootServer()
  const http = new Http(server.baseUrl)
  const a = buildFakeHome({
    entries: [
      ...sharedLayout(),
      {
        kind: 'file',
        path: '.claude/settings.json',
        content: '{\n  "model": "opus",\n  "theme": "dark"\n}\n',
      },
      { kind: 'dir', path: '.agents/skills/foo' },
      { kind: 'file', path: '.agents/skills/foo/SKILL.md', content: '# foo\n' },
      {
        kind: 'file',
        path: '.agents/skills/notes.md',
        content: `# Notes\n<!-- laurencio:local -->\n${MARKER_LOCAL}\n<!-- /laurencio:local -->\nshared line\n`,
      },
    ],
  })
  const b = buildFakeHome({
    entries: [
      ...sharedLayout(),
      {
        kind: 'file',
        path: '.claude/settings.json',
        content: '{\n  "model": "opus",\n  "theme": "light"\n}\n',
      },
      { kind: 'dir', path: '.agents/skills/bar' },
      { kind: 'file', path: '.agents/skills/bar/SKILL.md', content: '# bar\n' },
    ],
  })
  const c = buildFakeHome({ entries: [{ kind: 'dir', path: '.claude' }] })

  console.log('e2e:server: real Hono app, PGlite, filesystem blobs, two fake HOMEs')
  console.log(`  server: ${server.baseUrl}`)
  console.log(`  blobs:  ${server.storageDir}`)
  console.log(`  home A: ${a.home}`)
  console.log(`  home B: ${b.home}`)

  let boxA: HomeBox | null = null
  let boxB: HomeBox | null = null
  try {
    step('enroll two devices through the device flow')
    const signedIn = await http.request('/sign-in/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: 'e2e@example.com', next: '/account/devices' }).toString(),
    })
    check('dev sign-in succeeds', signedIn.status === 303 || signedIn.status === 200)
    const loginA = await enroll(http, a, 'e2e-home-a', keychain)
    const loginB = await enroll(http, b, 'e2e-home-b', keychain)
    check('device A got a token', loginA.token.startsWith('lrn_'))
    check('device B got a token', loginB.token.startsWith('lrn_'))
    check('both devices share one store', loginA.identity.storeId === loginB.identity.storeId)

    const kdfResponse = await http.request(`/v1/stores/${loginA.identity.storeId}/kdf-params`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${loginA.token}`,
        'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
      },
      body: JSON.stringify({ ...kdfParamsToWire(KDF, NOW), generation: null }),
    })
    check('kdf parameters are published', kdfResponse.ok, String(kdfResponse.status))

    boxA = await openBox(a, loginA, keychain, KEY)
    boxB = await openBox(b, loginB, keychain, KEY)
    check('credentials load from the keychain stub', boxA.credentials.token === loginA.token)

    step('sync A: seed the store')
    const firstA = await runHome(server.baseUrl, boxA)
    check('A reports synced', firstA.status === 'synced', firstA.status)
    check(
      'A uploaded rules and settings',
      firstA.report?.changed.includes('$HOME/.claude/CLAUDE.md') === true &&
        firstA.report.changed.includes('$HOME/.claude/settings.json') === true,
    )

    step('sync B: merge into the same store')
    const firstB = await runHome(server.baseUrl, boxB)
    check('B reports synced', firstB.status === 'synced', firstB.status)
    check('B kept its own theme edit', b.read('.claude/settings.json').includes('"theme": "light"'))
    check('B received A skills', b.read('.agents/skills/foo/SKILL.md') === '# foo\n')
    check(
      'B did not receive the A marker block',
      !b.read('.agents/skills/notes.md').includes(MARKER_LOCAL),
    )
    check('B link is still a symlink', fs.lstatSync(b.path('.claude/skills')).isSymbolicLink())

    step('sync A: converge on B')
    const secondA = await runHome(server.baseUrl, boxA)
    check('A reports synced', secondA.status === 'synced', secondA.status)
    check('A sees the B skill', a.read('.agents/skills/bar/SKILL.md') === '# bar\n')
    check('A sees the B theme', a.read('.claude/settings.json').includes('"theme": "light"'))
    check('A kept its marker block', a.read('.agents/skills/notes.md').includes(MARKER_LOCAL))
    check(
      'homes converge on the same settings',
      a.read('.claude/settings.json') === b.read('.claude/settings.json'),
    )

    step('ciphertext only in the store')
    const raw = readStoreBytes(server.storageDir)
    check('store holds blobs', fs.readdirSync(server.storageDir).length > 0)
    check('no plaintext instructions', !raw.includes('# shared rules'))
    check('no plaintext settings', !raw.includes('"theme": "dark"'))
    check('no marker body', !raw.includes(MARKER_LOCAL))
    const readRemote = createHttpRemote({
      baseUrl: server.baseUrl,
      storeId: boxA.credentials.storeId,
      token: boxA.credentials.token,
    })
    const headList = await readRemote.listRevisions()
    const headBytes = headList.head === null ? null : await readRemote.getManifest(headList.head)
    let wrongKeyFailed = false
    if (headBytes !== null) {
      try {
        openText(WRONG_KEY, 'manifest', headBytes, {
          storeId: boxA.credentials.storeId,
          blobType: 'manifest',
          protocolVersion: PROTOCOL_VERSION,
        })
      } catch (error) {
        wrongKeyFailed = error instanceof EnvelopeError && error.code === 'auth-failed'
      }
    }
    check('a wrong key fails authentication', wrongKeyFailed)

    step('secret canary is blocked and never stored')
    b.write('.agents/skills/creds.md', `token = "${SECRET_CANARY}"\n`)
    const blockedRun = await runHome(server.baseUrl, boxB)
    check(
      'B reports the path blocked',
      blockedRun.report?.blocked.includes('$HOME/.agents/skills/creds.md') === true,
    )
    check(
      'canary never reached the store',
      !readStoreBytes(server.storageDir).includes(SECRET_CANARY),
    )
    check('the local canary survives', fs.existsSync(b.path('.agents/skills/creds.md')))
    fs.rmSync(b.path('.agents/skills/creds.md'))
    await runHome(server.baseUrl, boxB)

    step('idempotent duplicate commit')
    const commitRemote = createHttpRemote({
      baseUrl: server.baseUrl,
      storeId: boxA.credentials.storeId,
      token: boxA.credentials.token,
    })
    const before = await commitRemote.listRevisions()
    const head = before.revisions.find((revision) => revision.id === before.head)
    if (head === undefined) throw new Error('expected a head revision')
    const manifestBlob = await commitRemote.getManifest(head.id)
    const manifest = parseManifest(
      JSON.parse(
        openText(boxA.credentials.key, 'manifest', manifestBlob, {
          storeId: boxA.credentials.storeId,
          blobType: 'manifest',
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    )
    const blobs: BlobRef[] = manifest.entries.flatMap((entry) =>
      entry.blob === undefined ? [] : [entry.blob],
    )
    const duplicate: RevisionSummary = {
      id: head.id,
      storeId: boxA.credentials.storeId,
      deviceId: head.deviceId,
      parents: head.parents,
      manifest: head.manifest,
      createdAt: head.createdAt,
    }
    const duplicateOnce = await commitRemote.commit({ revision: duplicate, blobs, digest: [] })
    const duplicateTwice = await commitRemote.commit({ revision: duplicate, blobs, digest: [] })
    check('both duplicate commits are accepted', duplicateOnce.accepted && duplicateTwice.accepted)
    check(
      'the duplicate adds no revision',
      (await commitRemote.listRevisions()).revisions.length === before.revisions.length,
    )

    step('wrong passphrase fails')
    await storeCredentials(
      { home: c.home, keychain },
      { identity: loginB.identity, token: loginB.token },
    )
    const wrongBox: HomeBox = {
      home: c,
      credentials: { ...boxB.credentials, key: WRONG_KEY },
    }
    const wrongRun = await runHome(server.baseUrl, wrongBox)
    check('wrong passphrase reports failed', wrongRun.status === 'failed', wrongRun.status)
    check(
      'the failure is an envelope auth failure',
      wrongRun.error?.code === 'auth-failed',
      wrongRun.error?.message ?? '',
    )

    step('protocol mismatch message')
    const future = createHttpRemote({
      baseUrl: server.baseUrl,
      storeId: boxA.credentials.storeId,
      token: boxA.credentials.token,
      protocolVersion: PROTOCOL_VERSION + 1,
    })
    try {
      await future.getKdfParams()
      check('protocol mismatch throws', false)
    } catch (error) {
      check('protocol mismatch throws ProtocolVersionError', error instanceof ProtocolVersionError)
      check(
        'the message names the protocol and the upgrade path',
        /protocol/i.test(reasonFor(error)) && /upgrade/i.test(reasonFor(error)),
        reasonFor(error),
      )
    }

    step('offline queue: stop the server, edit, queue a blob, reconnect')
    await server.stop()
    a.write('.claude/CLAUDE.md', '# shared rules\nA edited while offline\n')
    const queuedBlob = sealText(boxA.credentials.key, 'content', 'sealed while offline\n', {
      storeId: boxA.credentials.storeId,
      blobType: 'file',
      protocolVersion: PROTOCOL_VERSION,
    })
    const offlineState = SyncState.open({ path: stateDbPath(a.home) })
    enqueueUpload(
      offlineState,
      { id: queuedBlob.blobId, size: queuedBlob.bytes.length },
      queuedBlob.bytes,
      { createdAt: NOW },
    )
    offlineState.close()
    const offlineRun = await runHome(server.baseUrl, boxA)
    check('offline run reports offline', offlineRun.status === 'offline', offlineRun.status)
    check(
      'offline error is a transport error',
      offlineRun.error?.name === 'HttpRemoteError' && offlineRun.error?.code === 'network',
      offlineRun.error?.message ?? '',
    )
    check(
      'the offline run keeps both pending ops',
      pendingKinds(a).includes('sync') && pendingKinds(a).includes('upload'),
    )
    await server.start()
    const replayRun = await runHome(server.baseUrl, boxA)
    check('reconnected run replays the queue', replayRun.status === 'synced', replayRun.status)
    check('the queued blob op replayed', replayRun.queue.replayed.length === 1)
    const delivered = await readRemote.getBlob(queuedBlob.blobId)
    check(
      'the server holds the replayed ciphertext',
      openText(boxA.credentials.key, 'content', delivered, {
        storeId: boxA.credentials.storeId,
        blobType: 'file',
        protocolVersion: PROTOCOL_VERSION,
      }) === 'sealed while offline\n',
    )
    check(
      'queue is empty after replay',
      replayRun.queue.pending === 0 && pendingKinds(a).length === 0,
    )
    await runHome(server.baseUrl, boxB)
    check('B sees the offline edit', b.read('.claude/CLAUDE.md').includes('A edited while offline'))

    step('rotate the passphrase and publish generation 2')
    const rotateRemote = createHttpRemote({
      baseUrl: server.baseUrl,
      storeId: boxA.credentials.storeId,
      token: boxA.credentials.token,
    })
    const beforeRotate = await rotateRemote.listRevisions()
    const rotateHeadId = beforeRotate.heads[0]
    if (rotateHeadId === undefined) throw new Error('expected a head before rotation')
    const rotateHead = beforeRotate.revisions.find((revision) => revision.id === rotateHeadId)
    if (rotateHead === undefined) throw new Error('expected head metadata before rotation')
    const rotateHeadManifest = parseManifest(
      JSON.parse(
        openText(boxA.credentials.key, 'manifest', await rotateRemote.getManifest(rotateHeadId), {
          storeId: boxA.credentials.storeId,
          blobType: 'manifest',
          protocolVersion: PROTOCOL_VERSION,
        }),
      ),
    )
    const rotated = await rotateStore({
      remote: rotateRemote,
      storeId: boxA.credentials.storeId,
      protocolVersion: PROTOCOL_VERSION,
      deviceId: boxA.credentials.deviceId,
      master: boxA.credentials.key,
      head: {
        revisionId: rotateHeadId,
        parents: [...rotateHead.parents],
        manifest: rotateHeadManifest,
      },
      newRevisionId: newId() as RevisionIdType,
      newPassphrase: ROTATED_PASSPHRASE,
      createdAt: NOW,
      epoch: 1,
      calibrate: () => ROTATED_KDF,
    })
    let staleRejected = false
    try {
      await rotateRemote.putKdfParams({
        params: rotated.epoch.kdf,
        calibratedAt: rotated.epoch.createdAt,
        expectedGeneration: 2,
      })
    } catch (error) {
      staleRejected = error instanceof KdfGenerationConflictError && error.actual === 1
    }
    check('a stale KDF generation is rejected with 409', staleRejected)
    const afterStale = await rotateRemote.getKdfParams()
    check(
      'the rejected write changed nothing',
      afterStale?.generation === 1 && afterStale.kdf.salt === KDF.salt,
    )

    const published = await rotateRemote.putKdfParams({
      params: rotated.epoch.kdf,
      calibratedAt: rotated.epoch.createdAt,
      expectedGeneration: 1,
    })
    check('the rotation published generation 2', published.generation === 2)
    check(
      'the superseded parameters still resolve for audit',
      (await rotateRemote.getKdfParams({ version: 1 }))?.kdf.salt === KDF.salt,
    )
    rotated.master.zeroize()

    // A fresh device enrolls from the published parameters, not the old ones.
    const publishedKdf = await rotateRemote.getKdfParams()
    if (publishedKdf === null) throw new Error('expected published KDF parameters')
    const rotatedKey = deriveMasterKey(ROTATED_PASSPHRASE, publishedKdf.kdf)
    const newestHead = (await rotateRemote.listRevisions()).head
    const newestBytes = newestHead === null ? null : await rotateRemote.getManifest(newestHead)
    let enrollsWithNew = false
    if (newestBytes !== null) {
      try {
        parseManifest(
          JSON.parse(
            openText(rotatedKey, 'manifest', newestBytes, {
              storeId: boxA.credentials.storeId,
              blobType: 'manifest',
              protocolVersion: PROTOCOL_VERSION,
            }),
          ),
        )
        enrollsWithNew = true
      } catch {
        enrollsWithNew = false
      }
    }
    check('B enrolls with the new passphrase and decrypts the latest revision', enrollsWithNew)

    const staleOldKey = deriveMasterKey(PASSPHRASE, publishedKdf.kdf)
    let oldPassphraseFails = false
    if (newestBytes !== null) {
      try {
        openText(staleOldKey, 'manifest', newestBytes, {
          storeId: boxA.credentials.storeId,
          blobType: 'manifest',
          protocolVersion: PROTOCOL_VERSION,
        })
      } catch (error) {
        oldPassphraseFails = error instanceof EnvelopeError && error.code === 'auth-failed'
      }
    }
    check('the old passphrase fails with an auth failure', oldPassphraseFails)
    staleOldKey.zeroize()

    boxA = { ...boxA, credentials: { ...boxA.credentials, key: rotatedKey } }
    boxB = { ...boxB, credentials: { ...boxB.credentials, key: rotatedKey } }
    const rotatedA = await runHome(server.baseUrl, boxA)
    check('A syncs under the new key', rotatedA.status === 'synced' || rotatedA.status === 'idle')
    const rotatedB = await runHome(server.baseUrl, boxB)
    check('B syncs under the new key', rotatedB.status === 'synced' || rotatedB.status === 'idle')
    check(
      'both homes converge after the rotation',
      a.read('.claude/CLAUDE.md') === b.read('.claude/CLAUDE.md'),
    )

    step('revoked device fails clearly')
    const revoke = await http.request(`/v1/devices/${boxB.credentials.deviceId}`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${boxA.credentials.token}`,
        'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
      },
    })
    check('the device is revoked', revoke.ok, String(revoke.status))
    const revokedRun = await runHome(server.baseUrl, boxB)
    check('the revoked run reports failed', revokedRun.status === 'failed', revokedRun.status)
    check(
      'the revoked error tells the user to sign in again',
      revokedRun.error?.code === 'unauthenticated' &&
        /laurencio login/i.test(revokedRun.error?.message ?? ''),
      revokedRun.error?.message ?? '',
    )

    step('final convergence')
    const finalA = await runHome(server.baseUrl, boxA)
    check('A is idle after convergence', finalA.status === 'idle', finalA.status)
    check(
      'both homes hold the same instructions',
      a.read('.claude/CLAUDE.md') === b.read('.claude/CLAUDE.md'),
    )
  } finally {
    await server.close()
    a.cleanup()
    b.cleanup()
    c.cleanup()
  }

  console.log('')
  console.log(
    failures === 0
      ? `RESULT: all ${stepNumber} steps passed`
      : `RESULT: ${failures} failure(s) across ${stepNumber} steps`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
