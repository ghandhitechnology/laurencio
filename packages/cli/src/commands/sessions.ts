import { ok } from '../result'
import { table } from '../ui'
import { controllerFor } from '../workbench/context'
import type { CommandSpec } from './command'

export const sessionsCommand: CommandSpec = {
  name: 'sessions',
  summary: 'List temporary workbench sessions',
  usage: 'laurencio sessions [--json]',
  async run(ctx) {
    const controller = controllerFor(ctx)
    const reaped = await controller.reap()
    const sessions = (await controller.statuses()).map((status) => ({
      id: status.record.remote.id,
      name: status.record.remote.name,
      state: status.state,
      revisionId: status.record.revisionId,
      expiresAt: status.record.remote.expiresAt,
      cwd: status.record.runtime.cwd,
    }))
    const data = { sessions, reaped }
    return ok(data, () => {
      if (sessions.length === 0) return 'No temporary workbenches.'
      return table(
        sessions.map((session) => [session.id, session.state, session.expiresAt, session.cwd]),
        { header: ['SESSION', 'STATE', 'EXPIRES', 'PROJECT'] },
      )
    })
  },
}
