#!/usr/bin/env bun

/**
 * Live smoke test against a deployed Laurencio server.
 *
 * Enrolls a device through the development sign-in path, publishes the KDF
 * parameters if the store has none, then pushes and pulls one encrypted
 * revision and asserts the server never holds plaintext. Requires
 * ALLOW_DEV_SIGNIN on the target; use it against staging, not production.
 *
 *   bun scripts/smoke-live.ts --base-url https://laurencio-staging.up.railway.app
 */

import { deriveMasterKey, type KdfParams } from '../packages/core/src/crypto/kdf'
import { crypto as coreCrypto, parseManifest } from '../packages/core/src/index'
import type { Manifest } from '../packages/core/src/model'
import { createHttpRemote } from '../packages/core/src/remote/http'
import {
  DeviceId,
  newId,
  PROTOCOL_VERSION,
  RevisionId,
  type StoreId,
  SurfaceId,
} from '../packages/protocol/src/index'

const PASSPHRASE = 'smoke-live-passphrase-2026'
const MARKER = 'laurencio-live-smoke-marker-7f3a'

interface Options {
  baseUrl: string
  devEmail: string
  deviceName: string
  clientId: string
}

function flag(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name)
  if (index === -1) return null
  return argv[index + 1] ?? null
}

function parseOptions(argv: readonly string[]): Options {
  const baseUrl = flag(argv, '--base-url')
  if (baseUrl === null) throw new Error('usage: bun scripts/smoke-live.ts --base-url <url>')
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    devEmail: flag(argv, '--dev-email') ?? 'smoke@example.com',
    deviceName: flag(argv, '--device-name') ?? 'live-smoke',
    clientId: flag(argv, '--client-id') ?? 'laurencio-cli',
  }
}

function readCookies(headers: Headers): string | null {
  const raw = headers.getSetCookie()
  if (raw.length === 0) return null
  return raw
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ')
}

async function enrollDevice(options: Options): Promise<{ token: string; storeId: StoreId }> {
  const codeResponse = await fetch(`${options.baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: options.clientId }),
  })
  if (!codeResponse.ok) throw new Error(`device code request failed: ${await codeResponse.text()}`)
  const code = (await codeResponse.json()) as { device_code: string; user_code: string }

  const signIn = await fetch(`${options.baseUrl}/sign-in/dev`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: options.baseUrl },
    body: new URLSearchParams({ email: options.devEmail, next: '/device' }).toString(),
    redirect: 'manual',
  })
  if (signIn.status !== 303 && !signIn.ok) {
    throw new Error(`dev sign-in failed (${signIn.status}); is ALLOW_DEV_SIGNIN set?`)
  }
  const cookie = readCookies(signIn.headers)
  if (cookie === null) throw new Error('dev sign-in returned no session cookie')

  const claim = await fetch(
    `${options.baseUrl}/api/auth/device?user_code=${encodeURIComponent(code.user_code)}`,
    { headers: { cookie, origin: options.baseUrl } },
  )
  if (!claim.ok) throw new Error(`claiming the device code failed: ${await claim.text()}`)

  const approve = await fetch(`${options.baseUrl}/api/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: options.baseUrl },
    body: JSON.stringify({ userCode: code.user_code }),
  })
  if (!approve.ok) throw new Error(`approving the device code failed: ${await approve.text()}`)

  const deadline = Date.now() + 30_000
  let sessionToken: string | null = null
  while (Date.now() < deadline && sessionToken === null) {
    const poll = await fetch(`${options.baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: options.clientId,
      }),
    })
    if (poll.ok) {
      const body = (await poll.json()) as { access_token?: string; session?: { token?: string } }
      sessionToken = body.access_token ?? body.session?.token ?? null
    } else if (poll.status !== 400) {
      throw new Error(`device token poll failed: ${poll.status} ${await poll.text()}`)
    }
    if (sessionToken === null) await Bun.sleep(400)
  }
  if (sessionToken === null) throw new Error('the device code was never approved')

  const enroll = await fetch(`${options.baseUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
      'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify({ name: options.deviceName, platform: `${process.platform}-smoke` }),
  })
  if (!enroll.ok) throw new Error(`device enrollment failed: ${await enroll.text()}`)
  const enrolled = (await enroll.json()) as { token: string; device: { id: string } }

  const me = await fetch(`${options.baseUrl}/v1/me`, {
    headers: {
      authorization: `Bearer ${enrolled.token}`,
      'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
    },
  })
  if (!me.ok) throw new Error(`/v1/me failed: ${await me.text()}`)
  const body = (await me.json()) as { storeId: StoreId }
  return { token: enrolled.token, storeId: body.storeId }
}

function check(name: string, ok: boolean, detail = ''): void {
  const suffix = detail === '' ? '' : ` (${detail})`
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${suffix}`)
  if (!ok) process.exitCode = 1
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv)
  console.log(`live smoke against ${options.baseUrl}`)
  const { token, storeId } = await enrollDevice(options)
  check('device enrolled through the dev sign-in path', true)

  const remote = createHttpRemote({ baseUrl: options.baseUrl, storeId, token })

  const kdf: KdfParams = {
    algo: 'argon2id',
    salt: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex'),
    m: 65_536,
    t: 3,
    p: 1,
    version: 0x13,
  }
  const existing = await remote.getKdfParams()
  if (existing === null) {
    const published = await remote.putKdfParams({ params: kdf })
    check(
      'kdf parameters published',
      published.generation >= 1,
      `generation ${published.generation}`,
    )
  } else {
    check('kdf parameters already published', true, `generation ${existing.generation}`)
  }

  const key = deriveMasterKey(PASSPHRASE, kdf)
  const deviceId = DeviceId.parse(newId())
  const revisionId = RevisionId.parse(newId())
  const surfaceId = SurfaceId.parse('smoke.live')
  const createdAt = new Date().toISOString()
  const context = { storeId, protocolVersion: PROTOCOL_VERSION } as const

  const fileText = `# live smoke\n\n${MARKER}\n`
  const fileSealed = coreCrypto.sealText(key, 'content', fileText, { ...context, blobType: 'file' })
  const fileRef = await remote.putBlob({ blobId: fileSealed.blobId, bytes: fileSealed.bytes })

  const manifest: Manifest = {
    revisionId,
    deviceId,
    createdAt,
    entries: [
      {
        surfaceId,
        path: 'smoke/hello.md',
        kind: 'file',
        hash: new Bun.CryptoHasher('sha256').update(fileText).digest('hex'),
        size: Buffer.byteLength(fileText),
        mode: 0o644,
        policy: 'sync',
      },
    ],
  }
  const manifestText = JSON.stringify(manifest)
  const manifestSealed = coreCrypto.sealText(key, 'manifest', manifestText, {
    ...context,
    blobType: 'manifest',
  })
  const manifestRef = await remote.putBlob({
    blobId: manifestSealed.blobId,
    bytes: manifestSealed.bytes,
  })

  const commit = await remote.commit({
    revision: {
      id: revisionId,
      storeId,
      deviceId,
      parents: [],
      manifest: manifestRef,
      createdAt,
    },
    blobs: [fileRef, manifestRef],
    digest: [{ surfaceId, files: 1, bytes: fileRef.size }],
  })
  check('revision committed', commit.accepted, `revision ${commit.revisionId.slice(-6)}`)

  const listed = await remote.listRevisions()
  check(
    'revision listed with one head',
    listed.revisions.some((item) => item.id === revisionId) && listed.heads.length === 1,
  )

  const fetchedManifest = parseManifest(
    JSON.parse(
      coreCrypto.openText(key, 'manifest', await remote.getManifest(revisionId), {
        ...context,
        blobType: 'manifest',
      }),
    ),
  )
  check('manifest decrypts with the passphrase', fetchedManifest.entries.length === 1)

  const fetchedFile = await remote.getBlob(fileRef.id)
  const opened = coreCrypto.openText(key, 'content', fetchedFile, { ...context, blobType: 'file' })
  check('file decrypts and matches', opened === fileText)

  const raw = new TextDecoder().decode(fetchedFile)
  check('stored bytes are ciphertext', !raw.includes(MARKER) && !raw.includes('live smoke'))

  console.log(process.exitCode === 1 ? 'live smoke failed' : 'live smoke passed')
}

await main()
