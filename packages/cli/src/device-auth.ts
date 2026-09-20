import type { DeviceCodePrompt } from '@laurencio/core'
import { openBrowser } from './browser'
import type { CommandContext } from './context'
import { interactive } from './prompt'

function authorizationUrl(
  prompt: DeviceCodePrompt,
  deviceName: string,
  platform: CommandContext['platform'],
): string {
  const raw = prompt.verificationUriComplete ?? prompt.verificationUri
  try {
    const url = new URL(raw)
    if (prompt.verificationUriComplete === null) {
      url.searchParams.set('user_code', prompt.userCode)
    }
    url.searchParams.set('device_name', deviceName)
    url.searchParams.set('platform', platform)
    return url.toString()
  } catch {
    return raw
  }
}

/** Shows one consistent device-approval flow for both `init` and `login`. */
export async function presentDeviceAuthorization(
  ctx: CommandContext,
  deviceName: string,
  prompt: DeviceCodePrompt,
): Promise<void> {
  const url = authorizationUrl(prompt, deviceName, ctx.platform)
  if (!interactive(ctx)) {
    const line = `Approve ${deviceName}: ${url} (code ${prompt.userCode})`
    if (ctx.flags.json) ctx.io.err(line)
    else ctx.io.out(line)
    return
  }

  ctx.io.out(`Approve ${deviceName} in your browser`)
  const opener = ctx.deps.openUrl ?? ((target: string) => openBrowser(target, ctx.platform))
  const opened = await opener(url)
  if (opened) {
    ctx.io.out('Browser opened. Copy this link if you need it:')
  } else {
    ctx.io.out('Open this link:')
  }
  ctx.io.out(url)
  ctx.io.out(`Device code: ${prompt.userCode}`)
  ctx.io.out('Waiting for approval...')
}

export function deviceApproved(ctx: CommandContext, deviceName: string): void {
  if (interactive(ctx)) ctx.io.out(`Approved. ${deviceName} is linked.`)
}
