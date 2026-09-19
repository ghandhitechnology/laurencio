import { afterAll, describe, expect, test } from 'bun:test'
import { enforceRateLimit, RateLimiter } from '../src/rate'
import { authHeaders, blobIdFor, bytesFor, createTestServer, createUser } from './helpers'

describe('token bucket', () => {
  test('allows the burst, then denies until tokens refill', () => {
    let now = 1_000_000
    const limiter = new RateLimiter({ capacity: 2, refillPerSecond: 1, now: () => now })
    expect(limiter.take('k').allowed).toBe(true)
    expect(limiter.take('k').allowed).toBe(true)
    const denied = limiter.take('k')
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBe(1)

    now += 1000
    expect(limiter.take('k').allowed).toBe(true)
  })

  test('keys are independent', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 1 })
    expect(limiter.take('a').allowed).toBe(true)
    expect(limiter.take('a').allowed).toBe(false)
    expect(limiter.take('b').allowed).toBe(true)
  })

  test('enforceRateLimit throws the typed error with a retry hint', () => {
    const limiter = new RateLimiter({ capacity: 1, refillPerSecond: 0 })
    enforceRateLimit(limiter, 'key')
    try {
      enforceRateLimit(limiter, 'key')
      throw new Error('expected enforceRateLimit to throw')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('rate_limited')
      expect((error as { details?: { retryAfterSeconds?: number } }).details).toMatchObject({
        retryAfterSeconds: 60,
      })
    }
  })
})

describe('rate limited writes', () => {
  const server = createTestServer({
    RATE_LIMIT_CAPACITY: '2',
    RATE_LIMIT_REFILL_PER_SECOND: '0',
  })
  afterAll(async () => {
    const resolved = await server
    await resolved.close()
  })

  test('a write burst returns 429 after the bucket empties', async () => {
    const resolved = await server
    const user = await createUser(resolved, 'rate@example.com')
    const payload = (label: string) =>
      JSON.stringify({ blob: { id: blobIdFor(bytesFor(label)), size: 4 } })

    const first = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: payload('rate-a'),
    })
    const second = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: payload('rate-b'),
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)

    const third = await user.client.request(`/v1/stores/${user.storeId}/blobs/presign`, {
      method: 'POST',
      headers: authHeaders(user.token),
      body: payload('rate-c'),
    })
    expect(third.status).toBe(429)
    expect(await third.json()).toMatchObject({
      error: { code: 'rate_limited', details: { retryAfterSeconds: 60 } },
    })

    // Reads are not rate limited.
    await user.client.expectStatus('/v1/me', 200, { headers: authHeaders(user.token) })
  })
})
