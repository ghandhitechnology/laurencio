import type { ExitCode } from './result'

export class CliError extends Error {
  readonly code: string
  readonly exitCode: ExitCode
  readonly hint: string | undefined

  constructor(
    code: string,
    message: string,
    options: { exitCode?: ExitCode; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'CliError'
    this.code = code
    this.exitCode = options.exitCode ?? 1
    this.hint = options.hint
  }
}

export function cliError(
  code: string,
  message: string,
  options: { exitCode?: ExitCode; hint?: string; cause?: unknown } = {},
): CliError {
  return new CliError(code, message, options)
}

/** Wraps an unknown throwable into a message a person can read. */
export function describeError(error: unknown): { code: string; message: string; hint?: string } {
  if (error instanceof CliError) {
    return error.hint === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, hint: error.hint }
  }
  if (error instanceof Error) return { code: error.name, message: error.message }
  return { code: 'error', message: String(error) }
}
