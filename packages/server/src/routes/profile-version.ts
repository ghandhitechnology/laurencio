import {
  PROFILE_VERSION_HEADER,
  PROTOCOL_VERSION,
  ProfileVersionResponse,
  ProfileVersionWriteRequest,
  StoreId,
} from '@laurencio/protocol'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'
import { requireCapability, requirePrincipal } from '../context'
import { requireStore } from '../devices'
import { badRequest } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { readClientProfileVersion, updateStoreProfileVersion } from '../profile-version'

export function createProfileVersionRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/stores/:id/profile-version', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const store = await requireStore(deps.db, principal.userId, storeId)
    c.header(PROFILE_VERSION_HEADER, String(store.profileVersion))
    return c.json(
      ProfileVersionResponse.parse({
        protocolVersion: PROTOCOL_VERSION,
        profileVersion: store.profileVersion,
      }),
    )
  })

  app.put('/v1/stores/:id/profile-version', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'migrate-profile')
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const body = ProfileVersionWriteRequest.safeParse(await readJson(c))
    if (!body.success) {
      throw badRequest('profile version migration must compare v1 and set v2', {
        issues: body.error.issues,
      })
    }
    const clientProfileVersion = readClientProfileVersion(c.req.raw.headers)
    const profileVersion = await updateStoreProfileVersion(deps.db, {
      storeId,
      actorUserId: principal.userId,
      actorDeviceId: principal.deviceId,
      expectedVersion: body.data.expectedVersion,
      profileVersion: body.data.profileVersion,
      clientProfileVersion,
    })
    const response = ProfileVersionResponse.parse({
      protocolVersion: PROTOCOL_VERSION,
      profileVersion,
    })
    c.header(PROFILE_VERSION_HEADER, String(profileVersion))
    return c.json(response)
  })

  return app
}
