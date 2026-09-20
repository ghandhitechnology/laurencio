import { checkProtocolVersion, newId, PROTOCOL_VERSION } from '@laurencio/protocol'
import { Hono } from 'hono'
import { ZodError } from 'zod'
import { type Auth, createAuth, createAuthMiddleware } from './auth'
import type { AppBindings, RouteDeps } from './context'
import { type Database, type DatabaseHandle, openDatabase } from './db/client'
import { loadEnv, type ServerEnv } from './env'
import { HttpError } from './http/errors'
import { createLogger, type Logger } from './log'
import { RateLimiter } from './rate'
import { createBlobRoutes, createLocalBlobRoutes } from './routes/blob'
import { createCommitRoutes } from './routes/commits'
import { createDeviceRoutes } from './routes/devices'
import { createHealthRoutes } from './routes/health'
import { createKdfRoutes } from './routes/kdf'
import { createMeRoutes } from './routes/me'
import { createProfileRoutes } from './routes/profile'
import { createProfileVersionRoutes } from './routes/profile-version'
import { createVaultRoutes } from './routes/vault'
import { createWorkbenchSessionRoutes } from './routes/workbench-sessions'
import { createBlobStore, FsBlobStore } from './storage'
import type { BlobStore } from './storage/types'
import { createWebRoutes } from './web/routes'

export const PROTOCOL_HEADER = 'x-laurencio-protocol-version'
export const REQUEST_ID_HEADER = 'x-request-id'

export interface CreateAppOptions {
  env: ServerEnv
  db: Database
  storage: BlobStore
  auth: Auth
  logger?: Logger
  rateLimiter?: RateLimiter
  now?: () => Date
}

export function createApp(options: CreateAppOptions): Hono<AppBindings> {
  const logger = options.logger ?? createLogger(options.env.logLevel)
  const deps: RouteDeps = {
    env: options.env,
    db: options.db,
    storage: options.storage,
    logger,
    rateLimiter:
      options.rateLimiter ??
      new RateLimiter({
        capacity: options.env.rate.capacity,
        refillPerSecond: options.env.rate.refillPerSecond,
      }),
    webRateLimiter: new RateLimiter({
      capacity: options.env.rate.approvalCapacity,
      refillPerSecond: options.env.rate.approvalRefillPerSecond,
    }),
    now: options.now ?? (() => new Date()),
  }

  const app = new Hono<AppBindings>()

  app.use('*', async (c, next) => {
    const requestId = c.req.header(REQUEST_ID_HEADER) ?? newId()
    c.set('requestId', requestId)
    const startedAt = performance.now()
    await next()
    c.res.headers.set(REQUEST_ID_HEADER, requestId)
    const principal = c.get('principal')
    logger.info('request', {
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round((performance.now() - startedAt) * 10) / 10,
      ...(principal ? { userId: principal.userId } : {}),
    })
  })

  app.use('/v1/*', async (c, next) => {
    const raw = c.req.header(PROTOCOL_HEADER)
    const remote = raw === undefined ? Number.NaN : Number(raw)
    if (!Number.isInteger(remote)) {
      throw new HttpError(
        400,
        'protocol_mismatch',
        `send ${PROTOCOL_HEADER}: ${PROTOCOL_VERSION}; this server speaks protocol v${PROTOCOL_VERSION}`,
      )
    }
    const compatibility = checkProtocolVersion(remote)
    if (!compatibility.ok) throw new HttpError(400, 'protocol_mismatch', compatibility.reason)
    await next()
  })

  app.use('/v1/*', createAuthMiddleware({ auth: options.auth, db: options.db, now: deps.now }))

  app.route('/', createHealthRoutes(deps))
  app.route('/', createMeRoutes(deps))
  app.route('/', createProfileVersionRoutes(deps))
  app.route('/', createProfileRoutes(deps))
  app.route('/', createVaultRoutes(deps))
  app.route('/', createDeviceRoutes(deps))
  app.route('/', createKdfRoutes(deps))
  app.route('/', createBlobRoutes(deps))
  app.route('/', createCommitRoutes(deps))
  app.route('/', createWorkbenchSessionRoutes(deps))
  app.route(
    '/',
    createWebRoutes({
      env: options.env,
      db: options.db,
      auth: options.auth,
      rateLimiter: deps.webRateLimiter,
    }),
  )
  if (options.storage instanceof FsBlobStore) {
    app.route('/', createLocalBlobRoutes(options.storage, options.env.quota.maxBlobBytes))
  }

  app.all('/api/auth/*', (c) => options.auth.handler(c.req.raw))

  app.notFound((c) =>
    c.json(
      { error: { code: 'not_found', message: `no route for ${c.req.method} ${c.req.path}` } },
      404,
    ),
  )

  app.onError((error, c) => {
    const httpError = toHttpError(error)
    if (httpError.status >= 500) {
      logger.error('request failed', {
        requestId: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
    return c.json(httpError.toBody(), httpError.status)
  })

  return app
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof ZodError) {
    return new HttpError(400, 'invalid_request', 'request failed validation', {
      issues: error.issues,
    })
  }
  return new HttpError(500, 'internal', 'internal error')
}

export interface RunningServer {
  app: Hono<AppBindings>
  handle: DatabaseHandle
  stop(): Promise<void>
}

export async function startServer(env: ServerEnv = loadEnv()): Promise<RunningServer> {
  const logger = createLogger(env.logLevel)
  const handle = openDatabase(env)
  if (env.autoMigrate) await handle.migrate()
  const storage = createBlobStore(env)
  const auth = createAuth({ db: handle.db, env })
  const app = createApp({ env, db: handle.db, storage, auth, logger })
  if (env.generatedSecret) {
    logger.warn(
      'BETTER_AUTH_SECRET is not set; using a random per-process secret. Set it to keep sessions across restarts.',
    )
  }
  const server = Bun.serve({ port: env.port, hostname: env.host, fetch: app.fetch })
  logger.info('server listening', {
    host: env.host,
    port: server.port,
    url: env.publicUrl,
    database: handle.dialect,
    storage: storage.kind,
  })
  const stop = async (): Promise<void> => {
    await server.stop()
    await handle.close()
  }
  process.on('SIGINT', () => {
    void stop().then(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    void stop().then(() => process.exit(0))
  })
  return { app, handle, stop }
}

if (import.meta.main) {
  await startServer()
}
