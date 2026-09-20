import {
  PROTOCOL_VERSION,
  WORKBENCH_SESSION_DEFAULT_TTL_SECONDS,
  WORKBENCH_SESSION_MAX_TTL_SECONDS,
  WORKBENCH_SESSION_MIN_TTL_SECONDS,
  WorkbenchSessionCreateRequest,
  WorkbenchSessionId,
} from '@laurencio/protocol'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requireCapability, requirePrincipal } from '../context'
import { badRequest } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { enforceRateLimit } from '../rate'
import {
  closeWorkbenchSession,
  createWorkbenchSession,
  listWorkbenchSessions,
} from '../workbench-sessions'

export function createWorkbenchSessionRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.post('/v1/workbench-sessions', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-workbench-sessions')
    enforceRateLimit(deps.rateLimiter, `workbench-sessions:${rateLimitKey(principal)}`)
    const body = WorkbenchSessionCreateRequest.safeParse(await readJson(c))
    if (!body.success) {
      throw badRequest('invalid workbench session request', { issues: body.error.issues })
    }
    const requestedTtl = body.data.expiresInSeconds ?? WORKBENCH_SESSION_DEFAULT_TTL_SECONDS
    const ttlSeconds = Math.min(
      WORKBENCH_SESSION_MAX_TTL_SECONDS,
      Math.max(WORKBENCH_SESSION_MIN_TTL_SECONDS, requestedTtl),
    )
    const created = await createWorkbenchSession(deps.db, {
      userId: principal.userId,
      actorDeviceId: principal.deviceId,
      name: body.data.name,
      platform: body.data.platform,
      expiresAt: new Date(deps.now().getTime() + ttlSeconds * 1000),
    })
    return c.json({ protocolVersion: PROTOCOL_VERSION, ...created }, 201)
  })

  app.get('/v1/workbench-sessions', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-workbench-sessions')
    const sessions = await listWorkbenchSessions(deps.db, principal.userId)
    return c.json({ protocolVersion: PROTOCOL_VERSION, sessions })
  })

  app.delete('/v1/workbench-sessions/:id', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'close-own-workbench')
    const sessionId = parseParam(WorkbenchSessionId, c.req.param('id'), 'workbench session id')
    const session = await closeWorkbenchSession(deps.db, {
      userId: principal.userId,
      actorDeviceId: principal.deviceId,
      sessionId,
      ...(principal.kind === 'temporary-workbench' && principal.deviceId !== null
        ? { targetDeviceId: principal.deviceId }
        : {}),
    })
    return c.json({ protocolVersion: PROTOCOL_VERSION, session })
  })

  return app
}
