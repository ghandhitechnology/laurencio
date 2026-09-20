import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, type WorkbenchSession, WorkbenchSessionId } from '@laurencio/protocol'
import { runCli } from '../src/cli'
import { WorkbenchController, type WorkbenchMaterializeInput } from '../src/workbench/controller'
import {
  openWorkbenchRegistry,
  type PendingWorkbench,
  type RegisteredWorkbench,
  type WorkbenchRegistry,
} from '../src/workbench/registry'
import { WorkbenchLaunchError, type WorkbenchRuntime } from '../src/workbench/runtime'

const remoteSession: WorkbenchSession = {
  id: WorkbenchSessionId.parse('00000000000000000000000001'),
  deviceId: DeviceId.parse('00000000000000000000000002'),
  name: 'temporary',
  platform: 'darwin',
  createdAt: '2026-09-20T00:00:00.000Z',
  expiresAt: '2026-09-21T00:00:00.000Z',
}

function harness(state: 'running' | 'stopped', root = '/tmp/lwb-test') {
  const records = new Map<string, { record: RegisteredWorkbench; token: string }>()
  const events: string[] = []
  const registry: WorkbenchRegistry = {
    save: (record, token) => {
      records.set(record.remote.id, { record, token })
      events.push('saved')
    },
    get: (id) => records.get(id)?.record ?? null,
    list: () => [...records.values()].map((entry) => entry.record),
    token: (record) => records.get(record.remote.id)?.token ?? null,
    remove: (id) => {
      records.delete(id)
      events.push('forgotten')
    },
  }
  const runtimeSession = {
    id: remoteSession.id,
    root,
    home: path.join(root, 'home'),
    cwd: '/project',
    platform: 'darwin' as const,
    executable: '/bin/tmux',
    configPath: path.join(root, 'tmux.conf'),
    socketPath: path.join(root, 'tmux.sock'),
  }
  const runtime: WorkbenchRuntime = {
    launch: async () => {
      events.push('launched')
      return runtimeSession
    },
    attach: async () => {
      events.push('attached')
    },
    inspect: async () => ({ state }),
    close: async () => {
      events.push('runtime-closed')
      fs.rmSync(root, { recursive: true, force: true })
    },
    reap: async () => [],
  }
  let bearer = ''
  const controller = new WorkbenchController({
    runtime,
    registry,
    root: () => root,
    client: (_server, initialBearer) => {
      bearer = initialBearer
      return {
        setBearer: (value) => {
          bearer = value
        },
        account: async () => {
          throw new Error('unused')
        },
        create: async () => ({ session: remoteSession, token: 'lrn_temporary-token' }),
        list: async () => [],
        close: async () => {
          events.push(`remote-closed:${bearer}`)
          return { ...remoteSession, closedAt: '2026-09-20T01:00:00.000Z' }
        },
      }
    },
  })
  return { controller, events, records, runtimeSession, runtime }
}

describe('workbench controller', () => {
  test('ordinary command startup reaps a killed materializer but retains a live owner', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-owner-test-'))
    const root = path.join(home, 'private')
    const registry = openWorkbenchRegistry(home)
    const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child.kill()
    await child.exited
    const h = harness('stopped', root)
    const controller = new WorkbenchController({
      runtime: h.runtime,
      registry,
      root: () => root,
      client: () => {
        throw new Error('cleanup must not need network access')
      },
    })
    const pending: PendingWorkbench = {
      remote: remoteSession,
      server: 'https://laurencio.test',
      root,
      ownerPid: process.pid,
      phase: 'materializing',
    }
    const record = () => {
      fs.mkdirSync(root, { recursive: true })
      fs.writeFileSync(path.join(root, 'secret'), 'decrypted credential')
      fs.writeFileSync(path.join(root, 'launch-owner.json'), JSON.stringify(pending))
      registry.pending?.(pending)
    }
    try {
      record()
      expect(await controller.reap()).toEqual([])
      expect(fs.existsSync(root)).toBe(true)
      pending.ownerPid = child.pid
      record()
      await runCli(['status', '--json'], {
        home,
        platform: 'darwin',
        workbenchController: controller,
      })
      expect(fs.existsSync(root)).toBe(false)
      expect(registry.pendingList?.()).toEqual([])
    } finally {
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
  test('forwards materialized environment secrets to launch without storing them in the registry', async () => {
    const h = harness('running')
    let childSecret: string | undefined
    h.runtime.launch = async (input) => {
      childSecret = input.environment?.MCP_API_KEY
      return h.runtimeSession
    }
    await h.controller.open({
      server: 'https://laurencio.test',
      accountBearer: 'account-token',
      name: 'temporary',
      platform: 'darwin',
      cwd: '/project',
      executables: { tmux: '/bin/tmux' },
      materialize: async (input) => {
        input.environment.MCP_API_KEY = 'materialized-mcp-secret'
        return null
      },
    })
    expect(childSecret).toBe('materialized-mcp-secret')
    expect(JSON.stringify([...h.records.values()])).not.toContain('materialized-mcp-secret')
  })

  test('retains private files if launch rollback cannot stop the terminal process', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-retain-'))
    const h = harness('running', root)
    h.runtime.launch = async () => {
      throw new WorkbenchLaunchError('process could not be stopped')
    }
    try {
      await expect(
        h.controller.open({
          server: 'https://laurencio.test',
          accountBearer: 'account-token',
          name: 'temporary',
          platform: 'darwin',
          cwd: '/project',
          executables: { tmux: '/bin/tmux' },
          materialize: async () => null,
        }),
      ).rejects.toThrow('process could not be stopped')
      expect(fs.existsSync(root)).toBe(true)
      expect(h.events).toContain('remote-closed:lrn_temporary-token')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  test('materializes before launch and retains a detached session', async () => {
    const h = harness('running')
    let materialized: WorkbenchMaterializeInput | null = null
    const result = await h.controller.open({
      server: 'https://laurencio.test',
      accountBearer: 'account-token',
      name: 'temporary',
      platform: 'darwin',
      cwd: '/project',
      executables: { tmux: '/bin/tmux' },
      materialize: async (input) => {
        materialized = input
        h.events.push('materialized')
        return null
      },
    })

    expect(materialized).toMatchObject({
      token: 'lrn_temporary-token',
      root: '/tmp/lwb-test',
      home: path.join('/tmp/lwb-test', 'home'),
    })
    expect(result.disposition).toBe('running')
    expect(h.events).toEqual(['materialized', 'launched', 'saved', 'attached'])
    expect(h.records.size).toBe(1)
  })

  test('closes both actors and deletes registry state when the terminal exits', async () => {
    const h = harness('stopped')
    const result = await h.controller.open({
      server: 'https://laurencio.test',
      accountBearer: 'account-token',
      name: 'temporary',
      platform: 'darwin',
      cwd: '/project',
      executables: { tmux: '/bin/tmux' },
      materialize: async () => null,
    })

    expect(result.disposition).toBe('closed')
    expect(h.events).toEqual([
      'launched',
      'saved',
      'attached',
      'remote-closed:lrn_temporary-token',
      'runtime-closed',
      'forgotten',
    ])
    expect(h.records.size).toBe(0)
  })

  test('keeps registry state when runtime cleanup leaves the private root behind', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-close-verify-'))
    const h = harness('stopped', root)
    h.runtime.close = async () => {
      h.events.push('runtime-close-incomplete')
    }
    try {
      await expect(
        h.controller.open({
          server: 'https://laurencio.test',
          accountBearer: 'account-token',
          name: 'temporary',
          platform: 'darwin',
          cwd: '/project',
          executables: { tmux: '/bin/tmux' },
          materialize: async () => null,
        }),
      ).rejects.toThrow('private root still exists')
      expect(h.records.size).toBe(1)
      expect(h.events).not.toContain('forgotten')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
