import {
  PROTOCOL_VERSION,
  ProfileHeadResponse,
  ProfileHeadWriteRequest,
  StoreId,
} from '@laurencio/protocol'
import { Hono } from 'hono'
import { requireStoredObject } from '../blob-verification'
import type { AppBindings, RouteDeps } from '../context'
import { requireCapability, requirePrincipal } from '../context'
import { requireStore } from '../devices'
import { badRequest, forbidden } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { readProfileHead, writeProfileHead } from '../profile-head'
import { requireProfileV2Write } from '../profile-version'

export function createProfileRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/stores/:id/profile', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const head = await readProfileHead(deps.db, storeId)
    return c.json(ProfileHeadResponse.parse({ protocolVersion: PROTOCOL_VERSION, head }))
  })

  app.put('/v1/stores/:id/profile', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'write-profile')
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const store = await requireStore(deps.db, principal.userId, storeId)
    requireProfileV2Write(store, c.req.raw.headers)
    if (!principal.deviceId) throw forbidden('profile writes require a device token')
    const body = ProfileHeadWriteRequest.safeParse(await readJson(c))
    if (!body.success) {
      throw badRequest('invalid profile head request', { issues: body.error.issues })
    }
    await requireStoredObject(deps, storeId, body.data.blob, 'profile')
    const head = await writeProfileHead(deps.db, {
      storeId,
      actorUserId: principal.userId,
      actorDeviceId: principal.deviceId,
      blob: body.data.blob,
      expectedGeneration: body.data.expectedGeneration,
    })
    return c.json(ProfileHeadResponse.parse({ protocolVersion: PROTOCOL_VERSION, head }))
  })

  return app
}
