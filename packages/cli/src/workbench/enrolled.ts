import { crypto, readDeviceIdentity } from '@laurencio/core'
import { DEFAULT_SERVER_URL, loadCliConfig } from '../config'
import type { CommandContext } from '../context'
import { deviceToken, keychainOptions } from '../session'

/**
 * On the machine where this device was enrolled, `open` skips the browser
 * approval and the passphrase prompt: the device token already authorizes
 * workbench sessions and the store key is already cached. Any gap falls back
 * to the device-code flow.
 */
export async function enrolledWorkbenchAccess(
  ctx: CommandContext,
  server: string,
): Promise<{ bearer: string; key: crypto.KeyMaterial | null } | null> {
  const identity = readDeviceIdentity(ctx.home)
  if (identity === null) return null
  const enrolledServer = loadCliConfig(ctx.home).server ?? DEFAULT_SERVER_URL
  if (enrolledServer !== server) return null
  let bearer: string
  try {
    bearer = await deviceToken(ctx, identity.deviceId)
  } catch {
    return null
  }
  let key: crypto.KeyMaterial | null = null
  try {
    key = await (await crypto.openKeyCache(keychainOptions(ctx))).load(identity.storeId)
  } catch {
    key = null
  }
  return { bearer, key }
}
