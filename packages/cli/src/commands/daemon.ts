/**
 * `laurencio daemon` subcommands: run the loop, and install or remove the
 * launchd agent / systemd user unit that keeps it running.
 */

import type { Platform } from '@laurencio/core'
import { LockHeldError, SyncLoop } from '@laurencio/core'
import { adapterContext, type CommandContext } from '../context'
import {
  daemonProgram,
  installService,
  type ServiceSpec,
  serviceStatus,
  uninstallService,
} from '../daemon/installer'
import { liveDaemonLock } from '../daemon/lock'
import { DaemonRuntime } from '../daemon/runtime'
import { readDaemonState } from '../daemon/state'
import { surfaceWatchRoots } from '../daemon/watcher'
import { cliError } from '../errors'
import { readPause } from '../pause'
import { ok } from '../result'
import { adaptersFor, openSession, openState } from '../session'
import type { CommandSpec } from './command'

export interface DaemonData {
  action: 'run' | 'install' | 'uninstall' | 'status'
  platform: Platform
  service: {
    path: string
    installed: boolean
    logPath: string | null
    logHint: string
  }
  daemon: {
    running: boolean
    pid: number | null
    startedAt: string | null
    paused: boolean
    pausedAt: string | null
    lastSync: string | null
    lastResult: string | null
  }
  started: boolean
  notes: string[]
}

function requireSupported(ctx: CommandContext): void {
  if (ctx.platform === 'win32') {
    throw cliError('unsupported-platform', 'the daemon service is not supported on Windows', {
      hint: 'Run `laurencio daemon run` in a terminal or a task scheduler of your choosing.',
    })
  }
}

function serviceSpec(ctx: CommandContext): ServiceSpec {
  const invocation = daemonProgram({
    execPath: process.execPath,
    main: typeof Bun === 'undefined' ? (process.argv[1] ?? null) : Bun.main,
  })
  return {
    home: ctx.home,
    platform: ctx.platform,
    program: invocation.program,
    args: invocation.args,
    uid: process.getuid?.() ?? 0,
  }
}

function daemonSnapshot(ctx: CommandContext): DaemonData['daemon'] {
  const paused = readPause(ctx.home)
  const lock = liveDaemonLock(ctx.home)
  const state = openState(ctx)
  try {
    const record = readDaemonState(state)
    const running = lock !== null && record !== null && lock.pid === record.pid
    return {
      running,
      pid: running && record !== null ? record.pid : null,
      startedAt: running && record !== null ? record.startedAt : null,
      paused: paused !== null,
      pausedAt: paused?.pausedAt ?? null,
      lastSync: record?.lastSync ?? null,
      lastResult: record?.lastResult ?? null,
    }
  } finally {
    state.close()
  }
}

function humanDaemon(data: DaemonData): string {
  const lines: string[] = []
  const daemon = data.daemon
  if (daemon.paused) {
    lines.push(`Daemon: paused since ${daemon.pausedAt ?? 'unknown'}`)
  } else if (daemon.running) {
    lines.push(`Daemon: running (pid ${daemon.pid ?? 0}, started ${daemon.startedAt ?? 'unknown'})`)
  } else {
    lines.push('Daemon: not running')
  }
  lines.push(
    daemon.lastSync === null
      ? 'Last sync: never'
      : `Last sync: ${daemon.lastSync} (${daemon.lastResult ?? 'unknown'})`,
  )
  if (data.action === 'install') {
    lines.push(
      data.service.installed
        ? `Service: installed at ${data.service.path}`
        : `Service: not installed (${data.service.path})`,
    )
    if (data.notes.length > 0) lines.push(...data.notes)
  }
  if (data.action === 'uninstall') {
    lines.push(data.started ? 'Service: stopped and removed' : 'Service: not installed')
  }
  if (data.action === 'status') {
    lines.push(
      data.service.installed
        ? `Service: installed at ${data.service.path}`
        : `Service: not installed (${data.service.path})`,
    )
    lines.push(`Logs: ${data.service.logHint}`)
  }
  return lines.join('\n')
}

async function runDaemon(ctx: CommandContext): Promise<DaemonData> {
  const session = await openSession(ctx)
  const policy = session.config.policy
  const state = openState(ctx)
  const adapters = adaptersFor(ctx, policy)
  const adapterCtx = adapterContext(ctx)
  const watchRoots = policy.cadence.watch ? surfaceWatchRoots(adapters, adapterCtx) : []
  const loop = new SyncLoop({
    adapters,
    ctx: adapterCtx,
    deviceId: session.identity.deviceId,
    storeId: session.credentials.storeId,
    key: session.credentials.key,
    state,
    remote: session.remote,
    policy,
    ...(ctx.deps.quiescence === undefined ? {} : { quiescence: ctx.deps.quiescence }),
    ...(ctx.deps.createRevisionId === undefined
      ? {}
      : { createRevisionId: ctx.deps.createRevisionId }),
    now: ctx.now,
  })
  let runtime: DaemonRuntime
  try {
    runtime = DaemonRuntime.start({
      home: ctx.home,
      state,
      runner: loop,
      policy,
      watchRoots,
      log: (line) => {
        ctx.io.out(`${ctx.now().toISOString()} ${line}`)
      },
      onError: (message) => {
        ctx.io.err(`laurencio daemon: ${message}`)
      },
    })
  } catch (error) {
    state.close()
    if (error instanceof LockHeldError) {
      throw cliError(
        'daemon-running',
        `another daemon is already running (pid ${error.holder.pid} since ${error.holder.startedAt})`,
        { hint: 'Stop it first, or run `laurencio daemon status`.' },
      )
    }
    throw error
  }
  const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM']
  const onSignal = (): void => {
    runtime.stop().catch((error: unknown) => {
      ctx.io.err(`laurencio daemon: ${error instanceof Error ? error.message : String(error)}`)
    })
  }
  for (const signal of signals) process.on(signal, onSignal)
  ctx.io.out(
    `laurencio daemon started (pid ${runtime.state.pid}); ${watchRoots.length} watch roots, interval ${policy.cadence.intervalSeconds}s`,
  )
  try {
    await runtime.whenDone()
  } finally {
    for (const signal of signals) process.off(signal, onSignal)
    state.close()
  }
  return {
    action: 'run',
    platform: ctx.platform,
    service: { path: '', installed: false, logPath: null, logHint: '' },
    daemon: daemonSnapshot(ctx),
    started: true,
    notes: [],
  }
}

function installDaemon(ctx: CommandContext): DaemonData {
  requireSupported(ctx)
  const spec = serviceSpec(ctx)
  const result = installService(spec, {
    ...(ctx.deps.exec === undefined ? {} : { exec: ctx.deps.exec }),
    log: (line) => {
      ctx.io.out(line)
    },
  })
  const status = serviceStatus(spec)
  return {
    action: 'install',
    platform: ctx.platform,
    service: {
      path: result.path,
      installed: result.installed,
      logPath: status.logPath,
      logHint: status.logHint,
    },
    daemon: daemonSnapshot(ctx),
    started: result.started,
    notes: [
      ...(result.alreadyInstalled ? ['already installed and running'] : []),
      ...result.notes,
      status.logHint,
    ],
  }
}

function uninstallDaemon(ctx: CommandContext): DaemonData {
  requireSupported(ctx)
  const spec = serviceSpec(ctx)
  const result = uninstallService(spec, {
    ...(ctx.deps.exec === undefined ? {} : { exec: ctx.deps.exec }),
  })
  const status = serviceStatus(spec)
  return {
    action: 'uninstall',
    platform: ctx.platform,
    service: {
      path: result.path,
      installed: status.installed,
      logPath: status.logPath,
      logHint: status.logHint,
    },
    daemon: daemonSnapshot(ctx),
    started: result.removed,
    notes: result.removed ? [] : ['no service file was present'],
  }
}

function statusDaemon(ctx: CommandContext): DaemonData {
  requireSupported(ctx)
  const status = serviceStatus(serviceSpec(ctx))
  return {
    action: 'status',
    platform: ctx.platform,
    service: {
      path: status.path,
      installed: status.installed,
      logPath: status.logPath,
      logHint: status.logHint,
    },
    daemon: daemonSnapshot(ctx),
    started: false,
    notes: [],
  }
}

export const daemonCommand: CommandSpec = {
  name: 'daemon',
  summary: 'Run, install, or inspect the background sync daemon',
  usage: 'laurencio daemon [run|install|uninstall|status] [--json]',
  details: [
    'install writes a launchd agent on macOS (~/Library/LaunchAgents) or a systemd user unit',
    'on Linux (~/.config/systemd/user), then starts it. Logs land in ~/Library/Logs/laurencio',
    'on macOS and in journald on Linux.',
    '`laurencio pause` and `laurencio resume` stop and restart background syncs.',
  ],
  async run(ctx) {
    switch (ctx.subcommand) {
      case null:
      case 'status': {
        const data = statusDaemon(ctx)
        return ok(data, () => humanDaemon(data))
      }
      case 'install': {
        const data = installDaemon(ctx)
        return ok(data, () => humanDaemon(data))
      }
      case 'uninstall': {
        const data = uninstallDaemon(ctx)
        return ok(data, () => humanDaemon(data))
      }
      case 'run': {
        const data = await runDaemon(ctx)
        return ok(data, () => humanDaemon(data))
      }
      default:
        throw cliError('unknown-subcommand', `unknown daemon subcommand: ${ctx.subcommand}`, {
          hint: 'Known: run, install, uninstall, status',
        })
    }
  },
}
