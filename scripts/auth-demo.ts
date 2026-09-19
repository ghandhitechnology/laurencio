/**
 * Walks the RFC 8628 device authorization flow against a running server the
 * way the CLI will: request a code, have it approved, exchange it for a
 * session, enroll this device, and prove the device token works.
 *
 *   bun scripts/auth-demo.ts --dev-email you@example.com
 *
 * Without --dev-email the script prints the verification URL and waits for a
 * human to approve the code in the browser.
 */
import { PROTOCOL_VERSION } from '../packages/protocol/src/index'

interface DeviceCodeResponse {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  interval: number
}

interface DeviceEnrollment {
  device: { id: string; name: string }
  token: string
}

interface Options {
  baseUrl: string
  clientId: string
  deviceName: string
  platform: string
  devEmail: string | null
  timeoutSeconds: number
}

function parseOptions(argv: string[]): Options {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    if (index === -1) return undefined
    return argv[index + 1]
  }
  return {
    baseUrl: (
      flag('--base-url') ??
      process.env.LAURENCIO_SERVER ??
      'http://localhost:8787'
    ).replace(/\/$/, ''),
    clientId: flag('--client-id') ?? 'laurencio-cli',
    deviceName: flag('--name') ?? 'auth-demo',
    platform: flag('--platform') ?? process.platform,
    devEmail: flag('--dev-email') ?? null,
    timeoutSeconds: Number(flag('--timeout-seconds') ?? '600'),
  }
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2))
  const code = await requestCode(options)
  process.stdout.write(`Open ${code.verification_uri} and enter code ${code.user_code}\n`)

  // Better Auth checks the Origin against the server's own base URL, which is
  // what it put in the verification URI. The client's --base-url may be an
  // alias (127.0.0.1 versus localhost), so take the origin from the server.
  const authOrigin = new URL(code.verification_uri).origin
  let cookie: string | null = null
  if (options.devEmail) {
    cookie = await devSignIn(options, authOrigin, options.devEmail)
    await claimCode(options, authOrigin, code.user_code, cookie)
    await approveCode(options, authOrigin, code.user_code, cookie)
    process.stdout.write('Approved with the development sign-in path.\n')
  } else {
    const complete = code.verification_uri_complete ?? code.verification_uri
    process.stdout.write(`Waiting for approval. Complete URL: ${complete}\n`)
  }

  const deadline = Date.now() + options.timeoutSeconds * 1000
  let intervalMs = Math.max(code.interval, 1) * 1000
  let sessionToken: string | null = null
  while (sessionToken === null) {
    if (Date.now() > deadline) throw new Error('timed out waiting for approval')
    await sleep(intervalMs)
    const poll = await fetch(`${options.baseUrl}/api/auth/device/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: options.clientId,
      }),
    })
    const payload = (await poll.json()) as { access_token?: string; error?: string }
    if (poll.ok && payload.access_token) {
      sessionToken = payload.access_token
      break
    }
    if (payload.error === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (payload.error === 'authorization_pending') continue
    throw new Error(`device authorization failed: ${payload.error ?? poll.status}`)
  }

  const device = await enrollDevice(options, sessionToken)
  const me = await apiGet(options, '/v1/me', device.token)
  process.stdout.write(`Enrolled device ${device.device.name} (${device.device.id}).\n`)
  process.stdout.write(`Store ${(me as { storeId: string }).storeId}.\n`)
  process.stdout.write(`Device token: ${device.token}\n`)
}

async function requestCode(options: Options): Promise<DeviceCodeResponse> {
  const response = await fetch(`${options.baseUrl}/api/auth/device/code`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: options.clientId }),
  })
  if (!response.ok) throw new Error(`device code request failed: ${await response.text()}`)
  return (await response.json()) as DeviceCodeResponse
}

async function devSignIn(options: Options, origin: string, email: string): Promise<string> {
  const response = await fetch(`${options.baseUrl}/sign-in/dev`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin,
    },
    body: new URLSearchParams({ email, next: '/device' }).toString(),
    redirect: 'manual',
  })
  if (response.status !== 303 && !response.ok) {
    throw new Error(
      `development sign-in failed (${response.status}); enable ALLOW_DEV_SIGNIN or sign in yourself: ${await response.text()}`,
    )
  }
  const cookie = readSetCookie(response.headers)
  if (!cookie) throw new Error('development sign-in returned no session cookie')
  return cookie
}

async function claimCode(
  options: Options,
  origin: string,
  userCode: string,
  cookie: string,
): Promise<void> {
  const response = await fetch(
    `${options.baseUrl}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
    { headers: { cookie, origin } },
  )
  if (!response.ok) throw new Error(`claiming the code failed: ${await response.text()}`)
}

async function approveCode(
  options: Options,
  origin: string,
  userCode: string,
  cookie: string,
): Promise<void> {
  const response = await fetch(`${options.baseUrl}/api/auth/device/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin },
    body: JSON.stringify({ userCode }),
  })
  if (!response.ok) throw new Error(`approving the code failed: ${await response.text()}`)
}

async function enrollDevice(options: Options, sessionToken: string): Promise<DeviceEnrollment> {
  const response = await fetch(`${options.baseUrl}/v1/devices`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${sessionToken}`,
      'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
    },
    body: JSON.stringify({ name: options.deviceName, platform: options.platform }),
  })
  if (!response.ok) throw new Error(`device enrollment failed: ${await response.text()}`)
  return (await response.json()) as DeviceEnrollment
}

async function apiGet(options: Options, path: string, deviceToken: string): Promise<unknown> {
  const response = await fetch(`${options.baseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${deviceToken}`,
      'x-laurencio-protocol-version': String(PROTOCOL_VERSION),
    },
  })
  if (!response.ok) throw new Error(`${path} failed: ${await response.text()}`)
  return response.json()
}

function readSetCookie(headers: Headers): string | null {
  const raw = headers.getSetCookie()
  if (raw.length === 0) return null
  return raw
    .map((cookie) => cookie.split(';')[0] ?? '')
    .filter((pair) => pair.includes('='))
    .join('; ')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${message}\n`)
  process.exit(1)
})
