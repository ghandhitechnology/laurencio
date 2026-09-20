import os from 'node:os'
import { loginWithDeviceCode, readDeviceIdentity } from '@laurencio/core'
import { loadCliConfig, saveCliConfig } from '../config'
import type { CommandContext } from '../context'
import { deviceApproved, presentDeviceAuthorization } from '../device-auth'
import { cliError } from '../errors'
import { setStoreKey } from '../passphrase'
import { readPassphrase } from '../prompt'
import { ok } from '../result'
import { baseUrlFor, keychainOptions, openRemote } from '../session'
import { shortId } from '../ui'
import type { CommandSpec } from './command'

export interface LoginData {
  server: string
  deviceId: string
  deviceName: string
  storeId: string
  tokenBackend: string
  keyBackend: string
}

/** A reachability check so offline machines get a clear message, not a stack. */
export async function serverReachable(ctx: CommandContext, baseUrl: string): Promise<boolean> {
  try {
    const response = await (ctx.deps.fetch ?? globalThis.fetch)(
      new URL('/health', baseUrl).toString(),
      { signal: AbortSignal.timeout(4000) },
    )
    return response.ok || response.status === 503
  } catch {
    return false
  }
}

export const loginCommand: CommandSpec = {
  name: 'login',
  summary: 'Sign in with the device flow and cache the store key',
  usage: 'laurencio login [--server <url>] [--device-name <name>] [--passphrase-file <path>]',
  async run(ctx) {
    const baseUrl = baseUrlFor(ctx, loadCliConfig(ctx.home))
    if (baseUrl === null || baseUrl === '') {
      throw cliError('no-server', 'login needs a server URL', {
        hint: 'Pass --server <url> or set LAURENCIO_SERVER.',
      })
    }
    if (!(await serverReachable(ctx, baseUrl))) {
      throw cliError('offline', `the server at ${baseUrl} is not reachable`)
    }
    const existing = readDeviceIdentity(ctx.home)
    if (existing !== null) {
      throw cliError('already-enrolled', `this device is already enrolled as ${existing.name}`, {
        hint: 'Run `laurencio status` or `laurencio init`.',
      })
    }
    saveCliConfig(ctx.home, { ...loadCliConfig(ctx.home), server: baseUrl })
    const deviceName = ctx.flags.deviceName ?? ctx.flags.name ?? os.hostname()
    const result = await loginWithDeviceCode({
      ...keychainOptions(ctx),
      baseUrl,
      deviceName,
      platform: ctx.platform,
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      onPrompt: (prompt) => presentDeviceAuthorization(ctx, deviceName, prompt),
    })
    deviceApproved(ctx, result.identity.name)

    const passphrase = await readPassphrase(ctx)
    const remote = await openRemote(ctx, {
      storeId: result.identity.storeId,
      token: result.token,
      baseUrl,
    })
    const keySetup = await setStoreKey(ctx, {
      remote,
      storeId: result.identity.storeId,
      token: result.token,
      baseUrl,
      passphrase,
    })
    const data: LoginData = {
      server: baseUrl,
      deviceId: result.identity.deviceId,
      deviceName: result.identity.name,
      storeId: result.identity.storeId,
      tokenBackend: result.backend,
      keyBackend: keySetup.backend,
    }
    const human = (): string =>
      [
        `Signed in as ${result.identity.name} (${shortId(result.identity.deviceId)})`,
        `Store: ${result.identity.storeId}`,
        `Device token: ${result.backend}`,
        `Store key: ${keySetup.backend}`,
        'Next: `laurencio init` to select surfaces and push.',
      ].join('\n')
    return ok(data, human)
  },
}
