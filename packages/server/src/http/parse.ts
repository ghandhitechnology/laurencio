import type { Context } from 'hono'
import type { ZodType, z } from 'zod'
import { badRequest } from './errors'

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw badRequest('request body must be valid JSON')
  }
}

export function parseParam<S extends ZodType>(
  schema: S,
  value: string | undefined,
  name: string,
): z.output<S> {
  const parsed = schema.safeParse(value ?? '')
  if (!parsed.success) throw badRequest(`invalid ${name}`)
  return parsed.data
}
