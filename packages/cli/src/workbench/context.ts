import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { WorkbenchSessionId } from '@laurencio/protocol'
import type { CommandContext } from '../context'
import { cliProgram } from '../daemon/installer'
import { createWorkbenchClient } from './client'
import { WorkbenchController } from './controller'
import { openWorkbenchRegistry, workbenchOwnerPath } from './registry'
import { createWorkbenchRuntime, type WorkbenchLaunch } from './runtime'

/** Best effort cleanup must not prevent an unrelated command or background sync. */
export async function reapWorkbenchStartup(ctx: CommandContext): Promise<void> {
  try {
    await controllerFor(ctx).reap()
  } catch {
    // Unknown/live runtimes are retained; a later startup or daemon tick retries cleanup.
  }
}

export function controllerFor(ctx: CommandContext): WorkbenchController {
  if (ctx.deps.workbenchController !== undefined) return ctx.deps.workbenchController
  const runtime =
    ctx.deps.workbenchRuntime ??
    createWorkbenchRuntime({ platform: ctx.platform, environment: ctx.env })
  return new WorkbenchController({
    runtime,
    registry: openWorkbenchRegistry(ctx.home),
    client: (server, bearer) =>
      createWorkbenchClient({
        baseUrl: server,
        bearer,
        ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      }),
    root: () => fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-')),
    startOwner: (id) =>
      ctx.deps.startWorkbenchOwner?.(id) ?? startWorkbenchOwner(ctx.home, id, ctx.env),
  })
}

function startWorkbenchOwner(
  home: string,
  id: WorkbenchSessionId,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const invocation = cliProgram(
    {
      execPath: process.execPath,
      main: typeof Bun === 'undefined' ? (process.argv[1] ?? null) : Bun.main,
    },
    ['workbench-owner', id, '--home', home],
  )
  const readyPath = workbenchOwnerPath(home, id)
  fs.rmSync(readyPath, { force: true })
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.program, invocation.args, {
      detached: true,
      stdio: 'ignore',
      env: environment,
    })
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error === undefined) {
        const waitForReady = async (): Promise<void> => {
          const deadline = Date.now() + 5_000
          while (Date.now() < deadline) {
            if (fs.existsSync(readyPath)) {
              child.unref()
              resolve()
              return
            }
            if (child.exitCode !== null) {
              reject(new Error('Workbench cleanup owner exited before it was ready.'))
              return
            }
            await new Promise<void>((next) => setTimeout(next, 25))
          }
          child.kill()
          reject(new Error('Workbench cleanup owner did not become ready.'))
        }
        waitForReady().catch(reject)
      } else reject(error)
    }
    child.once('error', finish)
    child.once('spawn', () => finish())
  })
}

export function workbenchExecutables(ctx: CommandContext): WorkbenchLaunch['executables'] {
  const which = ctx.deps.which ?? ((program: string) => Bun.which(program))
  if (ctx.platform === 'darwin') {
    const tmux = ctx.env.LAURENCIO_TMUX ?? which('tmux')
    return {
      ...(tmux === null || tmux === '' ? {} : { tmux }),
      shell: ctx.env.SHELL ?? '/bin/zsh',
    }
  }
  const wezterm =
    ctx.env.LAURENCIO_WEZTERM ??
    which('wezterm-gui.exe') ??
    which('wezterm-gui') ??
    which('wezterm')
  const powershell = ctx.env.LAURENCIO_PWSH ?? which('pwsh.exe') ?? which('pwsh')
  return {
    ...(wezterm === null || wezterm === '' ? {} : { wezterm }),
    ...(powershell === null || powershell === '' ? {} : { powershell }),
  }
}
