import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { defaultPolicy } from '@laurencio/core'
import { WorkbenchSessionId } from '@laurencio/protocol'
import { runCli } from '../src/cli'
import { saveCliConfig } from '../src/config'
import type { WorkbenchController } from '../src/workbench/controller'
import { makeScratch, runForTest, STORE_ID, seedStore, TOKEN } from './helpers'

describe('portable workbench CLI', () => {
  test('exposes enroll as the full-mode entry point and keeps init as a deprecated alias', async () => {
    const help = await runCli(['--help'])
    const initHelp = await runCli(['init', '--help'])

    expect(help.output).toContain('enroll')
    expect(initHelp.output).toContain('Deprecated')
    expect(initHelp.output).toContain('laurencio enroll')
  })

  test('bare laurencio presents the two lifecycle choices in an interactive terminal', async () => {
    const live: string[] = []
    const output = await runCli([], {
      io: {
        terminal: {
          write: () => {},
          columns: () => 80,
          onInterrupt: () => () => {},
        },
        out: (text) => live.push(text),
        err: () => {},
        readLine: async () => {
          expect(live.join('\n')).toContain('Manage configuration')
          return 'q'
        },
        readSecret: async () => '',
      },
    })

    expect(output.exitCode).toBe(0)
    expect(live.join('\n')).toContain('Temporary workbench')
    expect(live.join('\n')).toContain('Full enrollment')
    expect(output.output).toBe('')
  })

  test('opens from enrolled credentials without another browser login or passphrase prompt', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const server = 'https://sync.example'
      saveCliConfig(scratch.home, { server, policy: defaultPolicy() })
      let opened = 0
      const requested: string[] = []
      const controller = {
        reap: async () => [],
        open: async (input: { accountBearer: string }) => {
          opened += 1
          expect(input.accountBearer).toBe(TOKEN)
          return {
            disposition: 'running' as const,
            record: {
              remote: {
                id: WorkbenchSessionId.parse('00000000000000000000000003'),
                deviceId: seeded.identity.deviceId,
                name: 'temporary',
                platform: 'darwin' as const,
                createdAt: '2026-09-21T00:00:00.000Z',
                expiresAt: '2026-09-21T01:00:00.000Z',
              },
              runtime: {
                id: '00000000000000000000000003',
                root: '/tmp/lwb-enrolled',
                home: '/tmp/lwb-enrolled/home',
                cwd: '/tmp',
                platform: 'darwin' as const,
                executable: '/bin/tmux',
                configPath: '/tmp/lwb-enrolled/tmux.conf',
                socketPath: '/tmp/lwb-enrolled/tmux.sock',
              },
              server,
              revisionId: null,
            },
          }
        },
      } as unknown as WorkbenchController

      const result = await runForTest(['open', scratch.home, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: {
          workbenchController: controller,
          fetch: (async (input: string | URL | Request) => {
            const target = new URL(
              typeof input === 'string' ? input : input instanceof URL ? input : input.url,
            )
            requested.push(target.pathname)
            if (target.pathname !== '/v1/me') {
              throw new Error('enrolled open must not start device authorization')
            }
            return Response.json({
              protocolVersion: 1,
              userId: '00000000000000000000000004',
              storeId: STORE_ID,
              devices: [],
              kdf: null,
              quotas: { blobs: 0, bytes: 0, maxBytes: 100 },
            })
          }) as unknown as typeof fetch,
          cwd: path.dirname(scratch.home),
        },
      })

      expect(result.exitCode).toBe(0)
      expect(opened).toBe(1)
      expect(requested).toEqual(['/v1/me'])
      expect(result.output).toContain('"cacheTools": true')
    } finally {
      scratch.cleanup()
    }
  })

  test('falls back to browser authorization when the enrolled token was revoked', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const server = 'https://sync.example'
      saveCliConfig(scratch.home, { server, policy: defaultPolicy() })
      const requested: string[] = []
      let bearer = ''
      const controller = {
        reap: async () => [],
        open: async (input: { accountBearer: string }) => {
          bearer = input.accountBearer
          return {
            disposition: 'running' as const,
            record: {
              remote: {
                id: WorkbenchSessionId.parse('00000000000000000000000003'),
                deviceId: seeded.identity.deviceId,
                name: 'temporary',
                platform: 'darwin' as const,
                createdAt: '2026-09-21T00:00:00.000Z',
                expiresAt: '2026-09-21T01:00:00.000Z',
              },
              runtime: {
                id: '00000000000000000000000003',
                root: '/tmp/lwb-enrolled',
                home: '/tmp/lwb-enrolled/home',
                cwd: '/tmp',
                platform: 'darwin' as const,
                executable: '/bin/tmux',
                configPath: '/tmp/lwb-enrolled/tmux.conf',
                socketPath: '/tmp/lwb-enrolled/tmux.sock',
              },
              server,
              revisionId: null,
            },
          }
        },
      } as unknown as WorkbenchController

      const result = await runForTest(['open', scratch.home, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        env: { LAURENCIO_PASSPHRASE: 'cli-test-passphrase' },
        deps: {
          workbenchController: controller,
          fetch: (async (input: string | URL | Request) => {
            const target = new URL(
              typeof input === 'string' ? input : input instanceof URL ? input : input.url,
            )
            requested.push(target.pathname)
            if (target.pathname === '/v1/me') {
              return Response.json(
                { code: 'unauthenticated', message: 'device token was revoked' },
                { status: 401 },
              )
            }
            if (target.pathname === '/api/auth/device/code') {
              return Response.json({
                device_code: 'device-code',
                user_code: 'ABCD2345',
                verification_uri: `${server}/device`,
                verification_uri_complete: `${server}/device?user_code=ABCD2345`,
                expires_in: 600,
                interval: 0,
              })
            }
            if (target.pathname === '/api/auth/device/token') {
              return Response.json({ access_token: 'fresh-account-token' })
            }
            throw new Error(`unexpected request: ${target.pathname}`)
          }) as unknown as typeof fetch,
        },
      })

      expect(result.exitCode).toBe(0)
      expect(bearer).toBe('fresh-account-token')
      expect(requested).toEqual(['/v1/me', '/api/auth/device/code', '/api/auth/device/token'])
    } finally {
      scratch.cleanup()
    }
  })
})
