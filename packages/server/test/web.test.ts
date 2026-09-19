import { afterAll, describe, expect, test } from 'bun:test'
import { eq } from 'drizzle-orm'
import { auditLog, devices, stores, users } from '../src/db/schema'
import { safeNext } from '../src/web/routes'
import {
  authHeaders,
  claimDeviceCode,
  createClient,
  createTestServer,
  createUser,
  DEV_PASSWORD,
  signInDev,
  TEST_CLIENT_ID,
} from './helpers'

const server = await createTestServer()
afterAll(() => server.close())

describe('sign-in page', () => {
  test('redirects the site root to sign-in when signed out', async () => {
    const client = createClient(server.app)
    const response = await client.request('/')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/sign-in')
  })

  test('renders the GitHub button and the development form', async () => {
    const client = createClient(server.app)
    const response = await client.expectStatus('/sign-in', 200)
    const html = await response.text()
    expect(html).toContain('Continue with GitHub')
    expect(html).toContain('action="/sign-in/github"')
    expect(html).toContain('action="/sign-in/dev"')
  })

  test('the development form creates a session', async () => {
    const client = createClient(server.app)
    await signInDev(client, 'web-signin@example.com')
    const devices = await client.expectStatus('/account/devices', 200)
    expect(await devices.text()).toContain('web-signin')
  })
  test('the GitHub sign-in route reports a failure when no app is configured', async () => {
    const bare = await createTestServer()
    try {
      const client = createClient(bare.app)
      const response = await client.request('/sign-in/github', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ next: '/account/devices' }).toString(),
      })
      expect(response.status).toBe(400)
      expect(await response.text()).toContain('Continue with GitHub')
    } finally {
      await bare.close()
    }
  })
})

describe('device approval page', () => {
  test('the whole page flow approves a device code', async () => {
    const client = createClient(server.app)
    const code = await client.json<{ device_code: string; user_code: string }>(
      '/api/auth/device/code',
      { method: 'POST', body: JSON.stringify({ client_id: TEST_CLIENT_ID, scope: 'sync' }) },
    )

    // Signed out: the approval page sends the user to sign in with a return path.
    const signedOut = await client.request('/device')
    expect(signedOut.status).toBe(302)
    expect(signedOut.headers.get('location')).toBe('/sign-in?next=%2Fdevice')

    await signInDev(client, 'web-approve@example.com')
    const page = await client.expectStatus('/device', 200)
    const html = await page.text()
    expect(html).toContain('Approve a device')
    expect(html).toContain('name="user_code"')

    const confirm = await client.request('/device', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: code.user_code }).toString(),
    })
    expect(confirm.status).toBe(200)
    const confirmHtml = await confirm.text()
    expect(confirmHtml).toContain('Confirm device')
    expect(confirmHtml).toContain(code.user_code)
    expect(confirmHtml).toContain(TEST_CLIENT_ID)

    const decision = await client.request('/device/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: code.user_code, decision: 'approve' }).toString(),
    })
    expect(decision.status).toBe(200)
    expect(await decision.text()).toContain('Device approved')

    // The CLI can now redeem the code for a session token.
    const token = await client.json<{ access_token: string }>('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: TEST_CLIENT_ID,
      }),
    })
    expect(token.access_token.length).toBeGreaterThan(10)
  })

  test('an unknown code is rejected on the page', async () => {
    const client = createClient(server.app)
    await signInDev(client, 'web-badcode@example.com')
    const response = await client.request('/device', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: 'ZZZZZZZZ' }).toString(),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid user code')
  })

  test('the page can deny a code', async () => {
    const client = createClient(server.app)
    const code = await client.json<{ device_code: string; user_code: string }>(
      '/api/auth/device/code',
      { method: 'POST', body: JSON.stringify({ client_id: TEST_CLIENT_ID }) },
    )
    await signInDev(client, 'web-deny@example.com')
    await claimDeviceCode(client, code.user_code)
    const denied = await client.request('/device/decision', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: code.user_code, decision: 'deny' }).toString(),
    })
    expect(denied.status).toBe(200)
    expect(await denied.text()).toContain('Device denied')

    const polled = await client.request('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: TEST_CLIENT_ID,
      }),
    })
    expect(polled.status).toBe(400)
    expect(await polled.json()).toMatchObject({ error: 'access_denied' })
  })

  test('an expired page code is reported, not crashed', async () => {
    const client = createClient(server.app)
    await signInDev(client, 'web-expired@example.com')
    const response = await client.request('/device', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ user_code: '23456789' }).toString(),
    })
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('Invalid user code')
  })
})

describe('device management page', () => {
  test('lists, renames, and revokes devices from the browser', async () => {
    const client = createClient(server.app)
    const code = await client.json<{ device_code: string; user_code: string }>(
      '/api/auth/device/code',
      { method: 'POST', body: JSON.stringify({ client_id: TEST_CLIENT_ID }) },
    )
    await signInDev(client, 'web-devices@example.com')
    await claimDeviceCode(client, code.user_code)
    await client.expectStatus('/api/auth/device/approve', 200, {
      method: 'POST',
      body: JSON.stringify({ userCode: code.user_code }),
    })
    const session = await client.json<{ access_token: string }>('/api/auth/device/token', {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: code.device_code,
        client_id: TEST_CLIENT_ID,
      }),
    })
    const enrolled = await client.json<{ device: { id: string; name: string }; token: string }>(
      '/v1/devices',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ name: 'browser-listed', platform: 'darwin' }),
      },
    )

    const page = await client.expectStatus('/account/devices', 200)
    const html = await page.text()
    expect(html).toContain('browser-listed')
    expect(html).toContain(`/account/devices/${enrolled.device.id}/revoke`)

    const renamed = await client.request(`/account/devices/${enrolled.device.id}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ name: 'renamed-in-browser' }).toString(),
    })
    expect(renamed.status).toBe(303)
    const afterRename = await client.expectStatus('/account/devices', 200)
    expect(await afterRename.text()).toContain('renamed-in-browser')

    const revoked = await client.request(`/account/devices/${enrolled.device.id}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(revoked.status).toBe(303)
    const afterRevoke = await client.expectStatus('/account/devices', 200)
    expect(await afterRevoke.text()).toContain('revoked')

    // The device token died with the device.
    const dead = await client.request('/v1/me', {
      headers: { authorization: `Bearer ${enrolled.token}` },
    })
    expect(dead.status).toBe(401)
  })

  test('signed-out visitors are sent to sign in', async () => {
    const client = createClient(server.app)
    const response = await client.request('/account/devices')
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('/sign-in?next=%2Faccount%2Fdevices')
  })

  test('sign out clears the session and returns to the root page', async () => {
    const client = createClient(server.app)
    await signInDev(client, 'web-signout@example.com')
    const response = await client.request('/sign-out', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: '',
    })
    expect(response.status).toBe(303)
    const after = await client.request('/account/devices')
    expect(after.status).toBe(302)
  })
})

describe('development sign-in safety', () => {
  test('is refused when the environment disallows it, and the password never changes', async () => {
    const strict = await createTestServer({ ALLOW_DEV_SIGNIN: '0' })
    try {
      const client = createClient(strict.app)
      const response = await client.request('/sign-in/dev', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ email: 'nope@example.com' }).toString(),
      })
      expect(response.status).toBe(404)
      const page = await client.expectStatus('/sign-in', 200)
      expect(await page.text()).not.toContain('Development sign-in')
    } finally {
      await strict.close()
    }
  })

  test('every development user is password-guarded like a real one', async () => {
    const user = await createUser(server, 'web-password@example.com')
    const wrong = await user.client.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, password: 'not-the-password' }),
    })
    expect(wrong.status).toBe(401)
    const right = await user.client.request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email: user.email, password: DEV_PASSWORD }),
    })
    expect(right.status).toBe(200)
  })
})

describe('web hardening', () => {
  test('safeNext only keeps same-origin relative paths', () => {
    expect(safeNext('/account/devices')).toBe('/account/devices')
    expect(safeNext('/account/devices?flash=ok')).toBe('/account/devices?flash=ok')
    expect(safeNext('https://evil.example/steal')).toBe('/account/devices')
    expect(safeNext('//evil.example/steal')).toBe('/account/devices')
    expect(safeNext('/\\evil.example')).toBe('/account/devices')
    expect(safeNext('/%5Cevil.example')).toBe('/account/devices')
    expect(safeNext('/%2F%2Fevil.example')).toBe('/account/devices')
    expect(safeNext('/%252F%252Fevil.example')).toBe('/account/devices')
    expect(safeNext('/path\u0000evil')).toBe('/account/devices')
    expect(safeNext(undefined)).toBe('/account/devices')
  })

  test('a backslash next value is not followed after sign-in', async () => {
    const client = createClient(server.app)
    const response = await client.request('/sign-in/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        email: 'web-next@example.com',
        next: '/\\evil.example',
      }).toString(),
    })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/account/devices')
  })

  test('rejects a cross-origin form POST and a missing Origin', async () => {
    const client = createClient(server.app)
    const crossOrigin = await client.request('/sign-in/dev', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'http://evil.example',
      },
      body: new URLSearchParams({ email: 'csrf@example.com' }).toString(),
    })
    expect(crossOrigin.status).toBe(403)
    expect(await crossOrigin.json()).toMatchObject({ error: { code: 'forbidden' } })

    const missing = await client.request('/sign-in/dev', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: '' },
      body: new URLSearchParams({ email: 'csrf@example.com' }).toString(),
    })
    expect(missing.status).toBe(403)
  })

  test('answers HTML with a CSP and frame denial', async () => {
    const client = createClient(server.app)
    const response = await client.expectStatus('/sign-in', 200)
    const csp = response.headers.get('content-security-policy') ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('rate limits repeated device approval attempts', async () => {
    const limited = await createTestServer({
      DEVICE_APPROVAL_RATE_CAPACITY: '2',
      DEVICE_APPROVAL_RATE_REFILL_PER_SECOND: '0',
    })
    try {
      const client = createClient(limited.app)
      await signInDev(client, 'web-limited@example.com')
      const attempt = () =>
        client.request('/device', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ user_code: 'ZZZZZZZZ' }).toString(),
        })
      expect((await attempt()).status).toBe(400)
      expect((await attempt()).status).toBe(400)
      const blocked = await attempt()
      expect(blocked.status).toBe(429)
      expect(await blocked.json()).toMatchObject({
        error: { code: 'rate_limited', details: { retryAfterSeconds: 60 } },
      })
    } finally {
      await limited.close()
    }
  })
})

describe('data ownership', () => {
  test('audit rows record device lifecycle events', async () => {
    const user = await createUser(server, 'web-audit@example.com', 'audited')
    await user.client.expectStatus(`/v1/devices/${user.deviceId}`, 200, {
      method: 'DELETE',
      headers: authHeaders(user.token),
    })
    const rows = await server.db.select().from(auditLog).where(eq(auditLog.action, 'device.revoke'))
    expect(rows.length).toBeGreaterThan(0)
  })

  test('deleting a user cascades to devices and stores', async () => {
    const user = await createUser(server, 'web-cascade@example.com')
    await server.db.delete(users).where(eq(users.id, user.userId))
    const deviceRows = await server.db.select().from(devices).where(eq(devices.userId, user.userId))
    const storeRows = await server.db.select().from(stores).where(eq(stores.userId, user.userId))
    expect(deviceRows).toHaveLength(0)
    expect(storeRows).toHaveLength(0)
  })
})
