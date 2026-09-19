import { rateLimited } from './http/errors'

export interface RateLimiterOptions {
  /** Burst size. */
  capacity: number
  refillPerSecond: number
  now?: () => number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  retryAfterSeconds: number
}

interface Bucket {
  tokens: number
  updatedAt: number
}

const PRUNE_AFTER_MS = 10 * 60 * 1000
const PRUNE_THRESHOLD = 10_000

/**
 * Per-key token bucket. In-memory on purpose: one Railway instance serves the
 * dev deployment, and a shared limiter is a later problem.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>()
  private readonly capacity: number
  private readonly refillPerSecond: number
  private readonly now: () => number

  constructor(options: RateLimiterOptions) {
    this.capacity = options.capacity
    this.refillPerSecond = options.refillPerSecond
    this.now = options.now ?? (() => Date.now())
  }

  take(key: string): RateLimitDecision {
    const now = this.now()
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updatedAt: now }
    const refilled = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.updatedAt) / 1000) * this.refillPerSecond,
    )
    if (refilled >= 1) {
      this.buckets.set(key, { tokens: refilled - 1, updatedAt: now })
      this.prune(now)
      return { allowed: true, remaining: Math.floor(refilled - 1), retryAfterSeconds: 0 }
    }
    this.buckets.set(key, { tokens: refilled, updatedAt: now })
    const retry = this.refillPerSecond > 0 ? (1 - refilled) / this.refillPerSecond : 60
    return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(retry)) }
  }

  private prune(now: number): void {
    if (this.buckets.size <= PRUNE_THRESHOLD) return
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt > PRUNE_AFTER_MS) this.buckets.delete(key)
    }
  }
}

export function enforceRateLimit(limiter: RateLimiter, key: string): void {
  const decision = limiter.take(key)
  if (decision.allowed) return
  throw rateLimited('too many writes for this device, retry shortly', {
    retryAfterSeconds: decision.retryAfterSeconds,
  })
}
