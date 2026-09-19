import { readPause, writePause } from '../pause'
import { ok } from '../result'
import type { CommandSpec } from './command'

export interface PauseData {
  paused: boolean
  pausedAt: string | null
}

export const pauseCommand: CommandSpec = {
  name: 'pause',
  summary: 'Stop the daemon from running until resumed',
  usage: 'laurencio pause [--json]',
  async run(ctx) {
    const existing = readPause(ctx.home)
    if (existing !== null) {
      const data: PauseData = { paused: true, pausedAt: existing.pausedAt }
      return ok(data, () => `Daemon is already paused since ${existing.pausedAt}.`)
    }
    const pausedAt = ctx.now().toISOString()
    writePause(ctx.home, { pausedAt, by: ctx.home })
    const data: PauseData = { paused: true, pausedAt }
    return ok(data, () => `Daemon paused at ${pausedAt}. Run \`laurencio resume\` to continue.`)
  },
}
