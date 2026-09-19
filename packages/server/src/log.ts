export type LogFields = Record<string, unknown>

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
}

const order: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogSink {
  write(chunk: string): unknown
}

export function createLogger(level: keyof typeof order, sink: LogSink = process.stdout): Logger {
  const threshold = order[level] ?? 20
  const emit = (entryLevel: keyof typeof order, message: string, fields?: LogFields) => {
    if ((order[entryLevel] ?? 20) < threshold) return
    const line = JSON.stringify({
      level: entryLevel,
      time: new Date().toISOString(),
      msg: message,
      ...fields,
    })
    sink.write(`${line}\n`)
  }
  return {
    debug: (message, fields) => emit('debug', message, fields),
    info: (message, fields) => emit('info', message, fields),
    warn: (message, fields) => emit('warn', message, fields),
    error: (message, fields) => emit('error', message, fields),
  }
}
