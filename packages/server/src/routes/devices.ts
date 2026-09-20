import {
  DeviceId,
  type DeviceRecord,
  DeviceRenameRequest,
  PROTOCOL_VERSION,
} from '@laurencio/protocol'
import { Hono } from 'hono'
import { z } from 'zod'
import type { AppBindings, RouteDeps } from '../context'
import { rateLimitKey, requireCapability, requirePrincipal } from '../context'
import { createDevice, listDevices, renameDevice, revokeDevice } from '../devices'
import { badRequest } from '../http/errors'
import { parseParam, readJson } from '../http/parse'
import { enforceRateLimit } from '../rate'

const CreateDeviceRequest = z.object({
  name: z.string().min(1).max(80),
  platform: z.string().min(1).max(40),
})

export function createDeviceRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()

  app.get('/v1/devices', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-devices')
    const devices = await listDevices(deps.db, principal.userId, { includeRevoked: true })
    return c.json({ protocolVersion: PROTOCOL_VERSION, devices })
  })

  app.post('/v1/devices', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-devices')
    enforceRateLimit(deps.rateLimiter, `devices:${rateLimitKey(principal)}`)
    const body = CreateDeviceRequest.safeParse(await readJson(c))
    if (!body.success) throw badRequest('name and platform are required')
    const created = await createDevice(deps.db, {
      userId: principal.userId,
      name: body.data.name,
      platform: body.data.platform,
    })
    return c.json({ protocolVersion: PROTOCOL_VERSION, ...created }, 201)
  })

  app.patch('/v1/devices/:id', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-devices')
    const deviceId = parseParam(DeviceId, c.req.param('id'), 'device id')
    const body = DeviceRenameRequest.safeParse(await readJson(c))
    if (!body.success) throw badRequest('name is required')
    const device = await renameDevice(deps.db, {
      userId: principal.userId,
      deviceId,
      name: body.data.name,
    })
    return c.json({ protocolVersion: PROTOCOL_VERSION, device })
  })

  app.delete('/v1/devices/:id', async (c) => {
    const principal = requirePrincipal(c)
    requireCapability(principal, 'manage-devices')
    const deviceId = parseParam(DeviceId, c.req.param('id'), 'device id')
    const device: DeviceRecord = await revokeDevice(deps.db, {
      userId: principal.userId,
      deviceId,
      actorUserId: principal.userId,
    })
    return c.json({ protocolVersion: PROTOCOL_VERSION, device })
  })

  return app
}
