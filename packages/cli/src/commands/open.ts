import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authorizeWithDeviceCode } from '@laurencio/core'
import { DEFAULT_SERVER_URL, loadCliConfig } from '../config'
import { deviceApproved, presentDeviceAuthorization } from '../device-auth'
import { cliError } from '../errors'
import { askYesNo, readPassphrase } from '../prompt'
import { ok } from '../result'
import { baseUrlFor } from '../session'
import { controllerFor, workbenchExecutables } from '../workbench/context'
import { materializeWorkbench } from '../workbench/materialize'
import type { CommandSpec } from './command'

interface OpenData {
  id: string
  revisionId: string | null
  state: 'running' | 'closed'
  platform: 'darwin' | 'win32'
  root: string
  cacheTools: boolean
}

function humanOpen(data: OpenData): string {
  const lines = [
    `Temporary workbench ${data.id}`,
    `State: ${data.state}`,
    `Revision: ${data.revisionId ?? 'none'}`,
  ]
  if (data.state === 'running') {
    lines.push('Changes stay private until you run `laurencio save <session> --surface <id>`.')
  } else {
    lines.push('The private configuration and session token were deleted.')
  }
  return lines.join('\n')
}

export const openCommand: CommandSpec = {
  name: 'open',
  summary: 'Launch an isolated, expiring workbench',
  usage: 'laurencio open [project-path] [--server <url>] [--passphrase-file <path>] [--json]',
  details: [
    'Uses a private home while leaving the project filesystem available.',
    'macOS launches tmux; Windows launches portable WezTerm with profile-free PowerShell.',
  ],
  async run(ctx) {
    if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
      throw cliError('unsupported-platform', 'temporary workbenches support macOS and Windows')
    }
    const projectPath = path.resolve(ctx.cwd, ctx.positionals[0] ?? '.')
    if (!fs.statSync(projectPath, { throwIfNoEntry: false })?.isDirectory()) {
      throw cliError('invalid-project', `project directory does not exist: ${projectPath}`)
    }
    const config = loadCliConfig(ctx.home)
    const server = baseUrlFor(ctx, config) ?? DEFAULT_SERVER_URL
    const name = (ctx.flags.name ?? `temporary on ${os.hostname()}`).slice(0, 80)
    const authorization = await authorizeWithDeviceCode({
      baseUrl: server,
      deviceName: name,
      platform: ctx.platform,
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      ...(ctx.deps.sleep === undefined ? {} : { sleep: ctx.deps.sleep }),
      onPrompt: (prompt) => presentDeviceAuthorization(ctx, name, prompt),
    })
    deviceApproved(ctx, name)
    const cacheTools = await askYesNo(
      ctx,
      'Keep downloaded public tools after this session?',
      false,
    )
    const passphrase = await readPassphrase(ctx)
    const controller = controllerFor(ctx)
    await controller.reap()
    const result = await controller.open({
      server,
      accountBearer: authorization.accessToken,
      name,
      platform: ctx.platform,
      cwd: projectPath,
      executables: workbenchExecutables(ctx),
      materialize: (input) => materializeWorkbench(ctx, input, passphrase, { cacheTools }),
    })
    const data: OpenData = {
      id: result.record.remote.id,
      revisionId: result.record.revisionId,
      state: result.disposition,
      platform: ctx.platform,
      root: result.record.runtime.root,
      cacheTools,
    }
    return ok(data, () => humanOpen(data))
  },
}
