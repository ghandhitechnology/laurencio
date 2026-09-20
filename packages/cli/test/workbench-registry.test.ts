import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, RevisionId, WorkbenchSessionId } from '@laurencio/protocol'
import {
  openWorkbenchRegistry,
  parseWorkbenchRecord,
  type RegisteredWorkbench,
  workbenchTokenPath,
} from '../src/workbench/registry'

function fixture(home: string): RegisteredWorkbench {
  const root = path.join(home, 'runtime')
  return {
    remote: {
      id: WorkbenchSessionId.parse('00000000000000000000000001'),
      deviceId: DeviceId.parse('00000000000000000000000002'),
      name: 'temporary',
      platform: 'darwin',
      createdAt: '2026-09-20T00:00:00.000Z',
      expiresAt: '2026-09-21T00:00:00.000Z',
    },
    runtime: {
      id: '00000000000000000000000001',
      root,
      home: path.join(root, 'home'),
      cwd: home,
      platform: 'darwin',
      executable: '/opt/homebrew/bin/tmux',
      configPath: path.join(root, 'tmux.conf'),
      socketPath: path.join(root, 'tmux.sock'),
    },
    server: 'https://laurencio.test',
    revisionId: RevisionId.parse('00000000000000000000000003'),
  }
}

describe('local workbench registry', () => {
  test('persists secret-free lifecycle metadata and keeps the token in the private root', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-registry-'))
    const registry = openWorkbenchRegistry(home)
    const record = fixture(home)

    registry.save(record, 'lrn_temporary-secret-token')

    expect(registry.list()).toEqual([record])
    expect(registry.get(record.remote.id)).toEqual(record)
    const metadata = fs.readFileSync(
      path.join(home, '.laurencio', 'workbenches', `${record.remote.id}.json`),
      'utf8',
    )
    expect(metadata).not.toContain('temporary-secret-token')
    expect(fs.readFileSync(workbenchTokenPath(record.runtime.root), 'utf8').trim()).toBe(
      'lrn_temporary-secret-token',
    )
    expect(fs.statSync(workbenchTokenPath(record.runtime.root)).mode & 0o777).toBe(0o600)

    registry.remove(record.remote.id)
    expect(registry.list()).toEqual([])
  })

  test('ignores malformed registry records instead of trusting their paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-registry-'))
    const directory = path.join(home, '.laurencio', 'workbenches')
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'broken.json'), '{"runtime":{"root":"/"}}')

    expect(openWorkbenchRegistry(home).list()).toEqual([])
  })

  test('rejects Windows host artifacts that do not match the recorded process', () => {
    const record = fixture('C:\\Users\\andy')
    record.remote.platform = 'win32'
    record.runtime = {
      id: record.remote.id,
      root: 'C:\\Temp\\workbench',
      home: 'C:\\Temp\\workbench\\home',
      cwd: 'C:\\project',
      platform: 'win32',
      executable: 'C:\\Temp\\workbench\\laurencio-terminal.exe',
      configPath: 'C:\\Temp\\workbench\\wezterm.lua',
      socketPath: 'C:\\Temp\\workbench\\wezterm.sock',
      powershell: 'pwsh.exe',
      process: { pid: 4242, identity: 'original-process' },
      windowsHostArtifacts: {
        directory: 'C:\\Users\\andy\\.local\\share\\wezterm',
        directoryCreated: false,
        socketPath: 'C:\\Users\\andy\\Documents\\important.txt',
        logPath: 'C:\\Users\\andy\\.local\\share\\wezterm\\laurencio-terminal.exe-log-4242.txt',
      },
    }

    expect(parseWorkbenchRecord(record)).toBeNull()
  })
})
