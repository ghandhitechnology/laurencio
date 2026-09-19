import { clearPause, readPause } from '../pause'
import { ok } from '../result'
import type { CommandSpec } from './command'

export interface ResumeData {
  paused: boolean
  resumedAt: string | null
}

export const resumeCommand: CommandSpec = {
  name: 'resume',
  summary: 'Let the daemon run again',
  usage: 'laurencio resume [--json]',
  async run(ctx) {
    const existing = readPause(ctx.home)
    if (existing === null) {
      const data: ResumeData = { paused: false, resumedAt: null }
      return ok(data, () => 'Daemon is already running.')
    }
    const resumedAt = ctx.now().toISOString()
    clearPause(ctx.home)
    const data: ResumeData = { paused: false, resumedAt }
    return ok(data, () => 'Daemon resumed.')
  },
}
