/**
 * Harness probes. This is the only place adapters learn install facts, and it
 * runs at the CLI edge: `<binary> --version` for each known binary, plus the
 * declared config-dir shapes. Results travel as `AdapterContext.probes`.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { HarnessId, HarnessProbe } from '@laurencio/core'

export interface ProbeResult {
  binary: string
  installed: boolean
  version: string | null
}

export type RunProbe = (binary: string, env: Record<string, string | undefined>) => ProbeResult

export interface ProbeOptions {
  home: string
  env: Record<string, string | undefined>
  run?: RunProbe
}

export function runVersionProbe(
  binary: string,
  env: Record<string, string | undefined>,
): ProbeResult {
  const result = spawnSync(binary, ['--version'], {
    encoding: 'utf8',
    timeout: 3000,
    env: { ...process.env, ...env },
  })
  if (result.error !== undefined && (result.error as NodeJS.ErrnoException).code === 'ENOENT') {
    return { binary, installed: false, version: null }
  }
  if (result.error !== undefined && result.status === null) {
    return { binary, installed: true, version: null }
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  return { binary, installed: true, version: lastNonEmptyLine(output) }
}

function lastNonEmptyLine(text: string): string | null {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.at(-1) ?? null
}

function parseVersion(output: string | null, binary: string): string | null {
  if (output === null) return null
  const match = new RegExp(`^${escapeRegExp(binary)}\\s+v?(\\S+)`, 'i').exec(output)
  if (match?.[1] !== undefined) return match[1]
  return output
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function opencodeConfigRoot(home: string, env: Record<string, string | undefined>): string {
  const xdg = env.XDG_CONFIG_HOME
  return xdg !== undefined && xdg !== ''
    ? path.join(xdg, 'opencode')
    : path.join(home, '.config', 'opencode')
}

function codexRoot(home: string, env: Record<string, string | undefined>): string {
  const codexHome = env.CODEX_HOME
  return codexHome !== undefined && codexHome !== '' ? codexHome : path.join(home, '.codex')
}

export function collectProbes(options: ProbeOptions): Partial<Record<HarnessId, HarnessProbe>> {
  const run = options.run ?? ((binary, env) => runVersionProbe(binary, env))
  const { home, env } = options

  const claude = run('claude', env)
  const codex = run('codex', env)
  const opencode1 = run('opencode', env)
  const opencode2 = run('opencode2', env)

  const codexNotes: string[] = []
  const codexDir = codexRoot(home, env)
  if (fs.existsSync(path.join(codexDir, 'auth.json'))) {
    codexNotes.push('credential-storage: auth.json')
  } else if (fs.existsSync(codexDir)) {
    codexNotes.push('credential-storage: keyring')
  }

  const opencodeNotes: string[] = []
  for (const probe of [opencode1, opencode2]) {
    if (!probe.installed) continue
    const version = parseVersion(probe.version, probe.binary)
    opencodeNotes.push(`${probe.binary} ${version ?? 'unknown'}`)
  }
  try {
    for (const name of fs.readdirSync(opencodeConfigRoot(home, env)).sort()) {
      opencodeNotes.push(`config:${name}`)
    }
  } catch {
    // A missing config dir just means no shape notes.
  }

  return {
    claude: {
      installed: claude.installed,
      ...(claude.version === null
        ? {}
        : { version: parseVersion(claude.version, 'claude') ?? claude.version }),
      notes: [],
    },
    codex: {
      installed: codex.installed,
      ...(codex.version === null
        ? {}
        : { version: parseVersion(codex.version, 'codex') ?? codex.version }),
      notes: codexNotes,
    },
    opencode: {
      installed: opencode1.installed || opencode2.installed,
      ...(opencode1.version === null
        ? {}
        : { version: parseVersion(opencode1.version, 'opencode') ?? opencode1.version }),
      notes: opencodeNotes,
    },
  }
}
