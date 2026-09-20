import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export interface RuntimeCommand {
  executable: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
  interactive?: boolean
}

export interface RuntimeFiles {
  mkdir(name: string): void
  write(name: string, content: string): void
  read(name: string): string | null
  remove(name: string): void
  copy?(source: string, destination: string): void
  exists?(name: string): boolean
  removeFile?(name: string): void
  removeEmptyDirectory?(name: string): void
  removeOwnedRoot?(root: string, ownershipMarker: string): void
}

export interface RuntimeDependencies {
  files: RuntimeFiles
  exec(command: RuntimeCommand): Promise<{ exitCode: number; stdout: string; stderr: string }>
  start(command: RuntimeCommand): Promise<number>
  processIdentity(pid: number, powershell?: string): Promise<string | null>
  terminate(pid: number): Promise<void>
  sleep(milliseconds: number): Promise<void>
}

/** Keep native config, caches, login state and shell startup inside the private home. */
export function routeWorkbenchEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: 'darwin' | 'win32',
  home: string,
): NodeJS.ProcessEnv {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const overrides: NodeJS.ProcessEnv = {
    HOME: home,
    ZDOTDIR: home,
    XDG_CONFIG_HOME: paths.join(home, '.config'),
    XDG_DATA_HOME: paths.join(home, '.local', 'share'),
    XDG_CACHE_HOME: paths.join(home, '.cache'),
    XDG_STATE_HOME: paths.join(home, '.local', 'state'),
    XDG_RUNTIME_DIR: paths.join(home, '.run'),
    CODEX_HOME: paths.join(home, '.codex'),
    CLAUDE_CONFIG_DIR: paths.join(home, '.claude'),
    OPENCODE_CONFIG_DIR: paths.join(home, '.config', 'opencode'),
    BASH_ENV: paths.join(home, '.bashrc'),
    ENV: paths.join(home, '.shrc'),
    HISTFILE: paths.join(home, '.shell_history'),
    // Explicit host config and inherited mux connections bypass the private defaults.
    OPENCODE_CONFIG: undefined,
    OPENCODE_CONFIG_CONTENT: undefined,
    WEZTERM_CONFIG_FILE: undefined,
    WEZTERM_CONFIG_DIR: undefined,
    WEZTERM_UNIX_SOCKET: undefined,
    WEZTERM_PANE: undefined,
    TMUX: undefined,
    TMUX_PANE: undefined,
  }
  if (platform === 'win32')
    Object.assign(overrides, {
      USERPROFILE: home,
      HOMEDRIVE: paths.parse(home).root.replace(/\\$/, ''),
      HOMEPATH: home.slice(paths.parse(home).root.replace(/\\$/, '').length),
      APPDATA: paths.join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: paths.join(home, 'AppData', 'Local'),
    })
  const result = { ...environment }
  for (const key of Object.keys(result)) {
    if ((platform === 'win32' ? key.toUpperCase() : key) in overrides) delete result[key]
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) result[key] = value
  }
  return result
}

export interface TerminalSettings {
  keybindings: Record<string, string>
  layout: Record<string, string>
}

const terminalActions: Record<string, { tmux: string; wezterm: string }> = {
  'split-horizontal': {
    tmux: 'split-window -h',
    wezterm: 'SplitHorizontal { domain = "CurrentPaneDomain" }',
  },
  'split-vertical': {
    tmux: 'split-window -v',
    wezterm: 'SplitVertical { domain = "CurrentPaneDomain" }',
  },
  'new-tab': { tmux: 'new-window', wezterm: 'SpawnTab "CurrentPaneDomain"' },
  'close-pane': { tmux: 'kill-pane', wezterm: 'CloseCurrentPane { confirm = true }' },
  'next-pane': { tmux: 'select-pane -t :.+', wezterm: 'ActivatePaneDirection "Next"' },
  'previous-pane': { tmux: 'select-pane -t :.-', wezterm: 'ActivatePaneDirection "Prev"' },
  'zoom-pane': { tmux: 'resize-pane -Z', wezterm: 'TogglePaneZoomState' },
  palette: { tmux: 'command-prompt', wezterm: 'ActivateCommandPalette' },
  accept: { tmux: 'send-keys Enter', wezterm: 'SendKey { key = "Enter" }' },
}

export function terminalSettings(raw: string | null): TerminalSettings {
  if (raw === null) return { keybindings: {}, layout: {} }
  const parsed = JSON.parse(raw) as TerminalSettings
  for (const section of [parsed.keybindings, parsed.layout]) {
    if (
      !section ||
      typeof section !== 'object' ||
      Array.isArray(section) ||
      Object.values(section).some((value) => typeof value !== 'string')
    ) {
      throw new Error('Invalid materialized terminal settings.')
    }
  }
  for (const action of Object.keys(parsed.keybindings)) {
    if (!Object.hasOwn(terminalActions, action))
      throw new Error(`Unsupported terminal action: ${action}`)
  }
  for (const [name, value] of Object.entries(parsed.layout)) {
    if (!['columns', 'rows'].includes(name) || !/^[1-9][0-9]{0,3}$/.test(value)) {
      throw new Error(`Unsupported terminal layout setting: ${name}`)
    }
  }
  return parsed
}

function terminalKey(value: string): { tmux: string; key: string; modifiers: string } {
  const parts = value.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const names: Record<string, string> = {
    enter: 'Enter',
    space: 'Space',
    tab: 'Tab',
    escape: 'Escape',
    left: 'Left',
    right: 'Right',
    up: 'Up',
    down: 'Down',
  }
  if (!/^[a-z0-9]$/.test(key) && !/^f(?:[1-9]|1[0-2])$/.test(key) && !(key in names)) {
    throw new Error(`Unsupported terminal key: ${value}`)
  }
  const modifiers = parts.map((part) => {
    const modifier = { ctrl: 'CTRL', mod: 'CTRL', alt: 'ALT', shift: 'SHIFT' }[part]
    if (!modifier) throw new Error(`Unsupported terminal modifier: ${part}`)
    return modifier
  })
  const nativeKey = names[key] ?? (/^f\d+$/.test(key) ? key.toUpperCase() : key)
  return {
    key: nativeKey,
    modifiers: modifiers.join('|') || 'NONE',
    tmux:
      modifiers.map((modifier) => ({ CTRL: 'C-', ALT: 'M-', SHIFT: 'S-' })[modifier]).join('') +
      nativeKey,
  }
}

/** Shared semantic mapping for temporary sessions and native full-mode config. */
export function terminalBindings(settings: TerminalSettings) {
  return Object.entries(settings.keybindings).map(([action, value]) => ({
    key: terminalKey(value),
    action: terminalActions[action] as { tmux: string; wezterm: string },
  }))
}

function portableTmuxKey(value: string): string | null {
  const unquoted = value.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2')
  const parts = unquoted.split('-')
  const key = parts.pop()?.toLowerCase() ?? ''
  const portableModifiers: Record<string, string> = { C: 'ctrl', M: 'alt', S: 'shift' }
  const modifiers: string[] = []
  for (const part of parts) {
    const modifier = portableModifiers[part]
    if (modifier === undefined) return null
    modifiers.push(modifier)
  }
  const chord = [...modifiers, key].join('+')
  try {
    terminalKey(chord)
    return chord
  } catch {
    return null
  }
}

/** Import the portable subset of an existing tmux config during first enrollment. */
export function importTmuxTerminalSettings(source: string): TerminalSettings {
  const keybindings: Record<string, string> = {}
  const layout: Record<string, string> = {}
  const actionByTmux = new Map(
    Object.entries(terminalActions).map(([name, implementation]) => [implementation.tmux, name]),
  )
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    const binding = /^(?:bind|bind-key)\s+-n\s+(\S+)\s+(.+)$/.exec(line)
    if (binding !== null) {
      const chord = portableTmuxKey(binding[1] ?? '')
      const action = actionByTmux.get(binding[2]?.trim() ?? '')
      if (chord !== null && action !== undefined) keybindings[action] = chord
      continue
    }
    const size = /^set(?:-option)?\s+-g\s+default-size\s+([1-9][0-9]{0,3})x([1-9][0-9]{0,3})$/.exec(
      line,
    )
    if (size !== null) {
      layout.columns = size[1] as string
      layout.rows = size[2] as string
    }
  }
  return { keybindings, layout }
}

export interface WorkbenchLaunch {
  id: string
  root: string
  cwd: string
  executables: { tmux?: string; wezterm?: string; powershell?: string; shell?: string }
  /** Child-only values, such as decrypted MCP credentials; never written to runtime files. */
  environment?: NodeJS.ProcessEnv
}

export interface WorkbenchSession {
  id: string
  root: string
  home: string
  cwd: string
  platform: 'darwin' | 'win32'
  executable: string
  configPath: string
  /** Active tmux socket on macOS; reserved metadata on Windows, where WezTerm selects its GUI socket. */
  socketPath: string
  powershell?: string
  process?: { pid: number; identity: string }
  windowsHostArtifacts?: WindowsHostArtifacts
}

export interface WindowsHostArtifacts {
  directory: string
  directoryCreated: boolean
  socketPath: string
  logPath: string
}

export interface WorkbenchRuntime {
  launch(options: WorkbenchLaunch): Promise<WorkbenchSession>
  attach(session: WorkbenchSession): Promise<void>
  inspect(session: WorkbenchSession): Promise<{ state: 'running' | 'stopped' | 'unknown' }>
  close(session: WorkbenchSession): Promise<void>
  reap(sessions: readonly WorkbenchSession[]): Promise<string[]>
}

/** A launch failed after starting a process whose shutdown could not be confirmed. */
export class WorkbenchLaunchError extends Error {
  readonly retainRoot = true
}

const systemFiles: RuntimeFiles = {
  mkdir: (name) => {
    fs.mkdirSync(name, { recursive: true, mode: 0o700 })
  },
  write: (name, content) => fs.writeFileSync(name, content, { mode: 0o600 }),
  read: (name) => {
    try {
      return fs.readFileSync(name, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  },
  remove: (name) => fs.rmSync(name, { recursive: true, force: true }),
  copy: (source, destination) => fs.copyFileSync(source, destination),
  exists: (name) => fs.existsSync(name),
  removeFile: (name) => fs.rmSync(name, { force: true }),
  removeEmptyDirectory: (name) => {
    try {
      fs.rmdirSync(name)
    } catch (error) {
      if (
        !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
      ) {
        throw error
      }
    }
  },
  removeOwnedRoot: (root, ownershipMarker) => {
    for (const name of fs.readdirSync(root)) {
      const candidate = path.join(root, name)
      if (candidate === ownershipMarker) continue
      fs.rmSync(candidate, { recursive: true, force: true })
    }
    fs.rmSync(ownershipMarker, { force: true })
    fs.rmdirSync(root)
  },
}

const systemExec: RuntimeDependencies['exec'] = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.environment,
      stdio: command.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? 1, stdout, stderr }))
  })

const systemStart: RuntimeDependencies['start'] = (command) =>
  new Promise((resolve, reject) => {
    const child = spawn(command.executable, command.args, {
      cwd: command.cwd,
      env: command.environment,
      detached: true,
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('spawn', () => {
      child.unref()
      if (child.pid === undefined) reject(new Error('Workbench process did not start.'))
      else resolve(child.pid)
    })
  })

function powerShellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function luaQuote(value: string): string {
  return JSON.stringify(value)
}

export function tmuxQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`
}

const WINDOWS_TERMINAL_NAME = 'laurencio-terminal.exe'

function windowsEnvironmentValue(environment: NodeJS.ProcessEnv, name: string): string | null {
  const entry = Object.entries(environment).find(([key]) => key.toUpperCase() === name)
  return entry?.[1] ?? null
}

function windowsHostRuntimeDirectory(environment: NodeJS.ProcessEnv): string {
  const profile = windowsEnvironmentValue(environment, 'USERPROFILE')
  if (!profile) throw new Error('The Windows host profile could not be resolved.')
  const normalized = path.win32.normalize(profile)
  if (!path.win32.isAbsolute(normalized) || path.win32.parse(normalized).root === normalized) {
    throw new Error('The Windows host profile is unsafe.')
  }
  return path.win32.join(normalized, '.local', 'share', 'wezterm')
}

function sameWindowsPath(left: string, right: string): boolean {
  return path.win32.normalize(left).toLowerCase() === path.win32.normalize(right).toLowerCase()
}

/** Validate every path before deleting WezTerm files outside the private workbench root. */
export function hasSafeWindowsHostArtifacts(
  session: WorkbenchSession,
  expectedDirectory?: string,
): boolean {
  const artifacts = session.windowsHostArtifacts
  const process = session.process
  if (session.platform !== 'win32' || artifacts === undefined || process === undefined) return false
  if (!Number.isSafeInteger(process.pid) || process.pid < 1) return false
  if (
    typeof artifacts.directory !== 'string' ||
    typeof artifacts.directoryCreated !== 'boolean' ||
    typeof artifacts.socketPath !== 'string' ||
    typeof artifacts.logPath !== 'string'
  )
    return false
  const root = path.win32.normalize(session.root)
  if (!path.win32.isAbsolute(root) || path.win32.parse(root).root === root) return false
  const directory = path.win32.normalize(artifacts.directory)
  if (!path.win32.isAbsolute(directory) || path.win32.parse(directory).root === directory)
    return false
  if (expectedDirectory && !sameWindowsPath(directory, expectedDirectory)) return false
  if (
    path.win32.basename(directory).toLowerCase() !== 'wezterm' ||
    path.win32.basename(path.win32.dirname(directory)).toLowerCase() !== 'share' ||
    path.win32.basename(path.win32.dirname(path.win32.dirname(directory))).toLowerCase() !==
      '.local'
  )
    return false
  if (!path.win32.isAbsolute(session.executable)) return false
  if (
    !sameWindowsPath(path.win32.dirname(session.executable), root) ||
    path.win32.basename(session.executable).toLowerCase() !== WINDOWS_TERMINAL_NAME
  )
    return false
  return (
    sameWindowsPath(artifacts.socketPath, path.win32.join(directory, `gui-sock-${process.pid}`)) &&
    sameWindowsPath(
      artifacts.logPath,
      path.win32.join(directory, `${WINDOWS_TERMINAL_NAME}-log-${process.pid}.txt`),
    )
  )
}

export function createWorkbenchRuntime(
  options: {
    platform?: NodeJS.Platform
    environment?: NodeJS.ProcessEnv
    dependencies?: Partial<RuntimeDependencies>
  } = {},
): WorkbenchRuntime {
  const platform = options.platform ?? process.platform
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`Workbenches are not supported on ${platform}.`)
  }
  const environment = options.environment ?? process.env
  const files = options.dependencies?.files ?? systemFiles
  const copyFile =
    files.copy ??
    ((source: string, destination: string) => files.write(destination, files.read(source) ?? ''))
  const pathExists = files.exists ?? ((name: string) => files.read(name) !== null)
  const removeFile = files.removeFile ?? (() => {})
  const removeEmptyDirectory = files.removeEmptyDirectory ?? (() => {})
  const removeOwnedRoot = files.removeOwnedRoot ?? ((root: string) => files.remove(root))
  const exec = options.dependencies?.exec ?? systemExec
  const start = options.dependencies?.start ?? systemStart
  const sleep =
    options.dependencies?.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)))
  const processIdentity =
    options.dependencies?.processIdentity ??
    (async (pid: number, powershell?: string) => {
      const result = await exec({
        executable: powershell ?? '/bin/ps',
        args: powershell
          ? [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              [
                'try {',
                `$p = Get-Process -Id ${pid} -ErrorAction Stop`,
                '} catch {',
                "if ($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*') { exit 0 }",
                'throw',
                '}',
                '$p.StartTime.ToUniversalTime().Ticks',
              ].join('\n'),
            ]
          : ['-p', String(pid), '-o', 'lstart='],
        cwd: process.cwd(),
        environment,
      })
      if (result.exitCode !== 0) throw new Error('Could not inspect the workbench process.')
      return result.stdout.trim() || null
    })
  const terminate =
    options.dependencies?.terminate ??
    (async (pid: number) => {
      const result = await exec({
        executable: 'taskkill.exe',
        args: ['/PID', String(pid), '/T', '/F'],
        cwd: process.cwd(),
        environment,
      })
      if (result.exitCode !== 0) throw new Error('Could not stop the workbench process tree.')
    })
  const paths = platform === 'win32' ? path.win32 : path.posix

  const cleanupWindowsHostArtifacts = (session: WorkbenchSession): void => {
    if (session.platform !== 'win32' || session.windowsHostArtifacts === undefined) return
    if (!hasSafeWindowsHostArtifacts(session, windowsHostRuntimeDirectory(environment))) {
      throw new Error('Windows host artifact metadata is unsafe.')
    }
    removeFile(session.windowsHostArtifacts.socketPath)
    removeFile(session.windowsHostArtifacts.logPath)
    if (session.windowsHostArtifacts.directoryCreated) {
      removeEmptyDirectory(session.windowsHostArtifacts.directory)
    }
  }

  const recordPath = (session: WorkbenchSession) => paths.join(session.root, 'runtime-session.json')
  const ownership = (session: WorkbenchSession): 'owned' | 'absent' | 'unverified' => {
    const record = files.read(recordPath(session))
    if (record === null) return pathExists(session.root) ? 'unverified' : 'absent'
    if (record !== JSON.stringify(session))
      throw new Error('Workbench runtime ownership does not match.')
    return 'owned'
  }
  const tmuxCommand = (session: WorkbenchSession, args: string[]): RuntimeCommand => ({
    executable: session.executable,
    args: ['-f', session.configPath, '-S', session.socketPath, ...args],
    cwd: session.root,
    environment,
  })

  const runtime: WorkbenchRuntime = {
    async launch(input) {
      if (!/^[a-zA-Z0-9_-]+$/.test(input.id)) throw new Error('Invalid workbench session ID.')
      const root = paths.normalize(input.root)
      if (!paths.isAbsolute(root) || paths.parse(root).root === root) {
        throw new Error('Workbench root must be an absolute private directory.')
      }
      const resolvedExecutable =
        platform === 'darwin' ? input.executables.tmux : input.executables.wezterm
      if (!resolvedExecutable)
        throw new Error(
          `A resolved ${platform === 'darwin' ? 'tmux' : 'WezTerm'} executable is required.`,
        )
      if (platform === 'win32' && !input.executables.powershell)
        throw new Error('A resolved PowerShell executable is required.')
      const home = paths.join(root, 'home')
      const configPath = paths.join(root, platform === 'darwin' ? 'tmux.conf' : 'wezterm.lua')
      const socketPath = paths.join(root, platform === 'darwin' ? 'tmux.sock' : 'wezterm.sock')
      if (files.read(paths.join(root, 'runtime-session.json')) !== null) {
        throw new Error('This workbench root already has a runtime.')
      }
      const executable =
        platform === 'win32' ? paths.join(root, WINDOWS_TERMINAL_NAME) : resolvedExecutable
      const env = routeWorkbenchEnvironment(
        { ...environment, ...input.environment },
        platform,
        home,
      )
      const settings = terminalSettings(files.read(paths.join(root, 'terminal-settings.json')))
      const bindings = terminalBindings(settings)
      for (const directory of [
        root,
        home,
        env.XDG_CONFIG_HOME,
        env.XDG_DATA_HOME,
        env.XDG_CACHE_HOME,
        env.XDG_STATE_HOME,
        env.XDG_RUNTIME_DIR,
        env.OPENCODE_CONFIG_DIR,
        env.CODEX_HOME,
        env.CLAUDE_CONFIG_DIR,
      ]) {
        if (directory) files.mkdir(directory)
      }
      // WezTerm scopes log retention by executable basename. A private name keeps it away from
      // the user's normal wezterm-gui logs and gives cleanup one deterministic file name.
      if (platform === 'win32') copyFile(resolvedExecutable, executable)
      const session: WorkbenchSession = {
        id: input.id,
        root,
        home,
        cwd: input.cwd,
        platform,
        executable,
        configPath,
        socketPath,
      }
      if (platform === 'win32') {
        files.mkdir(paths.join(home, 'AppData', 'Roaming'))
        files.mkdir(paths.join(home, 'AppData', 'Local'))
        const powershell = input.executables.powershell
        if (!powershell) throw new Error('A resolved PowerShell executable is required.')
        const bootstrap = paths.join(root, 'bootstrap.ps1')
        files.write(bootstrap, `Set-Location -LiteralPath ${powerShellQuote(input.cwd)}\n`)
        const program = [
          powershell,
          '-NoProfile',
          '-NoExit',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          bootstrap,
        ]
        const nativeConfig = [
          paths.join(home, '.wezterm.lua'),
          paths.join(home, '.config', 'wezterm', 'wezterm.lua'),
        ].find((candidate) => files.read(candidate) !== null)
        files.write(
          configPath,
          [
            'local wezterm = require "wezterm"',
            nativeConfig ? `local config = dofile(${luaQuote(nativeConfig)})` : 'local config = {}',
            `config.default_prog = { ${program.map(luaQuote).join(', ')} }`,
            `config.default_cwd = ${luaQuote(input.cwd)}`,
            'config.check_for_updates = false',
            'config.quit_when_all_windows_are_closed = true',
            ...(settings.layout.columns
              ? [`config.initial_cols = ${settings.layout.columns}`]
              : []),
            ...(settings.layout.rows ? [`config.initial_rows = ${settings.layout.rows}`] : []),
            ...(bindings.length
              ? [
                  'config.keys = config.keys or {}',
                  ...bindings.map(
                    ({ key, action }) =>
                      `table.insert(config.keys, { key = ${luaQuote(key.key)}, mods = ${luaQuote(key.modifiers)}, action = wezterm.action.${action.wezterm} })`,
                  ),
                ]
              : []),
            'return config',
            '',
          ].join('\n'),
        )
        session.powershell = powershell
        files.write(recordPath(session), JSON.stringify(session))
        const hostRuntimeDirectory = windowsHostRuntimeDirectory(environment)
        const hostRuntimeDirectoryExisted = pathExists(hostRuntimeDirectory)
        const pid = await start({
          executable,
          args: [
            '--config-file',
            configPath,
            'start',
            '--always-new-process',
            '--cwd',
            input.cwd,
            '--',
            ...program,
          ],
          cwd: input.cwd,
          environment: env,
        })
        const artifacts: WindowsHostArtifacts = {
          directory: hostRuntimeDirectory,
          directoryCreated: !hostRuntimeDirectoryExisted,
          socketPath: paths.join(hostRuntimeDirectory, `gui-sock-${pid}`),
          logPath: paths.join(hostRuntimeDirectory, `${WINDOWS_TERMINAL_NAME}-log-${pid}.txt`),
        }
        let processAlreadyExited = false
        try {
          const identity = await processIdentity(pid, powershell)
          if (!identity) {
            processAlreadyExited = true
            throw new Error('WezTerm exited before its process could be recorded.')
          }
          session.powershell = powershell
          session.process = { pid, identity }
          session.windowsHostArtifacts = artifacts
          files.write(recordPath(session), JSON.stringify(session))
        } catch (error) {
          try {
            if (!processAlreadyExited) await terminate(pid)
          } catch {
            throw new WorkbenchLaunchError(
              `Workbench launch failed and process ${pid} could not be stopped. Files remain at ${root}.`,
              { cause: error },
            )
          }
          session.process = { pid, identity: 'stopped' }
          session.windowsHostArtifacts = artifacts
          try {
            files.write(recordPath(session), JSON.stringify(session))
            cleanupWindowsHostArtifacts(session)
          } catch (cleanupError) {
            throw new WorkbenchLaunchError(
              `Workbench launch failed and its Windows host files could not be cleaned. Files remain at ${root}.`,
              { cause: cleanupError },
            )
          }
          throw error
        }
        return session
      }
      files.write(
        configPath,
        [
          ...[paths.join(home, '.tmux.conf'), paths.join(home, '.config', 'tmux', 'tmux.conf')]
            .filter((candidate) => files.read(candidate) !== null)
            .map((candidate) => `source-file ${tmuxQuote(candidate)}`),
          ...bindings.map(({ key, action }) => `bind-key -n ${tmuxQuote(key.tmux)} ${action.tmux}`),
          'set -g exit-empty on',
          'set -g destroy-unattached off',
          'set -g update-environment ""',
          `set -g default-shell ${tmuxQuote(input.executables.shell ?? '/bin/zsh')}`,
          '',
        ].join('\n'),
      )
      files.write(recordPath(session), JSON.stringify(session))
      const result = await exec({
        executable,
        args: [
          '-f',
          configPath,
          '-S',
          socketPath,
          'new-session',
          '-d',
          ...(settings.layout.columns ? ['-x', settings.layout.columns] : []),
          ...(settings.layout.rows ? ['-y', settings.layout.rows] : []),
          '-s',
          input.id,
          '-c',
          input.cwd,
        ],
        cwd: input.cwd,
        environment: env,
      })
      if (result.exitCode !== 0)
        throw new Error(`Could not launch workbench: ${result.stderr.trim()}`)
      try {
        files.write(recordPath(session), JSON.stringify(session))
      } catch (error) {
        try {
          const stopped = await exec(tmuxCommand(session, ['kill-server']))
          if (stopped.exitCode !== 0) throw new Error('tmux shutdown failed')
        } catch {
          throw new WorkbenchLaunchError(
            `Workbench launch failed and its tmux server could not be stopped. Files remain at ${root}.`,
            { cause: error },
          )
        }
        throw error
      }
      return session
    },
    async attach(session) {
      if (ownership(session) !== 'owned') throw new Error('Workbench runtime no longer exists.')
      if (session.platform === 'darwin') {
        const result = await exec({
          ...tmuxCommand(session, ['attach-session', '-t', session.id]),
          interactive: true,
        })
        if (result.exitCode !== 0 && (await runtime.inspect(session)).state !== 'stopped') {
          throw new Error('Could not attach to the workbench session.')
        }
      }
      // Keep the launcher as lifetime owner after detach and while the Windows GUI runs.
      // A missing or reused process identity is stopped; inspection errors retain files.
      while (true) {
        const status = await runtime.inspect(session)
        if (status.state === 'stopped') return
        if (status.state === 'unknown')
          throw new Error('Workbench process state is unknown; its files were retained.')
        await sleep(500)
      }
    },
    async inspect(session) {
      const owner = ownership(session)
      if (owner === 'absent') return { state: 'stopped' }
      if (owner === 'unverified') return { state: 'unknown' }
      try {
        if (session.platform === 'win32') {
          if (!session.process) return { state: 'unknown' }
          const identity = await processIdentity(session.process.pid, session.powershell)
          return { state: identity === session.process.identity ? 'running' : 'stopped' }
        }
        const result = await exec(tmuxCommand(session, ['list-sessions']))
        if (result.exitCode === 0) return { state: 'running' }
        if (
          /no server running|no sessions|No such file or directory|Connection refused/i.test(
            result.stderr,
          )
        ) {
          return { state: 'stopped' }
        }
        return { state: 'unknown' }
      } catch {
        return { state: 'unknown' }
      }
    },
    async close(session) {
      const owner = ownership(session)
      if (owner === 'absent') return
      if (owner === 'unverified') {
        throw new Error(
          'Workbench ownership marker is missing while its private root still exists.',
        )
      }
      if (
        session.platform === 'win32' &&
        session.windowsHostArtifacts !== undefined &&
        !hasSafeWindowsHostArtifacts(session, windowsHostRuntimeDirectory(environment))
      ) {
        throw new Error('Windows host artifact metadata is unsafe.')
      }
      const status = await runtime.inspect(session)
      if (status.state === 'unknown')
        throw new Error('Workbench process state is unknown; its files were retained.')
      if (status.state === 'running') {
        if (session.platform === 'win32' && session.process) await terminate(session.process.pid)
        else await exec(tmuxCommand(session, ['kill-server']))
      }
      if ((await runtime.inspect(session)).state !== 'stopped') {
        throw new Error('The workbench is still running or its state is unknown.')
      }
      cleanupWindowsHostArtifacts(session)
      removeOwnedRoot(session.root, recordPath(session))
      if (pathExists(session.root)) {
        throw new Error('Workbench private root still exists after cleanup.')
      }
    },
    async reap(sessions) {
      const removed: string[] = []
      for (const session of sessions) {
        if (
          ownership(session) === 'owned' &&
          (await runtime.inspect(session)).state === 'stopped'
        ) {
          await runtime.close(session)
          removed.push(session.id)
        }
      }
      return removed
    },
  }
  return runtime
}
