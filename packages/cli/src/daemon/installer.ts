/**
 * Service installers: a launchd user agent on macOS, a systemd user unit on
 * Linux. File content generation is pure, so tests assert the exact plist and
 * unit text without touching the machine; install and uninstall take an
 * injected exec runner for the same reason.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Platform } from '@laurencio/core'

export const SERVICE_LABEL = 'com.laurencio.daemon'
export const SYSTEMD_UNIT_NAME = 'laurencio.service'

export interface ServiceSpec {
  home: string
  platform: Platform
  /** Absolute path of the program to launch: the binary, or bun when run from source. */
  program: string
  /** Arguments for the daemon run subcommand. */
  args: readonly string[]
  /** launchd target user id for `gui/<uid>`; ignored on Linux. */
  uid: number
  env?: Record<string, string>
}

export interface DaemonProgram {
  program: string
  args: string[]
}

/**
 * The command line a service should run. When the CLI runs under bun or node,
 * the service must launch the runtime plus the entry script; a compiled binary
 * launches itself.
 */
export function daemonProgram(invocation: {
  execPath: string
  main: string | null
}): DaemonProgram {
  const runtime = path.basename(invocation.execPath)
  const interpreted =
    runtime === 'bun' ||
    runtime === 'bun.exe' ||
    runtime === 'node' ||
    runtime === 'node.exe' ||
    runtime.startsWith('bun-')
  const args = ['daemon', 'run']
  if (interpreted && invocation.main !== null && invocation.main !== '') {
    return { program: invocation.execPath, args: [invocation.main, ...args] }
  }
  return { program: invocation.execPath, args }
}

export function launchAgentsDir(home: string): string {
  return path.join(home, 'Library', 'LaunchAgents')
}

export function systemdUserDir(home: string): string {
  return path.join(home, '.config', 'systemd', 'user')
}

export function serviceFilePath(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') {
    return path.join(launchAgentsDir(spec.home), `${SERVICE_LABEL}.plist`)
  }
  if (spec.platform === 'linux') {
    return path.join(systemdUserDir(spec.home), SYSTEMD_UNIT_NAME)
  }
  throw new Error('laurencio does not install a service on this platform')
}

/** stdout log file on macOS; null on Linux, where the unit logs to journald. */
export function logFilePath(spec: ServiceSpec): string | null {
  if (spec.platform !== 'darwin') return null
  return path.join(spec.home, 'Library', 'Logs', 'laurencio', 'daemon.log')
}

export function logHint(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') {
    const dir = path.join(spec.home, 'Library', 'Logs', 'laurencio')
    return `logs: ${dir}`
  }
  return `logs: journalctl --user -u ${SYSTEMD_UNIT_NAME}`
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function plistString(value: string, indent: string): string {
  return `${indent}<string>${xmlEscape(value)}</string>`
}

export function launchdPlist(spec: ServiceSpec): string {
  if (spec.platform !== 'darwin') throw new Error('launchdPlist only runs on macOS')
  const out = logFilePath(spec)
  const err = out === null ? null : `${out}.err`
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    plistString(SERVICE_LABEL, '  '),
    '  <key>ProgramArguments</key>',
    '  <array>',
    plistString(spec.program, '    '),
    ...spec.args.map((arg) => plistString(arg, '    ')),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ProcessType</key>',
    plistString('Background', '  '),
    '  <key>LowPriorityIO</key>',
    '  <true/>',
    ...(out === null ? [] : ['  <key>StandardOutPath</key>', plistString(out, '  ')]),
    ...(err === null ? [] : ['  <key>StandardErrorPath</key>', plistString(err, '  ')]),
    ...envEntries(spec.env),
    '</dict>',
    '</plist>',
    '',
  ]
  return lines.join('\n')
}

function envEntries(env: Record<string, string> | undefined): string[] {
  if (env === undefined || Object.keys(env).length === 0) return []
  const lines = ['  <key>EnvironmentVariables</key>', '  <dict>']
  for (const [key, value] of Object.entries(env)) {
    lines.push(`    <key>${xmlEscape(key)}</key>`)
    lines.push(plistString(value, '    '))
  }
  lines.push('  </dict>')
  return lines
}

/** systemd splits ExecStart on whitespace, so quote anything unusual. */
function systemdQuote(arg: string): string {
  if (arg !== '' && /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg
  return `"${arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

export function systemdUnit(spec: ServiceSpec): string {
  if (spec.platform !== 'linux') throw new Error('systemdUnit only runs on Linux')
  const execStart = [spec.program, ...spec.args].map(systemdQuote).join(' ')
  const envLines = Object.entries(spec.env ?? {}).map(
    ([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`,
  )
  return [
    '[Unit]',
    'Description=Laurencio config sync daemon',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    ...envLines,
    'StandardOutput=journal',
    'StandardError=journal',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

export function serviceFileContent(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') return launchdPlist(spec)
  if (spec.platform === 'linux') return systemdUnit(spec)
  throw new Error('laurencio does not install a service on this platform')
}

export interface ExecResult {
  status: number
  stdout: string
  stderr: string
}

export type ExecFn = (program: string, args: readonly string[]) => ExecResult

export function defaultExec(program: string, args: readonly string[]): ExecResult {
  const result = spawnSync(program, [...args], { encoding: 'utf8' })
  return {
    status: result.status ?? 1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
  }
}

export interface InstallerDeps {
  exec?: ExecFn
  log?: (line: string) => void
}

export interface InstallResult {
  path: string
  installed: boolean
  started: boolean
  alreadyInstalled: boolean
  notes: string[]
}

export interface UninstallResult {
  path: string
  removed: boolean
  stopped: boolean
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.tmp-${process.pid}`
  fs.writeFileSync(tempPath, content, { mode: 0o644 })
  fs.renameSync(tempPath, filePath)
}

function readFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

export function installService(spec: ServiceSpec, deps: InstallerDeps = {}): InstallResult {
  const exec = deps.exec ?? defaultExec
  const filePath = serviceFilePath(spec)
  const content = serviceFileContent(spec)
  const existing = readFileOrNull(filePath)
  const notes: string[] = []
  if (spec.platform === 'darwin') {
    const logFile = logFilePath(spec)
    if (logFile !== null) fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
  }
  if (existing === content) {
    const running =
      spec.platform === 'darwin'
        ? exec('launchctl', ['print', `gui/${spec.uid}/${SERVICE_LABEL}`]).status === 0
        : exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT_NAME]).status === 0
    if (running) {
      return { path: filePath, installed: true, started: true, alreadyInstalled: true, notes }
    }
  }
  writeFileAtomic(filePath, content)
  deps.log?.(`wrote ${filePath}`)
  let started = false
  if (spec.platform === 'darwin') {
    // Bootout first: bootstrap fails when the label is still loaded.
    exec('launchctl', ['bootout', `gui/${spec.uid}/${SERVICE_LABEL}`])
    const boot = exec('launchctl', ['bootstrap', `gui/${spec.uid}`, filePath])
    started = boot.status === 0
    if (!started) {
      notes.push(`launchctl bootstrap failed: ${(boot.stderr || boot.stdout).trim()}`)
    }
  } else {
    exec('systemctl', ['--user', 'daemon-reload'])
    const enable = exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT_NAME])
    started = enable.status === 0
    if (!started) {
      notes.push(`systemctl enable failed: ${(enable.stderr || enable.stdout).trim()}`)
    }
    notes.push('run `loginctl enable-linger $USER` to keep syncing after logout')
  }
  return { path: filePath, installed: true, started, alreadyInstalled: false, notes }
}

export function uninstallService(spec: ServiceSpec, deps: InstallerDeps = {}): UninstallResult {
  const exec = deps.exec ?? defaultExec
  const filePath = serviceFilePath(spec)
  let stopped = false
  if (spec.platform === 'darwin') {
    stopped = exec('launchctl', ['bootout', `gui/${spec.uid}/${SERVICE_LABEL}`]).status === 0
  } else {
    stopped = exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT_NAME]).status === 0
  }
  const removed = fs.existsSync(filePath)
  fs.rmSync(filePath, { force: true })
  if (removed) deps.log?.(`removed ${filePath}`)
  if (spec.platform === 'linux') exec('systemctl', ['--user', 'daemon-reload'])
  return { path: filePath, removed, stopped }
}

export interface ServiceStatus {
  installed: boolean
  path: string
  logPath: string | null
  logHint: string
}

export function serviceStatus(spec: ServiceSpec): ServiceStatus {
  const filePath = serviceFilePath(spec)
  const logPath = logFilePath(spec)
  return {
    installed: fs.existsSync(filePath),
    path: filePath,
    logPath,
    logHint: logHint(spec),
  }
}
