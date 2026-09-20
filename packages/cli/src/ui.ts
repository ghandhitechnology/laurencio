/**
 * One place for human output, prompts, and JSON rendering. Copy here stays
 * plain: no disclaimers, no em dashes, no alarms. Commands build data and one
 * short human block; this module only formats.
 */

import * as readline from 'node:readline/promises'
import type { CommandResult } from './result'

export interface CliIo {
  /** Optional live terminal channel. Omitted by non-interactive integrations. */
  terminal?: {
    color?: boolean
    write(text: string): void
    columns(): number
    onInterrupt(cleanup: () => void): () => void
  }
  out(text: string): void
  err(text: string): void
  readLine(prompt: string): Promise<string>
  readSecret(prompt: string): Promise<string>
  close?(): void
}

function write(stream: NodeJS.WriteStream, text: string): void {
  stream.write(text.endsWith('\n') ? text : `${text}\n`)
}

export function createIo(): CliIo {
  let rl: readline.Interface | null = null
  let output: NodeJS.WriteStream | null = null
  const interfaceFor = (): readline.Interface => {
    if (rl === null || output !== process.stdout) {
      rl?.close()
      output = process.stdout
      rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    }
    return rl
  }
  const readLine = (prompt: string): Promise<string> => interfaceFor().question(prompt)
  const readSecret = async (prompt: string): Promise<string> => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return readLine(prompt)
    }
    return new Promise<string>((resolve, reject) => {
      const stdin = process.stdin
      process.stdout.write(prompt)
      const wasRaw = stdin.isRaw
      stdin.setRawMode(true)
      stdin.resume()
      let value = ''
      const finish = (error?: Error): void => {
        stdin.setRawMode(wasRaw ?? false)
        stdin.pause()
        stdin.off('data', onData)
        process.stdout.write('\n')
        if (error !== undefined) reject(error)
        else resolve(value)
      }
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        for (const char of text) {
          if (char === '\r' || char === '\n') {
            finish()
            return
          }
          if (char === '\u0003') {
            finish(new Error('input cancelled'))
            return
          }
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1)
            continue
          }
          value += char
        }
      }
      stdin.on('data', onData)
    })
  }
  return {
    ...(process.stderr.isTTY && process.env.TERM !== 'dumb'
      ? {
          terminal: {
            color: process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0',
            write: (text: string) => {
              process.stderr.write(text)
            },
            columns: () => process.stderr.columns || 80,
            onInterrupt: (cleanup: () => void) => {
              const stop = (): void => {
                cleanup()
                process.exit(130)
              }
              process.once('SIGINT', stop)
              return () => {
                process.off('SIGINT', stop)
              }
            },
          },
        }
      : {}),
    out: (text) => write(process.stdout, text),
    err: (text) => write(process.stderr, text),
    readLine,
    readSecret,
    close: () => {
      rl?.close()
      rl = null
    },
  }
}

/** Renders one result in the requested mode. The only output branch in the CLI. */
export function renderResult(result: CommandResult<unknown>, json: boolean): string {
  if (json) return `${JSON.stringify(result.data, null, 2)}\n`
  return `${result.human()}\n`
}

export interface TableOptions {
  header?: string[]
  indent?: string
}

/** Aligned plain-text columns. Columns are separated by two spaces. */
export function table(rows: string[][], options: TableOptions = {}): string {
  const all = options.header === undefined ? rows : [options.header, ...rows]
  if (all.length === 0) return ''
  const indent = options.indent ?? ''
  const widths: number[] = []
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length)
    })
  }
  return all
    .map((row, rowIndex) => {
      const line = row
        .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
        .join('  ')
        .trimEnd()
      const underline = rowIndex === 0 && options.header !== undefined
      return underline ? `${indent}${line}` : `${indent}${line}`
    })
    .join('\n')
}

export function bullet(text: string, indent = '  '): string {
  return `${indent}- ${text}`
}

export function heading(text: string): string {
  return text
}

/** Shortens a home-relative path for display. */
export function displayPath(home: string, candidate: string): string {
  if (candidate === home) return '~'
  if (candidate.startsWith(`${home}/`)) return `~/${candidate.slice(home.length + 1)}`
  return candidate
}

export function shortId(id: string, length = 10): string {
  return id.length <= length ? id : id.slice(0, length)
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return `${count} ${count === 1 ? singular : (pluralForm ?? `${singular}s`)}`
}
