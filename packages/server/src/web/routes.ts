import { DeviceId } from '@laurencio/protocol'
import { type Context, Hono } from 'hono'
import { type Auth, getSession } from '../auth'
import type { AppBindings } from '../context'
import type { Database } from '../db/client'
import { listDevices, renameDevice, revokeDevice } from '../devices'
import type { ServerEnv } from '../env'
import { forbidden } from '../http/errors'
import { asUserId } from '../ids'
import { enforceRateLimit, type RateLimiter } from '../rate'
import {
  deviceConfirmPage,
  deviceDonePage,
  deviceEnterPage,
  devicesPage,
  revokeDevicePage,
  signInPage,
} from './pages'

export interface WebDeps {
  env: ServerEnv
  db: Database
  auth: Auth
  rateLimiter: RateLimiter
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'same-origin',
}

interface SessionUser {
  id: string
  name: string
  email: string
}

export function createWebRoutes(deps: WebDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  const allowedOrigins = collectOrigins(deps.env)

  // Forms are cookie-authenticated, so every browser POST has to come from an
  // origin this deployment owns. /api/auth keeps its own checks because the
  // CLI talks to it without an Origin header.
  app.use('*', async (c, next) => {
    if (c.req.method === 'POST' && !c.req.path.startsWith('/api/auth')) {
      const origin = c.req.header('origin')
      if (!origin || !allowedOrigins.has(origin)) {
        throw forbidden('cross-origin form submission rejected')
      }
      if (c.req.path === '/device' || c.req.path === '/device/decision') {
        enforceRateLimit(deps.rateLimiter, `device-approval:${clientAddress(c)}`)
      }
    }
    await next()
  })

  app.use('*', async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      c.res.headers.set(name, value)
    }
  })

  app.get('/', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    return c.redirect(user ? '/account/devices' : '/sign-in')
  })

  app.get('/sign-in', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (user) return c.redirect(safeNext(c.req.query('next')))
    return c.html(
      signInPage({
        next: safeNext(c.req.query('next')),
        allowDevSignin: deps.env.auth.allowDevSignin,
      }),
    )
  })

  app.post('/sign-in/dev', async (c) => {
    if (!deps.env.auth.allowDevSignin) return c.notFound()
    const body = await c.req.parseBody()
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
    const next = safeNext(typeof body.next === 'string' ? body.next : null)
    if (!email) return c.html(signInPageWithError(deps, next), 400)
    if (deps.env.nodeEnv === 'staging' && !deps.env.auth.stagingEmailAllowlist.includes(email)) {
      return c.html(
        signInPage({
          next,
          allowDevSignin: true,
          error: 'This email does not have staging access. Ask the server owner to add it.',
        }),
        403,
      )
    }
    const create = await forwardAuth(deps, c.req.raw.headers, 'POST', '/sign-up/email', {
      email,
      password: DEV_PASSWORD,
      name: email.split('@')[0] ?? email,
    })
    if (create.ok) return redirectWithCookies(next, create)
    const signIn = await forwardAuth(deps, c.req.raw.headers, 'POST', '/sign-in/email', {
      email,
      password: DEV_PASSWORD,
    })
    if (signIn.ok) return redirectWithCookies(next, signIn)
    return c.html(signInPageWithError(deps, next), 400)
  })

  app.post('/sign-out', async (c) => {
    const response = await forwardAuth(deps, c.req.raw.headers, 'POST', '/sign-out', {})
    return redirectWithCookies('/', response)
  })

  app.get('/device', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    const userCode = c.req.query('user_code') ?? ''
    const deviceName = (c.req.query('device_name') ?? '').slice(0, 80)
    const platform = (c.req.query('platform') ?? '').slice(0, 40)
    if (!user) {
      const params = new URLSearchParams()
      if (userCode) params.set('user_code', userCode)
      if (deviceName) params.set('device_name', deviceName)
      if (platform) params.set('platform', platform)
      const target = params.size ? `/device?${params}` : '/device'
      return c.redirect(`/sign-in?next=${encodeURIComponent(target)}`)
    }
    if (userCode) {
      enforceRateLimit(deps.rateLimiter, `device-approval:${clientAddress(c)}`)
      const page = await approvalPage(deps, c.req.raw.headers, userCode, user, {
        deviceName,
        platform,
      })
      return c.html(page.html, page.ok ? 200 : 400)
    }
    return c.html(deviceEnterPage({ userCode, user }))
  })

  app.post('/device', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    const body = await c.req.parseBody()
    const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : ''
    if (!user) {
      const target = userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : '/device'
      return c.redirect(`/sign-in?next=${encodeURIComponent(target)}`, 303)
    }
    if (!userCode)
      return c.html(deviceEnterPage({ error: 'Enter the code from your terminal.' }), 400)

    const page = await approvalPage(deps, c.req.raw.headers, userCode, user)
    return c.html(page.html, page.ok ? 200 : 400)
  })

  app.post('/device/decision', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    const body = await c.req.parseBody()
    const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : ''
    const decision = body.decision === 'deny' ? 'deny' : 'approve'
    if (!user)
      return c.redirect(
        `/sign-in?next=${encodeURIComponent(`/device?user_code=${encodeURIComponent(userCode)}`)}`,
        303,
      )
    if (!userCode) return c.html(deviceEnterPage({ error: 'Missing device code.' }), 400)
    const response = await forwardAuth(
      deps,
      c.req.raw.headers,
      'POST',
      decision === 'approve' ? '/device/approve' : '/device/deny',
      { userCode },
    )
    if (!response.ok) {
      const message = await authErrorMessage(response)
      return c.html(deviceEnterPage({ userCode, error: message }), 400)
    }
    return c.html(deviceDonePage({ approved: decision === 'approve', userCode, user }))
  })

  app.get('/account/devices', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (!user) return c.redirect('/sign-in?next=%2Faccount%2Fdevices')
    const devices = await listDevices(deps.db, asUserId(user.id), { includeRevoked: true })
    const flash = c.req.query('flash')
    return c.html(
      devicesPage({
        user: { name: user.name, email: user.email },
        devices: devices.map((device) => ({
          id: device.id,
          name: device.name,
          platform: device.platform,
          createdAt: device.createdAt,
          lastSeenAt: device.lastSeenAt ?? null,
          revokedAt: device.revokedAt ?? null,
        })),
        ...(flash ? { flash } : {}),
      }),
    )
  })

  app.post('/account/devices/:id/rename', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (!user) return c.redirect('/sign-in?next=%2Faccount%2Fdevices')
    const deviceId = DeviceId.safeParse(c.req.param('id'))
    const body = await c.req.parseBody()
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!deviceId.success || !name || name.length > 80)
      return c.redirect('/account/devices?flash=Invalid+rename', 303)
    try {
      await renameDevice(deps.db, { userId: asUserId(user.id), deviceId: deviceId.data, name })
      return c.redirect('/account/devices?flash=Device+renamed', 303)
    } catch {
      return c.redirect('/account/devices?flash=Unknown+device', 303)
    }
  })

  app.get('/account/devices/:id/revoke', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (!user) return c.redirect('/sign-in?next=%2Faccount%2Fdevices')
    const device = (await listDevices(deps.db, asUserId(user.id))).find(
      (item) => item.id === c.req.param('id'),
    )
    if (!device) return c.redirect('/account/devices?flash=Unknown+device')
    return c.html(
      revokeDevicePage({
        user,
        device: { ...device, lastSeenAt: device.lastSeenAt ?? null, revokedAt: null },
      }),
    )
  })

  app.post('/account/devices/:id/revoke', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (!user) return c.redirect('/sign-in?next=%2Faccount%2Fdevices')
    const deviceId = DeviceId.safeParse(c.req.param('id'))
    if (!deviceId.success) return c.redirect('/account/devices?flash=Invalid+device', 303)
    const body = await c.req.parseBody()
    if (body.confirm !== deviceId.data)
      return c.redirect(`/account/devices/${deviceId.data}/revoke`, 303)
    try {
      await revokeDevice(deps.db, {
        userId: asUserId(user.id),
        deviceId: deviceId.data,
        actorUserId: asUserId(user.id),
      })
      return c.redirect('/account/devices?flash=Device+revoked', 303)
    } catch {
      return c.redirect('/account/devices?flash=Unknown+device', 303)
    }
  })

  return app
}

export const DEV_PASSWORD = 'laurencio-dev-password'

async function approvalPage(
  deps: WebDeps,
  headers: Headers,
  userCode: string,
  user: SessionUser,
  display: { deviceName: string; platform: string } = { deviceName: '', platform: '' },
): Promise<{ html: string; ok: boolean }> {
  const response = await forwardAuth(
    deps,
    headers,
    'GET',
    `/device?user_code=${encodeURIComponent(userCode)}`,
    null,
  )
  if (!response.ok)
    return {
      ok: false,
      html: deviceEnterPage({ userCode, user, error: await authErrorMessage(response) }),
    }
  const payload = (await response.json()) as {
    user_code?: string
    client_id?: string
    scope?: string
    status?: string
  }
  const code = payload.user_code ?? userCode
  if (payload.status === 'approved' || payload.status === 'denied') {
    return {
      ok: true,
      html: deviceDonePage({ approved: payload.status === 'approved', userCode: code, user }),
    }
  }
  return {
    ok: true,
    html: deviceConfirmPage({
      ...display,
      userCode: code,
      user,
      clientId: payload.client_id ?? null,
      scope: payload.scope ?? null,
    }),
  }
}

async function sessionUser(deps: WebDeps, headers: Headers): Promise<SessionUser | null> {
  const session = await getSession(deps.auth, headers)
  if (!session?.user) return null
  return { id: session.user.id, name: session.user.name, email: session.user.email }
}

/** Proxies a request through Better Auth so cookie handling stays in one place. */
async function forwardAuth(
  deps: WebDeps,
  sourceHeaders: Headers,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
): Promise<Response> {
  const base = new URL(deps.env.publicUrl)
  const headers = new Headers({ origin: base.origin })
  const cookie = sourceHeaders.get('cookie')
  if (cookie) headers.set('cookie', cookie)
  const init: RequestInit = { method, headers }
  if (body !== null) {
    headers.set('content-type', 'application/json')
    init.body = JSON.stringify(body)
  }
  return deps.auth.handler(new Request(new URL(`/api/auth${path}`, base).toString(), init))
}

function redirectWithCookies(location: string, source: Response): Response {
  const headers = new Headers({ location })
  for (const cookie of source.headers.getSetCookie()) headers.append('set-cookie', cookie)
  return new Response(null, { status: 303, headers })
}

async function authErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string; error_description?: string }
    return payload.error_description ?? payload.message ?? 'That code is not valid or has expired.'
  } catch {
    return 'That code is not valid or has expired.'
  }
}

function signInPageWithError(deps: WebDeps, next: string): string {
  return signInPage({
    next,
    allowDevSignin: deps.env.auth.allowDevSignin,
    error: 'Sign-in failed.',
  })
}

function collectOrigins(env: ServerEnv): Set<string> {
  const origins = new Set<string>()
  const base = originOf(env.publicUrl)
  if (base) origins.add(base)
  for (const trusted of env.trustedOrigins) {
    const origin = originOf(trusted) ?? trusted
    if (origin.length > 0) origins.add(origin)
  }
  return origins
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function clientAddress(c: Context<AppBindings>): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
  return forwarded || c.req.header('x-real-ip') || 'unknown'
}

const FALLBACK_NEXT = '/account/devices'
const MAX_DECODE_PASSES = 3

/**
 * Only same-origin relative paths starting with a single slash survive.
 * Absolute URLs, scheme-relative paths, backslashes, control characters, and
 * their percent-encoded variants all fall back to the devices page.
 */
export function safeNext(value: string | null | undefined): string {
  if (!value) return FALLBACK_NEXT
  let decoded = value
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(decoded)
    } catch {
      return FALLBACK_NEXT
    }
    if (next === decoded) break
    decoded = next
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return FALLBACK_NEXT
  if (decoded.includes('\\')) return FALLBACK_NEXT
  if (/\p{Cc}/u.test(decoded) || /\s/u.test(decoded.split(/[?#]/)[0] ?? '')) return FALLBACK_NEXT
  // Validate decoded input, but keep query escaping for names such as "Mac mini".
  // Returning the decoded string would corrupt nested return URLs and device names.
  return value
}
