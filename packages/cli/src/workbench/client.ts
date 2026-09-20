import { httpErrorFromResponse, PROTOCOL_HEADER } from '@laurencio/core'
import {
  MeResponse,
  type MeResponse as MeResponseType,
  PROTOCOL_VERSION,
  type WorkbenchSession,
  WorkbenchSessionCloseResponse,
  type WorkbenchSessionCreateRequest,
  WorkbenchSessionCreateRequest as WorkbenchSessionCreateRequestSchema,
  WorkbenchSessionCreateResponse,
  type WorkbenchSessionId,
  WorkbenchSessionListResponse,
} from '@laurencio/protocol'

export interface WorkbenchClient {
  setBearer(value: string): void
  account(): Promise<MeResponseType>
  create(input: WorkbenchSessionCreateRequest): Promise<{
    session: WorkbenchSession
    token: string
  }>
  list(): Promise<WorkbenchSession[]>
  close(id: WorkbenchSessionId): Promise<WorkbenchSession>
}

export function createWorkbenchClient(options: {
  baseUrl: string
  bearer: string
  fetch?: typeof fetch
}): WorkbenchClient {
  const base = new URL(options.baseUrl)
  const fetchImpl = options.fetch ?? globalThis.fetch
  let bearer = requiredBearer(options.bearer)

  const request = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${bearer}`)
    headers.set(PROTOCOL_HEADER, String(PROTOCOL_VERSION))
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    const response = await fetchImpl(new URL(path, base).toString(), { ...init, headers })
    if (!response.ok) throw await httpErrorFromResponse(response, 'workbench session')
    return response.json()
  }

  return {
    setBearer(value) {
      bearer = requiredBearer(value)
    },
    async account() {
      return MeResponse.parse(await request('/v1/me'))
    },
    async create(input) {
      const body = WorkbenchSessionCreateRequestSchema.parse(input)
      const response = WorkbenchSessionCreateResponse.parse(
        await request('/v1/workbench-sessions', {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      )
      return { session: response.session, token: response.token }
    },
    async list() {
      const response = WorkbenchSessionListResponse.parse(await request('/v1/workbench-sessions'))
      return response.sessions
    },
    async close(id) {
      const response = WorkbenchSessionCloseResponse.parse(
        await request(`/v1/workbench-sessions/${id}`, { method: 'DELETE' }),
      )
      return response.session
    },
  }
}

function requiredBearer(value: string): string {
  if (value.trim() === '') throw new Error('workbench bearer token is required')
  return value
}
