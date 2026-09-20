import type { PlatformProfileOverride, ProfileSettings } from './model'

export const TERMINAL_ACTIONS = [
  'split-horizontal',
  'split-vertical',
  'new-tab',
  'close-pane',
  'next-pane',
  'previous-pane',
  'zoom-pane',
  'palette',
  'accept',
] as const

export const TERMINAL_LAYOUT_SETTINGS = ['columns', 'rows'] as const

const actions = new Set<string>(TERMINAL_ACTIONS)
const layoutSettings = new Set<string>(TERMINAL_LAYOUT_SETTINGS)
const modifiers = new Set(['ctrl', 'mod', 'alt', 'shift'])
const namedKeys = new Set(['enter', 'space', 'tab', 'escape', 'left', 'right', 'up', 'down'])

/** Returns the first reason a profile cannot be rendered by either native terminal adapter. */
export function terminalSemanticIssue(
  settings: ProfileSettings | PlatformProfileOverride,
): string | null {
  for (const [action, chord] of Object.entries(settings.keybindings ?? {})) {
    if (!actions.has(action)) return `unsupported terminal action: ${action}`
    const parts = chord.toLowerCase().split('+')
    const key = parts.pop() ?? ''
    for (const modifier of parts) {
      if (!modifiers.has(modifier)) return `unsupported terminal modifier: ${modifier}`
    }
    if (!/^[a-z0-9]$/.test(key) && !/^f(?:[1-9]|1[0-2])$/.test(key) && !namedKeys.has(key)) {
      return `unsupported terminal key: ${chord}`
    }
  }
  for (const [name, value] of Object.entries(settings.layout ?? {})) {
    if (!layoutSettings.has(name)) return `unsupported terminal layout setting: ${name}`
    if (!/^[1-9][0-9]{0,3}$/.test(value)) {
      return `unsupported terminal layout value: ${name}=${value}`
    }
  }
  return null
}
