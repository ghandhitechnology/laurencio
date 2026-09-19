import type { CommandSpec } from './command'
import { daemonCommand } from './daemon'
import { devicesCommand } from './devices'
import { diffCommand } from './diff'
import { doctorCommand } from './doctor'
import { exportCommand } from './export'
import { initCommand } from './init'
import { logCommand } from './log'
import { loginCommand } from './login'
import { pauseCommand } from './pause'
import { resolveCommand } from './resolve'
import { restoreCommand } from './restore'
import { resumeCommand } from './resume'
import { rotateCommand } from './rotate'
import { statusCommand } from './status'
import { surfacesCommand } from './surfaces'
import { syncCommand } from './sync'
import { unlockCommand } from './unlock'

export const COMMANDS: Record<string, CommandSpec> = {
  init: initCommand,
  status: statusCommand,
  sync: syncCommand,
  pause: pauseCommand,
  resume: resumeCommand,
  rotate: rotateCommand,
  daemon: daemonCommand,
  diff: diffCommand,
  log: logCommand,
  restore: restoreCommand,
  devices: devicesCommand,
  resolve: resolveCommand,
  export: exportCommand,
  doctor: doctorCommand,
  surfaces: surfacesCommand,
  login: loginCommand,
  unlock: unlockCommand,
}

export const COMMAND_ORDER: readonly string[] = [
  'init',
  'status',
  'sync',
  'pause',
  'resume',
  'rotate',
  'daemon',
  'diff',
  'log',
  'restore',
  'devices',
  'resolve',
  'export',
  'doctor',
  'surfaces',
  'login',
  'unlock',
]

export type { CommandSpec }
