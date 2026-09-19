/**
 * Every command returns one of these. Human rendering and JSON rendering read
 * the same object, so a command never branches on the output mode.
 */

export type ExitCode = 0 | 1 | 2

export interface CommandResult<T = unknown> {
  data: T
  human: () => string
  exitCode: ExitCode
}

export interface CliErrorData {
  error: {
    code: string
    message: string
    hint?: string
  }
}

export function ok<T>(data: T, human: () => string, exitCode: ExitCode = 0): CommandResult<T> {
  return { data, human, exitCode }
}

export function fail(
  code: string,
  message: string,
  exitCode: ExitCode = 1,
  hint?: string,
): CommandResult<CliErrorData> {
  const data: CliErrorData = {
    error: hint === undefined ? { code, message } : { code, message, hint },
  }
  const human = (): string => {
    const lines = [`laurencio: ${message}`]
    if (hint !== undefined) lines.push(hint)
    return lines.join('\n')
  }
  return { data, human, exitCode }
}
