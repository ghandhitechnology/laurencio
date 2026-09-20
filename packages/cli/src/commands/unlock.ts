import { crypto, openTokenStore, tokenAccount } from '@laurencio/core'
import { loadCliConfig } from '../config'
import { cliError } from '../errors'
import { describeKdf, unlockStoreKey } from '../passphrase'
import { readPassphrase } from '../prompt'
import { ok } from '../result'
import { baseUrlFor, identityFor, keychainOptions, openRemote } from '../session'
import { shortId } from '../ui'
import type { CommandSpec } from './command'

export interface UnlockData {
  storeId: string
  kdf: { m: number; t: number; p: number }
  backend: string
}

export const unlockCommand: CommandSpec = {
  name: 'unlock',
  summary: 'Cache the store key from the passphrase',
  usage: 'laurencio unlock [--passphrase-file <path>] [--json]',
  async run(ctx) {
    const identity = identityFor(ctx)
    if (identity === null) {
      throw cliError('not-enrolled', 'this device is not enrolled', {
        hint: 'Run `laurencio enroll` to sign in.',
      })
    }
    const tokenStore = await openTokenStore(keychainOptions(ctx))
    const tokenBytes = await tokenStore.get(
      crypto.KEYCHAIN_SERVICE,
      tokenAccount(identity.deviceId),
    )
    if (tokenBytes === null) {
      throw cliError('missing-token', 'the device token is missing', {
        hint: 'Run `laurencio login` to sign in again.',
      })
    }
    const token = new TextDecoder().decode(tokenBytes)
    const baseUrl = baseUrlFor(ctx, loadCliConfig(ctx.home))
    const remote = await openRemote(ctx, { storeId: identity.storeId, token, baseUrl })
    const passphrase = await readPassphrase(ctx)
    const result = await unlockStoreKey(ctx, {
      remote,
      storeId: identity.storeId,
      token,
      passphrase,
    })
    const data: UnlockData = {
      storeId: identity.storeId,
      kdf: { m: result.kdf.m, t: result.kdf.t, p: result.kdf.p },
      backend: result.backend,
    }
    const human = (): string =>
      [
        `Store key cached for ${shortId(identity.storeId)} in the ${result.backend}.`,
        describeKdf(result.kdf, null),
      ].join('\n')
    return ok(data, human)
  },
}
