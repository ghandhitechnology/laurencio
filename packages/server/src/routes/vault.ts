import {
  PROTOCOL_VERSION,
  StoreId,
  VaultHeadResponse,
  VaultHeadWriteRequest,
} from '@laurencio/protocol'
import { Hono } from 'hono'
import { requireStoredObject } from '../blob-verification'
import type { AppBindings, RouteDeps } from '../context'
import { requirePrincipal } from '../context'
import { requireStore } from '../devices'
import { badRequest, forbidden } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { requireProfileV2Write } from '../profile-version'
import { readVaultHead, writeVaultHead } from '../vault'

export function createVaultRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/stores/:id/vault', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    await requireStore(deps.db, principal.userId, storeId)
    const head = await readVaultHead(deps.db, storeId)
    return c.json(VaultHeadResponse.parse({ protocolVersion: PROTOCOL_VERSION, head }))
  })

  app.put('/v1/stores/:id/vault', async (c) => {
    const principal = requirePrincipal(c)
    const storeId = parseParam(StoreId, c.req.param('id'), 'store id')
    const store = await requireStore(deps.db, principal.userId, storeId)
    requireProfileV2Write(store, c.req.raw.headers)
    if (!principal.deviceId) throw forbidden('vault writes require a device token')
    const body = VaultHeadWriteRequest.safeParse(await readJson(c))
    if (!body.success) {
      throw badRequest('invalid vault head request', { issues: body.error.issues })
    }
    await requireStoredObject(deps, storeId, body.data.blob, 'vault')
    const head = await writeVaultHead(deps.db, {
      storeId,
      actorUserId: principal.userId,
      actorDeviceId: principal.deviceId,
      blob: body.data.blob,
      expectedGeneration: body.data.expectedGeneration,
    })
    return c.json(VaultHeadResponse.parse({ protocolVersion: PROTOCOL_VERSION, head }))
  })

  return app
}
