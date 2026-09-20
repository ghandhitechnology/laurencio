import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { authorizeWithDeviceCode, type crypto, DeviceAuthError } from '@laurencio/core'
import { DEFAULT_SERVER_URL, loadCliConfig } from '../config'
import { deviceApproved, presentDeviceAuthorization } from '../device-auth'
import { CliError, cliError } from '../errors'
import { createWorkbenchProgress } from '../progress'
import { readPassphrase } from '../prompt'
import { ok } from '../result'
import { baseUrlFor, deviceToken, identityFor, openSession } from '../session'
import { createWorkbenchClient } from '../workbench/client'
import { controllerFor, workbenchExecutables } from '../workbench/context'
import type { WorkbenchOpenResult } from '../workbench/controller'
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

function sameServer(left: string, right: string): boolean {
  try {
    return new URL(left).toString() === new URL(right).toString()
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
  }
}

function fetchWithTimeout(source: typeof fetch, timeoutMs = 10_000): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) =>
    source(input, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
    })) as unknown as typeof fetch
}

async function acceptsDeviceToken(
  ctx: Parameters<CommandSpec['run']>[0],
  server: string,
  token: string,
): Promise<boolean> {
  try {
    await createWorkbenchClient({
      baseUrl: server,
      bearer: token,
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
    }).account()
    return true
  } catch (error) {
    if (error instanceof DeviceAuthError) return false
    throw error
  }
}

async function enrolledAuthorization(
  ctx: Parameters<CommandSpec['run']>[0],
  server: string,
): Promise<{
  accountBearer: string
  unlock: string | crypto.KeyMaterial
  key: crypto.KeyMaterial | null
} | null> {
  try {
    const session = await openSession(ctx)
    try {
      if (!(await acceptsDeviceToken(ctx, server, session.credentials.token))) {
        session.credentials.key.zeroize()
        return null
      }
    } catch (error) {
      session.credentials.key.zeroize()
      throw error
    }
    return {
      accountBearer: session.credentials.token,
      unlock: session.credentials.key,
      key: session.credentials.key,
    }
  } catch (error) {
    if (!(error instanceof CliError) || error.code !== 'missing-key') {
      if (error instanceof CliError && error.code === 'missing-token') return null
      throw error
    }
  }

  const identity = identityFor(ctx)
  if (identity === null) return null
  let token: string
  try {
    token = await deviceToken(ctx, identity.deviceId)
  } catch (error) {
    if (error instanceof CliError && error.code === 'missing-token') return null
    throw error
  }
  if (!(await acceptsDeviceToken(ctx, server, token))) return null
  return { accountBearer: token, unlock: await readPassphrase(ctx), key: null }
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
    const progress = createWorkbenchProgress(ctx.io, ctx.flags.json)
    const cacheTools = true
    let cachedKey: crypto.KeyMaterial | null = null
    let result: WorkbenchOpenResult
    try {
      let accountBearer: string
      let unlock: string | crypto.KeyMaterial
      const enrolledServer = config.server ?? DEFAULT_SERVER_URL
      if (identityFor(ctx) !== null && sameServer(server, enrolledServer)) {
        const enrolled = await enrolledAuthorization(ctx, server)
        if (enrolled === null) {
          const authorization = await authorizeWithDeviceCode({
            baseUrl: server,
            deviceName: name,
            platform: ctx.platform,
            fetch: fetchWithTimeout(ctx.deps.fetch ?? globalThis.fetch),
            ...(ctx.deps.sleep === undefined ? {} : { sleep: ctx.deps.sleep }),
            onPrompt: async (prompt) => {
              await presentDeviceAuthorization(ctx, name, prompt)
              progress.phase('authorizing')
            },
          })
          progress.pause()
          deviceApproved(ctx, name)
          accountBearer = authorization.accessToken
          unlock = await readPassphrase(ctx)
        } else {
          accountBearer = enrolled.accountBearer
          cachedKey = enrolled.key
          unlock = enrolled.unlock
        }
      } else {
        const authorization = await authorizeWithDeviceCode({
          baseUrl: server,
          deviceName: name,
          platform: ctx.platform,
          fetch: fetchWithTimeout(ctx.deps.fetch ?? globalThis.fetch),
          ...(ctx.deps.sleep === undefined ? {} : { sleep: ctx.deps.sleep }),
          onPrompt: async (prompt) => {
            await presentDeviceAuthorization(ctx, name, prompt)
            progress.phase('authorizing')
          },
        })
        progress.pause()
        deviceApproved(ctx, name)
        accountBearer = authorization.accessToken
        unlock = await readPassphrase(ctx)
      }
      const controller = controllerFor(ctx)
      progress.phase('preparing')
      await controller.reap()
      result = await controller.open({
        server,
        accountBearer,
        name,
        platform: ctx.platform,
        cwd: projectPath,
        executables: workbenchExecutables(ctx),
        onPhase: (phase) => {
          if (phase === 'ready') progress.succeed()
          else progress.phase(phase)
        },
        materialize: (input) =>
          materializeWorkbench(ctx, input, unlock, {
            cacheTools,
            onPhase: progress.phase,
            onSyncProgress: progress.sync,
          }),
      })
    } finally {
      cachedKey?.zeroize()
      progress.finish()
    }
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
