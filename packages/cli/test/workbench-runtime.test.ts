import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createWorkbenchRuntime,
  type RuntimeCommand,
  routeWorkbenchEnvironment,
  WorkbenchLaunchError,
  type WorkbenchSession,
} from '../src/workbench/runtime'

describe('workbench runtime', () => {
  test.each(['darwin', 'win32'] as const)(
    'routes hostile %s configuration variables privately',
    (platform) => {
      const home = platform === 'darwin' ? '/tmp/workbench/home' : 'C:\\Temp\\workbench\\home'
      const env = routeWorkbenchEnvironment(
        {
          ZDOTDIR: '/host/zsh',
          XDG_DATA_HOME: '/host/data',
          XDG_CACHE_HOME: '/host/cache',
          XDG_STATE_HOME: '/host/state',
          OPENCODE_CONFIG: '/host/opencode.json',
          OPENCODE_CONFIG_CONTENT: '{"host":true}',
          TMUX: '/host/tmux.sock',
          BASH_ENV: '/host/startup',
          API_TOKEN: 'keep-host-auth',
          ...(platform === 'win32'
            ? { xdg_config_home: 'C:\\host', opencode_config: 'C:\\host.json' }
            : {}),
        },
        platform,
        home,
      )
      for (const key of [
        'ZDOTDIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'BASH_ENV',
      ]) {
        expect(env[key]?.startsWith(home)).toBe(true)
      }
      expect(env.OPENCODE_CONFIG).toBeUndefined()
      expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined()
      expect(env.TMUX).toBeUndefined()
      expect(env.API_TOKEN).toBe('keep-host-auth')
      expect(env.xdg_config_home).toBeUndefined()
      expect(env.opencode_config).toBeUndefined()
    },
  )

  test.each(['darwin', 'win32'] as const)(
    'applies projected terminal settings and observes natural %s exit',
    async (platform) => {
      const paths = platform === 'win32' ? path.win32 : path.posix
      const root = platform === 'win32' ? 'C:\\Temp\\settings' : '/tmp/settings'
      const files = new Map([
        [
          paths.join(root, 'terminal-settings.json'),
          JSON.stringify({
            keybindings: { 'split-horizontal': 'ctrl+alt+h' },
            layout: { columns: '120', rows: '40' },
          }),
        ],
      ])
      const commands: RuntimeCommand[] = []
      let running = true
      let observed = 0
      const runtime = createWorkbenchRuntime({
        platform,
        environment: platform === 'win32' ? { USERPROFILE: 'C:\\Users\\test' } : {},
        dependencies: {
          files: {
            mkdir: () => {},
            write: (name, value) => {
              files.set(name, value)
            },
            read: (name) => files.get(name) ?? null,
            remove: () => {
              files.clear()
            },
          },
          start: async (command) => {
            commands.push(command)
            return 12
          },
          processIdentity: async () => (running ? 'original' : null),
          exec: async (command) => {
            commands.push(command)
            return command.args.includes('list-sessions') && !running
              ? { exitCode: 1, stdout: '', stderr: 'no server running' }
              : { exitCode: 0, stdout: '', stderr: '' }
          },
          sleep: async () => {
            observed++
            running = false
          },
        },
      })
      const session = await runtime.launch({
        id: 'settings',
        root,
        cwd: root,
        executables: { tmux: '/bin/tmux', wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
      })
      const config = files.get(session.configPath) ?? ''
      if (platform === 'darwin') {
        expect(config).toContain('bind-key -n "C-M-h" split-window -h')
        expect(commands[0]?.args).toContain('120')
      } else {
        expect(config).toContain('config.initial_cols = 120')
        expect(config).toContain('config.initial_rows = 40')
        expect(config).toContain('mods = "CTRL|ALT"')
        expect(config).toContain('wezterm.action.SplitHorizontal')
      }
      await runtime.attach(session)
      expect(observed).toBe(1)
      expect((await runtime.inspect(session)).state).toBe('stopped')
      await runtime.close(session)
      expect(files.size).toBe(0)
    },
  )
  test.each(['darwin', 'win32'] as const)(
    'passes ephemeral secrets to the %s child without persisting them',
    async (platform) => {
      const files = new Map<string, string>()
      const children: RuntimeCommand[] = []
      const runtime = createWorkbenchRuntime({
        platform,
        environment: {
          PATH: '/host/bin',
          HOST_TOKEN: 'inherited',
          ...(platform === 'win32' ? { USERPROFILE: 'C:\\Users\\test' } : {}),
        },
        dependencies: {
          files: {
            mkdir: () => {},
            write: (name, value) => {
              files.set(name, value)
            },
            read: (name) => files.get(name) ?? null,
            remove: () => {},
          },
          exec: async (command) => {
            children.push(command)
            return { exitCode: 0, stdout: '', stderr: '' }
          },
          start: async (command) => {
            children.push(command)
            return 4242
          },
          processIdentity: async () => 'identity',
        },
      })
      const root = platform === 'win32' ? 'C:\\Temp\\secret-overlay' : '/tmp/secret-overlay'
      const session = await runtime.launch({
        id: 'secret-overlay',
        root,
        cwd: root,
        environment: { MCP_API_KEY: 'decrypted-mcp-secret', HOME: '/untrusted-home' },
        executables: { tmux: '/bin/tmux', wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
      })
      expect(children[0]?.environment).toMatchObject({
        MCP_API_KEY: 'decrypted-mcp-secret',
        HOST_TOKEN: 'inherited',
        HOME: session.home,
      })
      expect(JSON.stringify(session)).not.toContain('decrypted-mcp-secret')
      for (const content of files.values()) expect(content).not.toContain('decrypted-mcp-secret')
    },
  )

  test('rejects normalized drive roots before creating any Windows runtime files', async () => {
    const writes: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: (name) => {
            writes.push(name)
          },
          write: (name) => {
            writes.push(name)
          },
          read: () => null,
          remove: () => {},
        },
        start: async () => 4242,
        processIdentity: async () => 'identity',
      },
    })
    await expect(
      runtime.launch({
        id: 'unsafe-root',
        root: 'C:\\Temp\\..\\',
        cwd: 'C:\\project',
        executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
      }),
    ).rejects.toThrow('private directory')
    expect(writes).toEqual([])
  })

  test('stops a new Windows process when its identity cannot be recorded', async () => {
    const stopped: number[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: { mkdir: () => {}, write: () => {}, read: () => null, remove: () => {} },
        start: async () => 4242,
        processIdentity: async () => {
          throw new Error('process inspection failed')
        },
        terminate: async (pid) => {
          stopped.push(pid)
        },
      },
    })
    await expect(
      runtime.launch({
        id: 'failed-launch',
        root: 'C:\\Temp\\failed-launch',
        cwd: 'C:\\project',
        executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
      }),
    ).rejects.toThrow('process inspection failed')
    expect(stopped).toEqual([4242])
  })

  test('cleans host artifacts without terminating a Windows process that already exited during launch', async () => {
    const removed: string[] = []
    let terminationAttempted = false
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: () => {},
          read: () => null,
          remove: () => {},
          removeFile: (name) => removed.push(name),
        },
        start: async () => 4242,
        processIdentity: async () => null,
        terminate: async () => {
          terminationAttempted = true
          throw new Error('No process found for the given PID.')
        },
      },
    })

    let launchError: unknown
    try {
      await runtime.launch({
        id: 'exited-launch',
        root: 'C:\\Temp\\exited-launch',
        cwd: 'C:\\project',
        executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
      })
    } catch (error) {
      launchError = error
    }
    expect(launchError).toBeInstanceOf(Error)
    expect((launchError as Error).message).toBe(
      'WezTerm exited before its process could be recorded.',
    )
    expect(launchError).not.toBeInstanceOf(WorkbenchLaunchError)
    expect(terminationAttempted).toBe(false)
    expect(removed).toEqual([
      'C:\\Users\\test\\.local\\share\\wezterm\\gui-sock-4242',
      'C:\\Users\\test\\.local\\share\\wezterm\\laurencio-terminal.exe-log-4242.txt',
    ])
  })

  test('persists failed-launch rollback metadata so a later reaper retries artifact cleanup', async () => {
    const files = new Map<string, string>()
    const root = 'C:\\Temp\\failed-artifact-cleanup'
    const record = `${root}\\runtime-session.json`
    let blocked = true
    const removed: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: (name) => {
            removed.push(name)
            files.clear()
          },
          copy: () => {},
          exists: (name) => name === root && files.size > 0,
          removeFile: (name) => {
            if (blocked) throw new Error('file is busy')
            removed.push(name)
          },
          removeEmptyDirectory: () => {},
        },
        start: async () => 4242,
        processIdentity: async () => null,
      },
    })
    await expect(
      runtime.launch({
        id: 'rollback',
        root,
        cwd: 'C:\\project',
        executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
      }),
    ).rejects.toBeInstanceOf(WorkbenchLaunchError)
    const saved = files.get(record)
    expect(saved).toBeDefined()
    const persisted = JSON.parse(saved ?? '{}') as WorkbenchSession
    expect(persisted.process).toEqual({ pid: 4242, identity: 'stopped' })
    expect(persisted.windowsHostArtifacts?.socketPath).toEndWith('gui-sock-4242')
    expect(removed).toEqual([])
    blocked = false
    expect(await runtime.reap([persisted])).toEqual(['rollback'])
    expect(removed).toContain(root)
    expect(files.size).toBe(0)
  })

  test('retains Windows private files when process inspection fails', async () => {
    let unavailable = false
    const files = new Map<string, string>()
    const removed: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, value) => {
            files.set(name, value)
          },
          read: (name) => files.get(name) ?? null,
          remove: (name) => {
            removed.push(name)
          },
        },
        start: async () => 4242,
        exec: async () =>
          unavailable
            ? { exitCode: 1, stdout: '', stderr: 'Access denied' }
            : { exitCode: 0, stdout: '123456', stderr: '' },
      },
    })
    const session = await runtime.launch({
      id: 'unknown',
      root: 'C:\\Temp\\unknown',
      cwd: 'C:\\project',
      executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
    })
    unavailable = true
    expect((await runtime.inspect(session)).state).toBe('unknown')
    expect(await runtime.reap([session])).toEqual([])
    expect(removed).toEqual([])
  })

  test('reaps Windows private files when the recorded process no longer exists', async () => {
    let running = true
    const files = new Map<string, string>()
    const removed: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, value) => {
            files.set(name, value)
          },
          read: (name) => files.get(name) ?? null,
          remove: (name) => {
            removed.push(name)
            files.clear()
          },
        },
        start: async () => 4242,
        exec: async (command) => {
          if (running) return { exitCode: 0, stdout: '123456', stderr: '' }

          const script = command.args.at(-1) ?? ''
          return /NoProcessFoundForGivenId/.test(script)
            ? { exitCode: 0, stdout: '', stderr: '' }
            : { exitCode: 1, stdout: '', stderr: '' }
        },
      },
    })
    const session = await runtime.launch({
      id: 'exited',
      root: 'C:\\Temp\\exited',
      cwd: 'C:\\project',
      executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
    })

    running = false
    expect(await runtime.reap([session])).toEqual(['exited'])
    expect(removed).toEqual(['C:\\Temp\\exited'])
  })

  test.skipIf(process.platform !== 'darwin' || !Bun.which('tmux'))(
    'runs and closes a real private tmux server',
    async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lwb-'))
      fs.mkdirSync(path.join(root, 'home'), { mode: 0o700 })
      fs.writeFileSync(path.join(root, 'home', '.tmux.conf'), 'set -g history-limit 4321\n')
      fs.writeFileSync(
        path.join(root, 'terminal-settings.json'),
        JSON.stringify({
          keybindings: { 'split-horizontal': 'ctrl+alt+h' },
          layout: { columns: '120', rows: '40' },
        }),
      )
      const runtime = createWorkbenchRuntime()
      const session = await runtime.launch({
        id: 'real-tmux',
        root,
        cwd: process.cwd(),
        executables: { tmux: Bun.which('tmux') ?? '/opt/homebrew/bin/tmux', shell: '/bin/sh' },
      })
      try {
        expect((await runtime.inspect(session)).state).toBe('running')
        expect(fs.statSync(session.home).mode & 0o777).toBe(0o700)
        const native = Bun.spawnSync([
          session.executable,
          '-S',
          session.socketPath,
          'show-options',
          '-g',
          'history-limit',
        ])
        expect(native.stdout.toString()).toBe('history-limit 4321\n')
        const binding = Bun.spawnSync([
          session.executable,
          '-S',
          session.socketPath,
          'list-keys',
          '-T',
          'root',
        ])
        expect(binding.exitCode).toBe(0)
        expect(binding.stdout.toString()).toMatch(/(?:C-M|M-C)-h\s+split-window -h/)
      } finally {
        await runtime.close(session)
      }
      expect(fs.existsSync(root)).toBe(false)
    },
  )

  test('closes the recorded Windows process tree before removing its private home', async () => {
    let identity: string | null = 'original-process'
    const files = new Map<string, string>()
    const events: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, text) => {
            files.set(name, text)
          },
          read: (name) => files.get(name) ?? null,
          remove: () => {
            events.push('removed')
            files.clear()
          },
        },
        start: async () => 4242,
        processIdentity: async () => identity,
        terminate: async (pid) => {
          events.push(`terminated ${pid}`)
          identity = null
        },
      },
    })
    const session = await runtime.launch({
      id: 'close',
      root: 'C:\\Temp\\close',
      cwd: 'C:\\project',
      executables: { wezterm: 'wezterm-gui.exe', powershell: 'pwsh.exe' },
    })
    await runtime.close(session)
    await runtime.close(session)
    expect(events).toEqual(['terminated 4242', 'removed'])
  })

  test('preserves the ownership marker when private-root deletion fails and retries safely', async () => {
    const root = 'C:\\Temp\\partial-close'
    const marker = `${root}\\runtime-session.json`
    const files = new Map<string, string>()
    let rootExists = true
    let identity: string | null = 'original-process'
    let attempts = 0
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: () => {},
          copy: () => {},
          exists: (name) => (name === root ? rootExists : false),
          removeFile: () => {},
          removeEmptyDirectory: () => {},
          removeOwnedRoot: (_root, ownershipMarker) => {
            attempts++
            if (attempts === 1) {
              for (const name of [...files.keys()]) {
                if (name !== ownershipMarker) files.delete(name)
              }
              throw Object.assign(new Error('file is in use'), { code: 'EACCES' })
            }
            files.delete(ownershipMarker)
            rootExists = false
          },
        },
        start: async () => 4242,
        processIdentity: async () => identity,
        terminate: async () => {
          identity = null
        },
      },
    })
    const session = await runtime.launch({
      id: 'partial-close',
      root,
      cwd: 'C:\\project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
    })

    await expect(runtime.close(session)).rejects.toThrow('file is in use')
    expect(files.get(marker)).toBe(JSON.stringify(session))
    await runtime.close(session)
    expect(attempts).toBe(2)
    expect(rootExists).toBe(false)
  })

  test('does not accept a missing ownership marker while the private root remains', async () => {
    const root = 'C:\\Temp\\missing-marker'
    const files = new Map<string, string>()
    let rootExists = true
    const removals: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\test' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: (name) => removals.push(name),
          copy: () => {},
          exists: (name) => (name === root ? rootExists : false),
          removeFile: (name) => removals.push(name),
          removeEmptyDirectory: (name) => removals.push(name),
          removeOwnedRoot: (name) => {
            removals.push(name)
            rootExists = false
          },
        },
        start: async () => 4242,
        processIdentity: async () => 'original-process',
      },
    })
    const session = await runtime.launch({
      id: 'missing-marker',
      root,
      cwd: 'C:\\project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
    })
    files.delete(`${root}\\runtime-session.json`)

    await expect(runtime.close(session)).rejects.toThrow('ownership marker is missing')
    expect(removals).toEqual([])
    expect(rootExists).toBe(true)
  })

  test('retains a detached tmux server and reaps its private root only after the server exits', async () => {
    let running = true
    const removed: string[] = []
    const files = new Map<string, string>()
    const runtime = createWorkbenchRuntime({
      platform: 'darwin',
      environment: {},
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, text) => {
            files.set(name, text)
          },
          read: (name) => files.get(name) ?? null,
          remove: (name) => {
            removed.push(name)
            files.clear()
          },
        },
        exec: async (command) => {
          if (command.args.includes('list-sessions') && !running) {
            return {
              exitCode: 1,
              stdout: '',
              stderr: 'no server running on /private/tmp/lifecycle/tmux.sock',
            }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })
    const session = await runtime.launch({
      id: 'lifecycle',
      root: '/private/tmp/lifecycle',
      cwd: '/project',
      executables: { tmux: '/bin/tmux' },
    })
    expect((await runtime.inspect(session)).state).toBe('running')
    expect(await runtime.reap([session])).toEqual([])
    expect(removed).toEqual([])
    running = false
    expect(await runtime.reap([session])).toEqual(['lifecycle'])
    expect(removed).toEqual(['/private/tmp/lifecycle'])
    await runtime.close(session)
    expect(removed).toHaveLength(1)
  })

  test('launches portable WezTerm and a profile-free PowerShell with private Windows config paths', async () => {
    const commands: RuntimeCommand[] = []
    const files = new Map<string, string>()
    const copies: Array<[string, string]> = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: {
        home: 'C:\\Users\\andy',
        USERPROFILE: 'C:\\Users\\andy',
        Path: 'C:\\bin',
        TOKEN: 'secret',
      },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => {
            files.set(name, content)
          },
          read: (name) => files.get(name) ?? null,
          remove: () => {},
          copy: (source, destination) => {
            copies.push([source, destination])
          },
          exists: () => false,
          removeFile: () => {},
          removeEmptyDirectory: () => {},
        },
        start: async (command) => {
          commands.push(command)
          return 4242
        },
        processIdentity: async () => '2026-09-20T01:00:00Z',
      },
    })
    const session = await runtime.launch({
      id: 'win-session',
      root: 'C:\\Temp\\workbench',
      cwd: 'D:\\my project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'C:\\tools\\pwsh.exe' },
    })

    expect(commands[0]).toMatchObject({
      executable: 'C:\\Temp\\workbench\\laurencio-terminal.exe',
      args: [
        '--config-file',
        'C:\\Temp\\workbench\\wezterm.lua',
        'start',
        '--always-new-process',
        '--cwd',
        'D:\\my project',
        '--',
        'C:\\tools\\pwsh.exe',
        '-NoProfile',
        '-NoExit',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        'C:\\Temp\\workbench\\bootstrap.ps1',
      ],
      cwd: 'D:\\my project',
      environment: {
        HOME: 'C:\\Temp\\workbench\\home',
        USERPROFILE: 'C:\\Temp\\workbench\\home',
        HOMEDRIVE: 'C:',
        HOMEPATH: '\\Temp\\workbench\\home',
        APPDATA: 'C:\\Temp\\workbench\\home\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Temp\\workbench\\home\\AppData\\Local',
        Path: 'C:\\bin',
        TOKEN: 'secret',
      },
    })
    expect(copies).toEqual([
      ['C:\\tools\\wezterm-gui.exe', 'C:\\Temp\\workbench\\laurencio-terminal.exe'],
    ])
    expect(commands[0]?.environment.home).toBeUndefined()
    expect(files.get(session.configPath)).toContain('default_prog')
    // The Windows GUI chooses its own mux socket; lifecycle checks use its PID identity.
    expect(files.get(session.configPath)).not.toContain('socket_path')
    expect(files.get('C:\\Temp\\workbench\\bootstrap.ps1')).toContain(
      "Set-Location -LiteralPath 'D:\\my project'",
    )
    expect(session.process).toEqual({ pid: 4242, identity: '2026-09-20T01:00:00Z' })
    expect(session.windowsHostArtifacts).toEqual({
      directory: 'C:\\Users\\andy\\.local\\share\\wezterm',
      directoryCreated: true,
      socketPath: 'C:\\Users\\andy\\.local\\share\\wezterm\\gui-sock-4242',
      logPath: 'C:\\Users\\andy\\.local\\share\\wezterm\\laurencio-terminal.exe-log-4242.txt',
    })
    expect(JSON.stringify(session)).not.toContain('secret')
  })

  test('removes only this Windows process artifacts and preserves a pre-existing host directory', async () => {
    let identity: string | null = 'original-process'
    const files = new Map<string, string>()
    const removedFiles: string[] = []
    const removedDirectories: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\andy' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: (name) => files.delete(name),
          copy: () => {},
          exists: (name) => name === 'C:\\Users\\andy\\.local\\share\\wezterm',
          removeFile: (name) => removedFiles.push(name),
          removeEmptyDirectory: (name) => removedDirectories.push(name),
        },
        start: async () => 4242,
        processIdentity: async () => identity,
        terminate: async () => {
          identity = null
        },
      },
    })
    const session = await runtime.launch({
      id: 'host-artifacts',
      root: 'C:\\Temp\\host-artifacts',
      cwd: 'C:\\project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
    })

    await runtime.close(session)

    expect(removedFiles).toEqual([
      'C:\\Users\\andy\\.local\\share\\wezterm\\gui-sock-4242',
      'C:\\Users\\andy\\.local\\share\\wezterm\\laurencio-terminal.exe-log-4242.txt',
    ])
    expect(removedDirectories).toEqual([])
  })

  test('reaping removes an empty Windows host runtime directory created by the session', async () => {
    let identity: string | null = 'original-process'
    const files = new Map<string, string>()
    const events: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\andy' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: (name) => {
            events.push(`root:${name}`)
            files.clear()
          },
          copy: () => {},
          exists: () => false,
          removeFile: (name) => events.push(`file:${name}`),
          removeEmptyDirectory: (name) => events.push(`directory:${name}`),
        },
        start: async () => 4242,
        processIdentity: async () => identity,
      },
    })
    const session = await runtime.launch({
      id: 'reap-host-artifacts',
      root: 'C:\\Temp\\reap-host-artifacts',
      cwd: 'C:\\project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
    })
    identity = null

    expect(await runtime.reap([session])).toEqual(['reap-host-artifacts'])
    expect(events).toEqual([
      'file:C:\\Users\\andy\\.local\\share\\wezterm\\gui-sock-4242',
      'file:C:\\Users\\andy\\.local\\share\\wezterm\\laurencio-terminal.exe-log-4242.txt',
      'directory:C:\\Users\\andy\\.local\\share\\wezterm',
      'root:C:\\Temp\\reap-host-artifacts',
    ])
  })

  test('refuses unsafe Windows host artifact metadata without deleting anything', async () => {
    let identity: string | null = 'original-process'
    const files = new Map<string, string>()
    const removals: string[] = []
    const runtime = createWorkbenchRuntime({
      platform: 'win32',
      environment: { USERPROFILE: 'C:\\Users\\andy' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => files.set(name, content),
          read: (name) => files.get(name) ?? null,
          remove: (name) => removals.push(name),
          copy: () => {},
          exists: () => true,
          removeFile: (name) => removals.push(name),
          removeEmptyDirectory: (name) => removals.push(name),
        },
        start: async () => 4242,
        processIdentity: async () => identity,
        terminate: async () => {
          identity = null
        },
      },
    })
    const session = await runtime.launch({
      id: 'unsafe-host-artifacts',
      root: 'C:\\Temp\\unsafe-host-artifacts',
      cwd: 'C:\\project',
      executables: { wezterm: 'C:\\tools\\wezterm-gui.exe', powershell: 'pwsh.exe' },
    })
    if (!session.windowsHostArtifacts) throw new Error('missing Windows artifact metadata')
    session.windowsHostArtifacts.socketPath = 'C:\\Users\\andy\\Documents\\important.txt'
    files.set('C:\\Temp\\unsafe-host-artifacts\\runtime-session.json', JSON.stringify(session))

    await expect(runtime.close(session)).rejects.toThrow('host artifact metadata')
    expect(removals).toEqual([])
  })

  test('launches a private tmux session with the host working directory and inherited credentials', async () => {
    const commands: RuntimeCommand[] = []
    const files = new Map<string, string>()
    const runtime = createWorkbenchRuntime({
      platform: 'darwin',
      environment: { HOME: '/Users/andy', PATH: '/usr/bin', API_TOKEN: 'host-token' },
      dependencies: {
        files: {
          mkdir: () => {},
          write: (name, content) => {
            files.set(name, content)
          },
          read: (name) => files.get(name) ?? null,
          remove: () => {},
        },
        exec: async (command) => {
          commands.push(command)
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
    })

    const session = await runtime.launch({
      id: 'test-session',
      root: '/private/tmp/workbench-test',
      cwd: '/Users/andy/project',
      executables: { tmux: '/opt/homebrew/bin/tmux', shell: '/bin/zsh' },
    })

    expect(commands[0]).toMatchObject({
      executable: '/opt/homebrew/bin/tmux',
      args: [
        '-f',
        '/private/tmp/workbench-test/tmux.conf',
        '-S',
        '/private/tmp/workbench-test/tmux.sock',
        'new-session',
        '-d',
        '-s',
        'test-session',
        '-c',
        '/Users/andy/project',
      ],
      cwd: '/Users/andy/project',
      environment: {
        HOME: '/private/tmp/workbench-test/home',
        XDG_CONFIG_HOME: '/private/tmp/workbench-test/home/.config',
        CODEX_HOME: '/private/tmp/workbench-test/home/.codex',
        CLAUDE_CONFIG_DIR: '/private/tmp/workbench-test/home/.claude',
        PATH: '/usr/bin',
        API_TOKEN: 'host-token',
      },
    })
    expect(files.get('/private/tmp/workbench-test/tmux.conf')).toContain('exit-empty on')
    expect(files.get('/private/tmp/workbench-test/tmux.conf')).toContain('destroy-unattached off')
    expect(JSON.stringify(session)).not.toContain('host-token')
    expect(session.home).toBe('/private/tmp/workbench-test/home')
  })
})
