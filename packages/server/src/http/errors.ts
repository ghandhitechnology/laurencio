import type { ErrorCode, ErrorResponse } from '@laurencio/protocol'
import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class HttpError extends Error {
  readonly status: ContentfulStatusCode
  readonly code: ErrorCode
  readonly details: Record<string, unknown> | undefined

  constructor(
    status: ContentfulStatusCode,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
  }

  toBody(): ErrorResponse {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    }
  }
}

export const unauthenticated = (message = 'sign in or present a device token') =>
  new HttpError(401, 'unauthenticated', message)

export const tokenExpired = () =>
  new HttpError(401, 'unauthenticated', 'device token has expired; enroll the device again', {
    reason: 'token_expired',
  })

export const forbidden = (message = 'not allowed for this account') =>
  new HttpError(403, 'forbidden', message)

export const notFound = (message = 'not found') => new HttpError(404, 'not_found', message)

export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new HttpError(400, 'invalid_request', message, details)

export const conflict = (message: string, details?: Record<string, unknown>) =>
  new HttpError(409, 'conflict', message, details)

export const quotaExceeded = (message: string, details?: Record<string, unknown>) =>
  new HttpError(413, 'quota_exceeded', message, details)

export const rateLimited = (message: string, details?: Record<string, unknown>) =>
  new HttpError(429, 'rate_limited', message, details)

export const protocolMismatch = (message: string) =>
  new HttpError(400, 'protocol_mismatch', message)
