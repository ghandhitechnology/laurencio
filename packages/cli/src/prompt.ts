/**
 * Prompt helpers. Interactive prompts never run in JSON mode or with --yes, so
 * scripts and the test suite get a deterministic path.
 */

import fs from 'node:fs'
import type { CommandContext } from './context'
import { cliError } from './errors'

export function interactive(ctx: CommandContext): boolean {
  return !ctx.flags.json && !ctx.flags.yes
}

export async function askLine(
  ctx: CommandContext,
  question: string,
  fallback: string,
): Promise<string> {
  if (!interactive(ctx)) return fallback
  const answer = (await ctx.io.readLine(`${question} `)).trim()
  return answer === '' ? fallback : answer
}

export async function askYesNo(
  ctx: CommandContext,
  question: string,
  fallback: boolean,
): Promise<boolean> {
  if (!interactive(ctx)) return fallback
  const suffix = fallback ? '[Y/n]' : '[y/N]'
  const answer = (await ctx.io.readLine(`${question} ${suffix}`)).trim().toLowerCase()
  if (answer === '') return fallback
  return answer === 'y' || answer === 'yes'
}

export interface ChoiceOption {
  key: string
  label: string
}

/** A single-key choice prompt. Returns the fallback key when not interactive. */
export async function askChoice(
  ctx: CommandContext,
  question: string,
  options: readonly ChoiceOption[],
  fallback: string,
): Promise<string> {
  if (!interactive(ctx)) return fallback
  const rendered = options.map((option) => `(${option.key}) ${option.label}`).join(', ')
  const answer = (await ctx.io.readLine(`${question} ${rendered} [${fallback}]`))
    .trim()
    .toLowerCase()
  if (answer === '') return fallback
  const match = options.find((option) => option.key === answer)
  return match === undefined ? fallback : match.key
}

/** Reads a passphrase without echoing it. */
export async function askSecret(ctx: CommandContext, question: string): Promise<string> {
  if (!interactive(ctx)) {
    const fromEnv = ctx.env.LAURENCIO_PASSPHRASE
    if (fromEnv !== undefined && fromEnv !== '') return fromEnv
    throw cliError('missing-passphrase', 'a passphrase is required', {
      hint: 'Pass --passphrase-file <path> or set LAURENCIO_PASSPHRASE.',
    })
  }
  return ctx.io.readSecret(question)
}

/**
 * One passphrase entry path for init, login, and unlock: an explicit file, the
 * environment, or a hidden prompt. `confirm` asks twice for a new passphrase.
 */
export async function readPassphrase(
  ctx: CommandContext,
  options: { confirm?: boolean } = {},
): Promise<string> {
  const file = ctx.flags.passphraseFile
  if (file !== undefined && file !== '') {
    let raw: string
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw cliError('missing-passphrase', `could not read ${file}: ${reason}`)
    }
    const value = raw.replace(/\r?\n$/, '')
    if (value === '') throw cliError('missing-passphrase', `${file} is empty`)
    return value
  }
  const first = await askSecret(ctx, 'Passphrase:')
  if (first === '') throw cliError('missing-passphrase', 'the passphrase must not be empty')
  if (options.confirm === true && interactive(ctx)) {
    ctx.io.out('The passphrase decrypts this store. If it is lost, the data cannot be recovered.')
  }
  if (options.confirm !== true || !interactive(ctx)) return first
  const second = await ctx.io.readSecret('Confirm passphrase:')
  if (first !== second) {
    throw cliError('passphrase-mismatch', 'the passphrases did not match; run the command again')
  }
  return first
}
