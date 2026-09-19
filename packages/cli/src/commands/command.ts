import type { CommandContext } from '../context'
import type { CommandResult } from '../result'

export interface CommandSpec {
  name: string
  summary: string
  usage: string
  details?: readonly string[]
  run: (ctx: CommandContext) => Promise<CommandResult<unknown>>
}
