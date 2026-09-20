#!/usr/bin/env bun
/**
 * laurencio CLI entry. Commands live in `./commands`; `runCli` owns parsing,
 * dispatch, and exit codes. `--home` and `LAURENCIO_REMOTE_DIR` are the testing
 * levers the shell test script uses.
 */

export { type CliRunResult, commandHelp, globalHelp, runCli } from './cli'
export { COMMAND_ORDER, COMMANDS } from './commands/index'
export type { CliDeps, CommandContext } from './context'
export type { CliIo } from './ui'
export { CLI_NAME, CLI_VERSION } from './version'

import { runCli } from './cli'
import { createIo } from './ui'

if (import.meta.main) {
  const result = await runCli(process.argv.slice(2), { io: createIo() })
  if (result.output !== '') process.stdout.write(result.output)
  if (result.errorOutput !== '') process.stderr.write(result.errorOutput)
  // Let stdout and stderr drain before exiting. `process.exit()` can truncate a
  // large JSON plan when the CLI is piped over SSH or into another command.
  process.exitCode = result.exitCode
}
