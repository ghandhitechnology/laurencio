import { parseLimit } from '../args'
import { listHistory } from '../history'
import { ok } from '../result'
import { openSession } from '../session'
import { shortId, table } from '../ui'
import type { CommandSpec } from './command'

export interface LogData {
  base: string | null
  head: string | null
  revisions: {
    id: string
    shortId: string
    createdAt: string
    deviceId: string
    deviceName: string | null
    files: number
    bytes: number
    isBase: boolean
    isHead: boolean
    parents: string[]
  }[]
}

function humanLog(data: LogData): string {
  if (data.revisions.length === 0)
    return 'No revisions yet. Run `laurencio sync` to create the first one.'
  const rows = [...data.revisions]
    .reverse()
    .map((revision) => [
      revision.isHead ? `${revision.shortId}*` : revision.shortId,
      revision.createdAt,
      revision.deviceName ?? shortId(revision.deviceId),
      revision.files === 0 ? '-' : String(revision.files),
      revision.isBase ? 'base' : '',
    ])
  const lines = [table(rows, { header: ['REVISION', 'CREATED', 'DEVICE', 'FILES', 'ROLE'] })]
  lines.push('* marks the store head; base is the last synced revision on this device.')
  return lines.join('\n')
}

export const logCommand: CommandSpec = {
  name: 'log',
  summary: 'List revision history',
  usage: 'laurencio log [--limit <n>] [--json]',
  async run(ctx) {
    const limit = parseLimit(ctx.flags.limit, 20)
    const session = await openSession(ctx)
    const view = await listHistory(ctx, session, limit)
    const data: LogData = {
      base: view.base,
      head: view.head,
      revisions: view.revisions.map((revision) => ({
        id: revision.id,
        shortId: revision.shortId,
        createdAt: revision.createdAt,
        deviceId: revision.deviceId,
        deviceName: revision.deviceName,
        files: revision.files,
        bytes: revision.bytes,
        isBase: revision.isBase,
        isHead: revision.isHead,
        parents: revision.parents,
      })),
    }
    return ok(data, () => humanLog(data))
  },
}
