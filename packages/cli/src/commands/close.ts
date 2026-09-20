import { WorkbenchSessionId } from '@laurencio/protocol'
import { requirePositional } from '../args'
import type { CommandContext } from '../context'
import { ok } from '../result'
import { controllerFor } from '../workbench/context'
import type { CommandSpec } from './command'

async function closeWorkbench(ctx: CommandContext, id: string): Promise<boolean> {
  return controllerFor(ctx).close(WorkbenchSessionId.parse(id))
}

export const closeCommand: CommandSpec = {
  name: 'close',
  summary: 'Close and delete a temporary workbench',
  usage: 'laurencio close <session-id> [--json]',
  async run(ctx) {
    const id = requirePositional(ctx.positionals, 0, 'session id', 'laurencio close <session-id>')
    const closed = await closeWorkbench(ctx, id)
    const data = { id, closed }
    return ok(data, () => (closed ? `Closed workbench ${id}` : `No local workbench ${id}`))
  },
}
