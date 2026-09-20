import {
  type PortableProfile,
  parsePortableProfile,
  supportsProfile,
  TERMINAL_ACTIONS,
  TERMINAL_LAYOUT_SETTINGS,
} from '@laurencio/core'
import { cliError } from '../errors'
import { ensureProfileV2 } from '../profile-version'
import { ok } from '../result'
import { loadRemoteManifest, openSession } from '../session'
import { applyNativeTerminal } from '../workbench/native-terminal'
import {
  loadPortableProfile,
  savePortableProfile,
  updatePortableProfileManifest,
} from '../workbench/profile'
import type { CommandSpec } from './command'

interface TerminalUpdateData {
  generation: number
  changed: string[]
}

const actions = new Set<string>(TERMINAL_ACTIONS)
const layoutSettings = new Set<string>(TERMINAL_LAYOUT_SETTINGS)

function parseAssignment(raw: string): {
  scope: 'shared' | 'darwin' | 'win32'
  name: string
  value: string
} {
  const separator = raw.indexOf('=')
  if (separator < 1) {
    throw cliError('invalid-terminal-settings', `terminal setting must use name=value: ${raw}`)
  }
  const target = raw.slice(0, separator)
  const value = raw.slice(separator + 1)
  const dot = target.indexOf('.')
  const scope = dot < 0 ? 'shared' : target.slice(0, dot)
  const name = dot < 0 ? target : target.slice(dot + 1)
  if (scope !== 'shared' && scope !== 'darwin' && scope !== 'win32') {
    throw cliError('invalid-terminal-settings', `unsupported terminal setting scope: ${scope}`)
  }
  if (!actions.has(name) && !layoutSettings.has(name)) {
    throw cliError('invalid-terminal-settings', `unsupported terminal setting: ${name}`)
  }
  return { scope, name, value }
}

export const terminalCommand: CommandSpec = {
  name: 'terminal',
  summary: 'Update portable terminal keybindings and dimensions',
  usage:
    'laurencio terminal set <action=chord|columns=n|rows=n>... [darwin.<setting>=value] [win32.<setting>=value] [--json]',
  details: ['Empty values remove settings. Unscoped settings apply to both macOS and Windows.'],
  async run(ctx) {
    if (ctx.subcommand !== 'set') {
      throw cliError('unknown-subcommand', `unknown terminal subcommand: ${ctx.subcommand ?? ''}`, {
        hint: 'Known: set',
      })
    }
    const assignments = ctx.positionals.slice(1).map(parseAssignment)
    if (assignments.length === 0) {
      throw cliError('missing-argument', 'provide at least one terminal setting', {
        hint: `Usage: ${terminalCommand.usage}`,
      })
    }

    const session = await openSession(ctx)
    await ensureProfileV2(session.remote)
    if (!supportsProfile(session.remote)) {
      throw cliError('profile-unavailable', 'this remote does not support account profiles')
    }
    let stored = await loadPortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
    })
    if (stored === null) {
      const current = await loadRemoteManifest(session, null)
      if (current.manifest === null) {
        throw cliError('empty-profile', 'enroll this device before updating terminal settings')
      }
      stored = await updatePortableProfileManifest({
        remote: session.remote,
        storeId: session.credentials.storeId,
        key: session.credentials.key,
        manifest: current.manifest,
      })
    }

    const shared = {
      keybindings: { ...stored.profile.shared.keybindings },
      layout: { ...stored.profile.shared.layout },
    }
    const platforms = Object.fromEntries(
      Object.entries(stored.profile.platforms).map(([platform, settings]) => [
        platform,
        {
          ...(settings?.keybindings === undefined
            ? {}
            : { keybindings: { ...settings.keybindings } }),
          ...(settings?.layout === undefined ? {} : { layout: { ...settings.layout } }),
        },
      ]),
    ) as typeof stored.profile.platforms
    const changed: string[] = []
    for (const assignment of assignments) {
      let target: { keybindings?: Record<string, string>; layout?: Record<string, string> } = shared
      if (assignment.scope !== 'shared') {
        let platformSettings = platforms[assignment.scope]
        if (platformSettings === undefined) {
          platformSettings = { keybindings: {}, layout: {} }
          platforms[assignment.scope] = platformSettings
        }
        target = platformSettings
      }
      const section = actions.has(assignment.name) ? 'keybindings' : 'layout'
      let values = target[section]
      if (values === undefined) {
        values = {}
        target[section] = values
      }
      if (assignment.value === '') delete values[assignment.name]
      else values[assignment.name] = assignment.value
      changed.push(
        `${assignment.scope === 'shared' ? '' : `${assignment.scope}.`}${assignment.name}`,
      )
    }
    for (const platform of ['darwin', 'win32'] as const) {
      const settings = platforms[platform]
      if (settings === undefined) continue
      if (Object.keys(settings.keybindings ?? {}).length === 0) delete settings.keybindings
      if (Object.keys(settings.layout ?? {}).length === 0) delete settings.layout
      if (settings.keybindings === undefined && settings.layout === undefined)
        delete platforms[platform]
    }

    let profile: PortableProfile
    try {
      profile = parsePortableProfile({ ...stored.profile, shared, platforms })
    } catch (error) {
      throw cliError(
        'invalid-terminal-settings',
        error instanceof Error ? error.message : 'terminal settings are invalid',
      )
    }
    const head = await savePortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
      profile,
      expectedGeneration: stored.head.generation,
    })
    if (ctx.platform === 'darwin' || ctx.platform === 'win32') {
      const which =
        ctx.deps.which ?? ((name: string) => Bun.which(name, { PATH: ctx.env.PATH ?? '' }))
      const wezterm = ctx.platform === 'win32' ? (which('wezterm-gui') ?? which('wezterm')) : null
      applyNativeTerminal({
        home: ctx.home,
        platform: ctx.platform,
        environment: ctx.env,
        profile,
        ...(ctx.platform === 'win32'
          ? {
              powershell: which('pwsh') ?? 'pwsh.exe',
              ...(wezterm === null ? {} : { wezterm }),
            }
          : {}),
      })
    }
    const data: TerminalUpdateData = { generation: head.generation, changed }
    return ok(data, () => `Terminal profile updated: ${changed.join(', ')}.`)
  },
}
