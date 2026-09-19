import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  daemonProgram,
  type ExecFn,
  type ExecResult,
  installService,
  launchdPlist,
  logFilePath,
  type ServiceSpec,
  serviceFilePath,
  serviceStatus,
  systemdUnit,
  uninstallService,
} from '../src/daemon/installer'
import { makeScratch, runForTest } from './helpers'

function spec(overrides: Partial<ServiceSpec> = {}): ServiceSpec {
  return {
    home: '/Users/andy',
    platform: 'darwin',
    program: '/usr/local/bin/laurencio',
    args: ['daemon', 'run'],
    uid: 501,
    ...overrides,
  }
}

function recorder(status = 0): { calls: string[][]; exec: ExecFn } {
  const calls: string[][] = []
  const exec: ExecFn = (program, args) => {
    calls.push([program, ...args])
    const result: ExecResult = { status, stdout: '', stderr: '' }
    return result
  }
  return { calls, exec }
}

describe('daemon program', () => {
  test('launches bun plus the entry script, or the binary itself', () => {
    expect(
      daemonProgram({ execPath: '/usr/local/bin/bun', main: '/repo/packages/cli/src/index.ts' }),
    ).toEqual({
      program: '/usr/local/bin/bun',
      args: ['/repo/packages/cli/src/index.ts', 'daemon', 'run'],
    })
    expect(
      daemonProgram({ execPath: '/usr/local/bin/laurencio', main: '/usr/local/bin/laurencio' }),
    ).toEqual({ program: '/usr/local/bin/laurencio', args: ['daemon', 'run'] })
  })
})

describe('service file content', () => {
  test('the launchd plist names the daemon, the program, and the log files', () => {
    const plist = launchdPlist(spec())
    expect(plist).toContain('<key>Label</key>')
    expect(plist).toContain('<string>com.laurencio.daemon</string>')
    expect(plist).toContain('<string>/usr/local/bin/laurencio</string>')
    expect(plist).toContain('<string>daemon</string>')
    expect(plist).toContain('<string>run</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<string>/Users/andy/Library/Logs/laurencio/daemon.log</string>')
    expect(plist).toContain('<string>/Users/andy/Library/Logs/laurencio/daemon.log.err</string>')
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  test('the systemd unit runs the daemon and logs to journald', () => {
    const unit = systemdUnit(
      spec({ home: '/home/andy', platform: 'linux', program: '/usr/bin/laurencio', uid: 1000 }),
    )
    expect(unit).toContain('ExecStart=/usr/bin/laurencio daemon run')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('StandardOutput=journal')
    expect(unit).toContain('WantedBy=default.target')
    expect(unit).toContain('[Install]')
  })

  test('service paths follow the platform conventions', () => {
    expect(serviceFilePath(spec())).toBe(
      '/Users/andy/Library/LaunchAgents/com.laurencio.daemon.plist',
    )
    expect(serviceFilePath(spec({ home: '/home/andy', platform: 'linux' }))).toBe(
      '/home/andy/.config/systemd/user/laurencio.service',
    )
    expect(logFilePath(spec())).toBe('/Users/andy/Library/Logs/laurencio/daemon.log')
    expect(logFilePath(spec({ platform: 'linux' }))).toBeNull()
  })
})

describe('install and uninstall', () => {
  test('install writes the plist and bootstraps it, then a repeat is a no-op', () => {
    const scratch = makeScratch()
    try {
      const target = spec({ home: scratch.home, platform: 'darwin' })
      const { calls, exec } = recorder()
      const first = installService(target, { exec })
      expect(first.installed).toBe(true)
      expect(first.started).toBe(true)
      expect(first.alreadyInstalled).toBe(false)
      expect(fs.readFileSync(first.path, 'utf8')).toBe(launchdPlist(target))
      expect(calls).toContainEqual(['launchctl', 'bootstrap', 'gui/501', first.path])

      const second = installService(target, { exec })
      expect(second.alreadyInstalled).toBe(true)
      expect(second.started).toBe(true)

      const removed = uninstallService(target, { exec })
      expect(removed.removed).toBe(true)
      expect(removed.stopped).toBe(true)
      expect(fs.existsSync(first.path)).toBe(false)
      expect(calls).toContainEqual(['launchctl', 'bootout', 'gui/501/com.laurencio.daemon'])
    } finally {
      scratch.cleanup()
    }
  })

  test('a failed bootstrap is reported instead of swallowed', () => {
    const scratch = makeScratch()
    try {
      const target = spec({ home: scratch.home, platform: 'darwin' })
      const exec: ExecFn = () => ({ status: 1, stdout: '', stderr: 'bootstrap failed' })
      const result = installService(target, { exec })
      expect(result.started).toBe(false)
      expect(result.notes.some((note) => note.includes('bootstrap failed'))).toBe(true)
    } finally {
      scratch.cleanup()
    }
  })

  test('the linux unit enables, disables, and leaves no file behind', () => {
    const scratch = makeScratch()
    try {
      const target = spec({ home: scratch.home, platform: 'linux', uid: 1000 })
      const { calls, exec } = recorder()
      const installed = installService(target, { exec })
      expect(installed.path).toBe(serviceFilePath(target))
      expect(fs.readFileSync(installed.path, 'utf8')).toBe(systemdUnit(target))
      expect(calls).toContainEqual(['systemctl', '--user', 'enable', '--now', 'laurencio.service'])
      expect(installed.notes.some((note) => note.includes('enable-linger'))).toBe(true)

      const removed = uninstallService(target, { exec })
      expect(removed.removed).toBe(true)
      expect(fs.existsSync(installed.path)).toBe(false)
      expect(calls).toContainEqual(['systemctl', '--user', 'disable', '--now', 'laurencio.service'])
    } finally {
      scratch.cleanup()
    }
  })

  test('status reports the file path without installing anything', () => {
    const scratch = makeScratch()
    try {
      const target = spec({ home: scratch.home, platform: 'darwin' })
      const before = serviceStatus(target)
      expect(before.installed).toBe(false)
      expect(before.path).toBe(
        path.join(scratch.home, 'Library/LaunchAgents/com.laurencio.daemon.plist'),
      )
    } finally {
      scratch.cleanup()
    }
  })
})

describe('daemon command', () => {
  test('status on an idle home reports stopped and uninstalled', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['daemon', 'status', '--json'], { home: scratch.home })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as {
        daemon: { running: boolean; lastSync: string | null }
        service: { installed: boolean }
      }
      expect(data.daemon.running).toBe(false)
      expect(data.daemon.lastSync).toBeNull()
      expect(data.service.installed).toBe(false)
    } finally {
      scratch.cleanup()
    }
  })

  test('install writes the plist through the injected exec and uninstall removes it', async () => {
    const scratch = makeScratch()
    try {
      const { calls, exec } = recorder()
      const install = await runForTest(['daemon', 'install', '--json'], {
        home: scratch.home,
        deps: { exec },
      })
      expect(install.exitCode).toBe(0)
      const installed = JSON.parse(install.output) as {
        service: { path: string; installed: boolean }
        started: boolean
      }
      expect(installed.service.installed).toBe(true)
      expect(installed.started).toBe(true)
      expect(fs.existsSync(installed.service.path)).toBe(true)

      const uninstall = await runForTest(['daemon', 'uninstall', '--json'], {
        home: scratch.home,
        deps: { exec },
      })
      expect(uninstall.exitCode).toBe(0)
      expect(fs.existsSync(installed.service.path)).toBe(false)
      expect(calls.some((call) => call[0] === 'launchctl')).toBe(true)
    } finally {
      scratch.cleanup()
    }
  })

  test('an unknown subcommand names the known ones', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['daemon', 'frobnicate'], { home: scratch.home })
      expect(out.exitCode).toBe(1)
      expect(out.errorOutput).toContain('unknown daemon subcommand')
      expect(out.errorOutput).toContain('run, install, uninstall, status')
    } finally {
      scratch.cleanup()
    }
  })
})
