import { PROTOCOL_VERSION } from '@laurencio/protocol'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import type { AppBindings, RouteDeps } from '../context'

export interface HealthBody {
  ok: boolean
  db: 'up' | 'down'
  protocolVersion: number
}

export function createHealthRoutes(deps: RouteDeps): Hono<AppBindings> {
  const app = new Hono<AppBindings>()
  app.get('/health', async (c) => {
    const up = await databaseReachable(deps)
    const body: HealthBody = { ok: up, db: up ? 'up' : 'down', protocolVersion: PROTOCOL_VERSION }
    return c.json(body, up ? 200 : 503)
  })
  return app
}

async function databaseReachable(deps: RouteDeps): Promise<boolean> {
  try {
    await deps.db.execute(sql`select 1`)
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    deps.logger.error('health check failed', { message })
    return false
  }
}
