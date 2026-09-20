import { describe, expect, test } from 'bun:test'
import { parseCliArgs } from '../src/args'
import { browserCommand, openBrowser } from '../src/browser'
import { createContext } from '../src/context'
import { deviceApproved, presentDeviceAuthorization } from '../src/device-auth'
import { scriptedIo } from './helpers'

const prompt = {
  userCode: 'ABCD2345',
  verificationUri: 'https://sync.example/device',
  verificationUriComplete: 'https://sync.example/device?user_code=ABCD2345',
  expiresAt: '2026-09-19T12:10:00.000Z',
  intervalSeconds: 5,
}

const completeUrl =
  'https://sync.example/device?user_code=ABCD2345&device_name=Studio+Mac&platform=darwin'

function context(
  argv: readonly string[],
  options: { openUrl?: (url: string) => Promise<boolean> } = {},
) {
  const parsed = parseCliArgs(argv)
  const io = scriptedIo()
  return {
    ctx: createContext('login', null, [], parsed.flags, {
      home: '/tmp/laurencio-device-auth-test',
      platform: 'darwin',
      env: {},
      io,
      ...options,
    }),
    io,
  }
}

describe('device authorization presentation', () => {
  test('opens the complete verification link and keeps a copyable fallback', async () => {
    const opened: string[] = []
    const { ctx, io } = context(['login'], {
      openUrl: async (url) => {
        opened.push(url)
        return true
      },
    })

    await presentDeviceAuthorization(ctx, 'Studio Mac', prompt)
    deviceApproved(ctx, 'Studio Mac')

    expect(opened).toEqual([completeUrl])
    expect(io.output).toEqual([
      'Approve Studio Mac in your browser',
      'Browser opened. Copy this link if you need it:',
      completeUrl,
      'Device code: ABCD2345',
      'Waiting for approval...',
      'Approved. Studio Mac is linked.',
    ])
  })

  test('does not launch a browser in JSON or --yes mode', async () => {
    for (const argv of [
      ['login', '--json'],
      ['login', '--yes'],
    ]) {
      let launches = 0
      const { ctx, io } = context(argv, {
        openUrl: async () => {
          launches += 1
          return true
        },
      })
      await presentDeviceAuthorization(ctx, 'Laptop', prompt)
      deviceApproved(ctx, 'Laptop')

      expect(launches).toBe(0)
      expect(io.output).toEqual([
        'Approve Laptop: https://sync.example/device?user_code=ABCD2345&device_name=Laptop&platform=darwin (code ABCD2345)',
      ])
    }
  })

  test('prefills the code when the server omits a complete link', async () => {
    const opened: string[] = []
    const { ctx, io } = context(['login'], {
      openUrl: async (url) => {
        opened.push(url)
        return false
      },
    })

    await presentDeviceAuthorization(ctx, 'Laptop', {
      ...prompt,
      verificationUriComplete: null,
    })

    const fallback =
      'https://sync.example/device?user_code=ABCD2345&device_name=Laptop&platform=darwin'
    expect(opened).toEqual([fallback])
    expect(io.output).toContain('Open this link:')
    expect(io.output).toContain(fallback)
  })
})

describe('browser launch commands', () => {
  test('uses the native default-browser launcher on each platform', () => {
    const url = 'https://sync.example/device?user_code=ABCD2345'
    expect(browserCommand(url, 'darwin')).toEqual({ program: 'open', args: [url] })
    expect(browserCommand(url, 'linux')).toEqual({ program: 'xdg-open', args: [url] })
    expect(browserCommand(url, 'win32')).toEqual({
      program: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    })
  })

  test('refuses non-web links', async () => {
    expect(await openBrowser('file:///tmp/not-safe', 'darwin')).toBe(false)
    expect(await openBrowser('not a url', 'darwin')).toBe(false)
  })
})
