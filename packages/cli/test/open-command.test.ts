import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, WorkbenchSessionId } from '@laurencio/protocol'
import type { CliIo } from '../src/ui'
import type {
  WorkbenchController,
  WorkbenchOpenInput,
  WorkbenchOpenResult,
} from '../src/workbench/controller'
import { makeScratch, NOW, PASSPHRASE, runForTest, scriptedIo, seedStore, TOKEN } from './helpers'

function fakeOpenResult(server: string): WorkbenchOpenResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-test-'))
  const session = {
    id: WorkbenchSessionId.parse('00000000000000000000000007'),
    deviceId: DeviceId.parse('00000000000000000000000008'),
    name: 'temporary',
    platform: 'darwin' as const,
    createdAt: NOW,
    expiresAt: NOW,
  }
  return {
    record: {
      remote: session,
      runtime: {
        id: session.id,
        root,
        home: path.join(root, 'home'),
        cwd: root,
        platform: 'darwin',
        executable: '/bin/tmux',
        configPath: path.join(root, 'tmux.conf'),
        socketPath: path.join(root, 'tmux.sock'),
      },
      server,
      revisionId: null,
    },
    disposition: 'closed',
  }
}

function stubController(opened: { input: WorkbenchOpenInput | null }): WorkbenchController {
  return {
    reap: async () => [],
    open: async (input: WorkbenchOpenInput) => {
      opened.input = input
      return fakeOpenResult(input.server)
    },
  } as unknown as WorkbenchController
}

function trackingIo(): CliIo & { secrets: number; lines: number } {
  const io = scriptedIo()
  const tracked = {
    ...io,
    secrets: 0,
    lines: 0,
    readSecret: async () => {
      tracked.secrets += 1
      return PASSPHRASE
    },
    readLine: async () => {
      tracked.lines += 1
      return ''
    },
  }
  return tracked
}

describe('open command access', () => {
  test('reuses the enrolled device token and cached key without browser or passphrase', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const requested: string[] = []
      const io = trackingIo()
      const opened: { input: WorkbenchOpenInput | null } = { input: null }
      const result = await runForTest(['open'], {
        home: scratch.home,
        deps: {
          io,
          workbenchController: stubController(opened),
          fetch: (async (input: string | URL | Request) => {
            requested.push(String(input))
            throw new Error(`unexpected fetch: ${String(input)}`)
          }) as unknown as typeof fetch,
        },
      })
      expect(result.exitCode).toBe(0)
      expect(requested.some((url) => url.includes('/api/auth/device/code'))).toBe(false)
      expect(opened.input?.accountBearer).toBe(TOKEN)
      expect(io.secrets).toBe(0)
      expect(io.lines).toBe(0)
    } finally {
      scratch.cleanup()
    }
  })

  test('a non-enrolled home keeps the device flow and never asks a yes/no question', async () => {
    const scratch = makeScratch()
    try {
      const requested: string[] = []
      const io = trackingIo()
      const opened: { input: WorkbenchOpenInput | null } = { input: null }
      const result = await runForTest(['open'], {
        home: scratch.home,
        deps: {
          io,
          workbenchController: stubController(opened),
          sleep: async () => {},
          fetch: (async (input: string | URL | Request) => {
            const url = String(input)
            requested.push(url)
            if (url.endsWith('/api/auth/device/code')) {
              return Response.json({
                device_code: 'device-code',
                user_code: 'ABCD-2345',
                expires_in: 600,
                interval: 0,
              })
            }
            if (url.endsWith('/api/auth/device/token')) {
              return Response.json({ access_token: 'lrn_account-bearer' })
            }
            throw new Error(`unexpected fetch: ${url}`)
          }) as unknown as typeof fetch,
        },
      })
      expect(result.exitCode).toBe(0)
      expect(requested.some((url) => url.includes('/api/auth/device/code'))).toBe(true)
      expect(opened.input?.accountBearer).toBe('lrn_account-bearer')
      expect(io.secrets).toBe(1)
      expect(io.lines).toBe(0)
    } finally {
      scratch.cleanup()
    }
  })
})
