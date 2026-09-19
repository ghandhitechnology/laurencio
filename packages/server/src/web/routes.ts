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
    if (user) return c.redirect('/account/devices')
    return c.html(
      signInPage({
        next: safeNext(c.req.query('next')),
        allowDevSignin: deps.env.auth.allowDevSignin,
      }),
    )
  })

  app.post('/sign-in/github', async (c) => {
    const body = await c.req.parseBody()
    const next = safeNext(typeof body.next === 'string' ? body.next : null)
    const response = await forwardAuth(deps, c.req.raw.headers, 'POST', '/sign-in/social', {
      provider: 'github',
      callbackURL: next,
    })
    if (!response.ok) return c.html(signInPageWithError(deps, next), 400)
    const payload = (await response.json()) as { url?: string }
    if (!payload.url) return c.html(signInPageWithError(deps, next), 502)
    // Better Auth sets its OAuth state cookie on this response; dropping it makes the
    // callback fail with a state mismatch, so the redirect carries the cookies forward.
    const headers = new Headers({ location: payload.url })
    for (const cookie of response.headers.getSetCookie()) headers.append('set-cookie', cookie)
    return new Response(null, { status: 302, headers })
  })

  app.post('/sign-in/dev', async (c) => {
    if (!deps.env.auth.allowDevSignin) return c.notFound()
    const body = await c.req.parseBody()
    const email = typeof body.email === 'string' ? body.email.trim() : ''
    const next = safeNext(typeof body.next === 'string' ? body.next : null)
    if (!email) return c.html(signInPageWithError(deps, next), 400)
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
    if (!user) {
      const target = userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : '/device'
      return c.redirect(`/sign-in?next=${encodeURIComponent(target)}`)
    }
    return c.html(deviceEnterPage({ userCode }))
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

    const response = await forwardAuth(
      deps,
      c.req.raw.headers,
      'GET',
      `/device?user_code=${encodeURIComponent(userCode)}`,
      null,
    )
    if (!response.ok) {
      const message = await authErrorMessage(response)
      return c.html(deviceEnterPage({ userCode, error: message }), 400)
    }
    const payload = (await response.json()) as {
      user_code?: string
      client_id?: string
      scope?: string
      status?: string
    }
    const code = payload.user_code ?? userCode
    if (payload.status === 'approved')
      return c.html(deviceDonePage({ approved: true, userCode: code }))
    if (payload.status === 'denied')
      return c.html(deviceDonePage({ approved: false, userCode: code }))
    return c.html(
      deviceConfirmPage({
        userCode: code,
        clientId: payload.client_id ?? null,
        scope: payload.scope ?? null,
      }),
    )
  })

  app.post('/device/decision', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    const body = await c.req.parseBody()
    const userCode = typeof body.user_code === 'string' ? body.user_code.trim() : ''
    const decision = body.decision === 'deny' ? 'deny' : 'approve'
    if (!user) return c.redirect('/sign-in?next=%2Fdevice', 303)
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
    return c.html(deviceDonePage({ approved: decision === 'approve', userCode }))
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
    if (!deviceId.success || !name) return c.redirect('/account/devices?flash=Invalid+rename', 303)
    try {
      await renameDevice(deps.db, { userId: asUserId(user.id), deviceId: deviceId.data, name })
      return c.redirect('/account/devices?flash=Device+renamed', 303)
    } catch {
      return c.redirect('/account/devices?flash=Unknown+device', 303)
    }
  })

  app.post('/account/devices/:id/revoke', async (c) => {
    const user = await sessionUser(deps, c.req.raw.headers)
    if (!user) return c.redirect('/sign-in?next=%2Faccount%2Fdevices')
    const deviceId = DeviceId.safeParse(c.req.param('id'))
    if (!deviceId.success) return c.redirect('/account/devices?flash=Invalid+device', 303)
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
  if (/\s|\p{Cc}/u.test(decoded)) return FALLBACK_NEXT
  return decoded
}
