/**
 * Per-user background sync through macOS launchd or Windows Task Scheduler.
 * Process execution is injected so installation is testable on either host.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Platform } from '@laurencio/core'

export const SERVICE_LABEL = 'com.laurencio.daemon'

export interface ServiceSpec {
  home: string
  platform: Platform
  /** Absolute path of the program to launch: the binary, or bun when run from source. */
  program: string
  /** Arguments for the daemon run subcommand. */
  args: readonly string[]
  /** launchd target user id for `gui/<uid>`; ignored on Windows. */
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
  const runtime = path.win32.basename(path.basename(invocation.execPath))
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

export function serviceFilePath(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') {
    return path.join(launchAgentsDir(spec.home), `${SERVICE_LABEL}.plist`)
  }
  if (spec.platform === 'win32') {
    return path.join(spec.home, '.laurencio', 'daemon.ps1')
  }
  throw new Error('Laurencio background sync supports macOS and Windows.')
}

export function logFilePath(spec: ServiceSpec): string | null {
  if (spec.platform === 'win32') return path.join(spec.home, '.laurencio', 'logs', 'daemon.log')
  if (spec.platform !== 'darwin') return null
  return path.join(spec.home, 'Library', 'Logs', 'laurencio', 'daemon.log')
}

export function logHint(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') {
    const dir = path.join(spec.home, 'Library', 'Logs', 'laurencio')
    return `logs: ${dir}`
  }
  const log = logFilePath(spec)
  return log === null ? '' : `logs: ${path.dirname(log)}`
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

function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function windowsDaemonScript(spec: ServiceSpec): string {
  if (spec.platform !== 'win32') throw new Error('windowsDaemonScript only runs on Windows')
  const log = logFilePath(spec) ?? ''
  return [
    "\uFEFF$ErrorActionPreference = 'Stop'",
    "$PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'",
    `Set-Location -LiteralPath ${psQuote(spec.home)}`,
    ...Object.entries(spec.env ?? {}).map(
      ([key, value]) =>
        `[Environment]::SetEnvironmentVariable(${psQuote(key)}, ${psQuote(value)}, 'Process')`,
    ),
    "$ErrorActionPreference = 'Continue'",
    `& ${[spec.program, ...spec.args].map(psQuote).join(' ')} *>> ${psQuote(log)}`,
    'if ($null -eq $LASTEXITCODE) { exit 1 }',
    'exit $LASTEXITCODE',
    '',
  ].join('\n')
}

function windowsTask(exec: ExecFn, action: string): ExecResult {
  return exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    [
      "$ErrorActionPreference = 'Stop'",
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
      '$user = $identity.Name',
      "$taskName = 'Laurencio Sync-' + $identity.User.Value",
      action,
    ].join('; '),
  ])
}

function registerWindowsTask(spec: ServiceSpec, exec: ExecFn): ExecResult {
  const script = serviceFilePath(spec)
  const args = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${script}"`
  return windowsTask(
    exec,
    [
      `$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ${psQuote(args)} -WorkingDirectory ${psQuote(spec.home)}`,
      '$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user',
      '$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
      '$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries',
      "Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Laurencio background sync' -Force | Out-Null",
      'Start-ScheduledTask -TaskName $taskName',
    ].join('; '),
  )
}

export function serviceFileContent(spec: ServiceSpec): string {
  if (spec.platform === 'darwin') return launchdPlist(spec)
  if (spec.platform === 'win32') return windowsDaemonScript(spec)
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

function launchdRunning(spec: ServiceSpec, exec: ExecFn): boolean {
  const result = exec('launchctl', ['print', `gui/${spec.uid}/${SERVICE_LABEL}`])
  // `print` succeeds for loaded jobs even after a successful exit. Only the
  // service's reported state makes an unchanged installation a no-op.
  const state = result.stdout.match(/^[\t ]*state\s*=\s*([^\r\n]*)/m)?.[1]?.trim()
  return result.status === 0 && state === 'running'
}

export function installService(spec: ServiceSpec, deps: InstallerDeps = {}): InstallResult {
  const exec = deps.exec ?? defaultExec
  const filePath = serviceFilePath(spec)
  const content = serviceFileContent(spec)
  const existing = readFileOrNull(filePath)
  const notes: string[] = []
  const logFile = logFilePath(spec)
  if (logFile !== null) fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 })
  if (existing === content) {
    const running =
      spec.platform === 'darwin'
        ? launchdRunning(spec, exec)
        : windowsTask(
            exec,
            "if ((Get-ScheduledTask -TaskName $taskName -ErrorAction Stop).State -ne 'Running') { exit 1 }",
          ).status === 0
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
    const enable = registerWindowsTask(spec, exec)
    started = enable.status === 0
    if (!started) {
      notes.push(`Task Scheduler registration failed: ${(enable.stderr || enable.stdout).trim()}`)
    }
    notes.push('Background sync runs while this Windows user is signed in.')
  }
  return {
    path: filePath,
    installed: spec.platform === 'win32' ? started : true,
    started,
    alreadyInstalled: false,
    notes,
  }
}

export function uninstallService(spec: ServiceSpec, deps: InstallerDeps = {}): UninstallResult {
  const exec = deps.exec ?? defaultExec
  const filePath = serviceFilePath(spec)
  let stopped = false
  if (spec.platform === 'darwin') {
    stopped = exec('launchctl', ['bootout', `gui/${spec.uid}/${SERVICE_LABEL}`]).status === 0
  } else {
    const result = windowsTask(
      exec,
      '$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue; if ($null -ne $task) { Stop-ScheduledTask -TaskName $taskName; Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }',
    )
    stopped = result.status === 0
    if (!stopped) return { path: filePath, removed: false, stopped: false }
  }
  const removed = fs.existsSync(filePath)
  fs.rmSync(filePath, { force: true })
  if (removed) deps.log?.(`removed ${filePath}`)
  return { path: filePath, removed, stopped }
}

export interface ServiceStatus {
  installed: boolean
  path: string
  logPath: string | null
  logHint: string
}

export function serviceStatus(spec: ServiceSpec, deps: InstallerDeps = {}): ServiceStatus {
  const filePath = serviceFilePath(spec)
  const logPath = logFilePath(spec)
  return {
    installed:
      fs.existsSync(filePath) &&
      (spec.platform !== 'win32' ||
        windowsTask(
          deps.exec ?? defaultExec,
          'Get-ScheduledTask -TaskName $taskName -ErrorAction Stop | Out-Null',
        ).status === 0),
    path: filePath,
    logPath,
    logHint: logHint(spec),
  }
}
