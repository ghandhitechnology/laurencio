import { WorkbenchSessionId } from '@laurencio/protocol'
import { requirePositional } from '../args'
import { cliError } from '../errors'
import { readPassphrase } from '../prompt'
import { ok } from '../result'
import { controllerFor } from '../workbench/context'
import { saveWorkbenchChanges } from '../workbench/save'
import type { CommandSpec } from './command'

export const saveCommand: CommandSpec = {
  name: 'save',
  summary: 'Save selected temporary changes to the synced profile',
  usage: 'laurencio save <session-id> (--surface <id> | --harness <id>) [--json]',
  async run(ctx) {
    const rawId = requirePositional(ctx.positionals, 0, 'session id', saveCommand.usage)
    const id = WorkbenchSessionId.parse(rawId)
    if (ctx.flags.surface === undefined && ctx.flags.harness.length === 0) {
      throw cliError('selection-required', 'choose what to save with --surface or --harness')
    }
    const passphrase = await readPassphrase(ctx)
    const result = await controllerFor(ctx).withSession(id, ({ record, token }) =>
      saveWorkbenchChanges(ctx, {
        record,
        token,
        passphrase,
        harnesses: ctx.flags.harness,
        surface: ctx.flags.surface ?? null,
      }),
    )
    if (result === null) throw cliError('unknown-session', `no local workbench ${id}`)
    const data = {
      id,
      revisionId: result.report?.revisionId ?? null,
      changed: result.report?.changed ?? [],
      uploaded: result.report?.uploaded ?? 0,
      conflicts: result.report?.conflicts.map((conflict) => conflict.path) ?? [],
    }
    return ok(
      data,
      () => {
        const selection = ctx.flags.surface ?? ctx.flags.harness.join(', ')
        return `Saved ${selection}: ${data.changed.length} changed, ${data.uploaded} uploaded`
      },
      data.conflicts.length > 0 ? 2 : 0,
    )
  },
}
