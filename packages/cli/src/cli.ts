/**
 * The CLI entry: parse once, dispatch one command, render one result. Exit
 * codes are 0 clean, 1 error, 2 conflicts present. Output is returned as
 * strings so tests snapshot exactly what a shell would see.
 */

import { type ParsedArgs, parseCliArgs } from './args'
import type { CommandSpec } from './commands/command'
import { COMMAND_ORDER, COMMANDS } from './commands/index'
import { type CliDeps, createContext } from './context'
import { CliError, describeError } from './errors'
import { type CommandResult, type ExitCode, fail } from './result'
import { renderResult } from './ui'
import { CLI_NAME, CLI_VERSION } from './version'

export interface CliRunResult {
  exitCode: ExitCode
  output: string
  errorOutput: string
}

export function globalHelp(): string {
  const rows = COMMAND_ORDER.map((name) => {
    const spec = COMMANDS[name]
    return spec === undefined ? '' : `  ${name.padEnd(10)} ${spec.summary}`
  }).filter((row) => row !== '')
  return [
    `${CLI_NAME} ${CLI_VERSION}`,
    '',
    'Usage: laurencio <command> [options]',
    '',
    'Commands:',
    ...rows,
    '',
    'Global flags:',
    '  --json            Print machine-readable JSON',
    '  --verbose, -v     Include stack traces and extra detail',
    '  --help, -h        Show help',
    '  --version         Show the version',
    '  --home <path>     Use a different home (testing flag)',
    '',
    'Exit codes: 0 clean, 1 error, 2 conflicts present',
  ].join('\n')
}

export function commandHelp(spec: CommandSpec): string {
  const lines = [`Usage: ${spec.usage}`, '', spec.summary]
  if (spec.details !== undefined && spec.details.length > 0) lines.push('', ...spec.details)
  return lines.join('\n')
}

/** `help status` is the same as `status --help`. */
function resolveParsed(argv: readonly string[]): ParsedArgs {
  const parsed = parseCliArgs(argv)
  if (parsed.command !== 'help') return parsed
  const requested = parsed.positionals[0] ?? null
  if (requested !== null && COMMANDS[requested] !== undefined) {
    return {
      ...parsed,
      command: requested,
      subcommand: null,
      positionals: [],
      flags: { ...parsed.flags, help: true },
    }
  }
  return {
    ...parsed,
    command: null,
    subcommand: null,
    positionals: [],
    flags: { ...parsed.flags, help: true },
  }
}

export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<CliRunResult> {
  let output = ''
  let errorOutput = ''
  const emit = (text: string, stream: 'out' | 'err'): void => {
    const line = text.endsWith('\n') ? text : `${text}\n`
    if (stream === 'out') output += line
    else errorOutput += line
  }

  let parsed: ParsedArgs
  try {
    parsed = resolveParsed(argv)
  } catch (error) {
    const described = describeError(error)
    emit(renderResult(fail(described.code, described.message, 1, described.hint), false), 'err')
    return { exitCode: 1, output, errorOutput }
  }

  if (parsed.flags.version) {
    emit(`${CLI_NAME} ${CLI_VERSION}`, 'out')
    return { exitCode: 0, output, errorOutput }
  }

  const command = parsed.command
  if (command === null) {
    emit(globalHelp(), 'out')
    return { exitCode: 0, output, errorOutput }
  }
  const spec = COMMANDS[command]
  if (spec === undefined) {
    emit(
      renderResult(
        fail(
          'unknown-command',
          `unknown command: ${command}`,
          1,
          `Known commands: ${COMMAND_ORDER.join(', ')}`,
        ),
        parsed.flags.json,
      ),
      'err',
    )
    return { exitCode: 1, output, errorOutput }
  }
  if (parsed.flags.help) {
    emit(commandHelp(spec), 'out')
    return { exitCode: 0, output, errorOutput }
  }

  const ctx = createContext(command, parsed.subcommand, parsed.positionals, parsed.flags, deps)
  try {
    const result = await spec.run(ctx)
    emit(renderResult(result, parsed.flags.json), result.exitCode === 0 ? 'out' : 'err')
    return { exitCode: result.exitCode, output, errorOutput }
  } catch (error) {
    const described = describeError(error)
    const exitCode = error instanceof CliError ? error.exitCode : 1
    const result: CommandResult<unknown> = fail(
      described.code,
      described.message,
      exitCode === 2 ? 2 : 1,
      described.hint,
    )
    let rendered = renderResult(result, parsed.flags.json)
    if (parsed.flags.verbose && error instanceof Error && error.stack !== undefined) {
      rendered = `${rendered}${error.stack}\n`
    }
    emit(rendered, 'err')
    return { exitCode: result.exitCode, output, errorOutput }
  }
}
