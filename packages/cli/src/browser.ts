import { spawn } from 'node:child_process'
import type { Platform } from '@laurencio/core'

export interface BrowserCommand {
  program: string
  args: string[]
}

/** Returns the platform command without invoking a shell. */
export function browserCommand(url: string, platform: Platform): BrowserCommand {
  if (platform === 'darwin') return { program: 'open', args: [url] }
  if (platform === 'win32') {
    return {
      program: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    }
  }
  return { program: 'xdg-open', args: [url] }
}

/** Opens an HTTP(S) URL in the default browser. Failures stay recoverable. */
export async function openBrowser(url: string, platform: Platform): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false

  const command = browserCommand(parsed.toString(), platform)
  return new Promise<boolean>((resolve) => {
    try {
      const child = spawn(command.program, command.args, {
        detached: true,
        stdio: 'ignore',
      })
      let settled = false
      const finish = (opened: boolean): void => {
        if (settled) return
        settled = true
        resolve(opened)
      }
      child.once('error', () => finish(false))
      child.once('spawn', () => {
        child.unref()
        finish(true)
      })
    } catch {
      resolve(false)
    }
  })
}
