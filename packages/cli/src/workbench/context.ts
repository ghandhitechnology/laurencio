import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CommandContext } from '../context'
import { createWorkbenchClient } from './client'
import { WorkbenchController } from './controller'
import { openWorkbenchRegistry } from './registry'
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
