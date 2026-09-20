import { agentCommand } from './agent'
import { closeCommand } from './close'
import type { CommandSpec } from './command'
import { configCommand } from './config'
import { credentialsCommand } from './credentials'
import { daemonCommand } from './daemon'
import { devicesCommand } from './devices'
import { diffCommand } from './diff'
import { doctorCommand } from './doctor'
import { enrollCommand } from './enroll'
import { exportCommand } from './export'
import { initCommand } from './init'
import { logCommand } from './log'
import { loginCommand } from './login'
import { openCommand } from './open'
import { pauseCommand } from './pause'
import { resolveCommand } from './resolve'
import { restoreCommand } from './restore'
import { resumeCommand } from './resume'
import { rotateCommand } from './rotate'
import { saveCommand } from './save'
import { sessionsCommand } from './sessions'
import { statusCommand } from './status'
import { surfacesCommand } from './surfaces'
import { syncCommand } from './sync'
import { terminalCommand } from './terminal'
import { toolsCommand } from './tools'
import { unlockCommand } from './unlock'

export const COMMANDS: Record<string, CommandSpec> = {
  config: configCommand,
  agent: agentCommand,
  open: openCommand,
  sessions: sessionsCommand,
  close: closeCommand,
  save: saveCommand,
  credentials: credentialsCommand,
  enroll: enrollCommand,
  init: initCommand,
  status: statusCommand,
  sync: syncCommand,
  tools: toolsCommand,
  terminal: terminalCommand,
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
  'config',
  'agent',
  'open',
  'sessions',
  'close',
  'save',
  'credentials',
  'enroll',
  'init',
  'status',
  'sync',
  'tools',
  'terminal',
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
