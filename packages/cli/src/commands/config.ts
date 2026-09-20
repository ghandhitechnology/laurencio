import fs from 'node:fs'
import path from 'node:path'
import { expand } from '@laurencio/core'
import { configPath } from '../config'
import { adapterContext, type CommandContext } from '../context'
import { describeError } from '../errors'
import { readPause } from '../pause'
import { fail, ok } from '../result'
import { identityFor } from '../session'
import { displayPath, renderResult, table } from '../ui'
import type { CommandSpec } from './command'
import { devicesCommand } from './devices'
import { diffCommand } from './diff'
import { doctorCommand } from './doctor'
import { logCommand } from './log'
import { pauseCommand } from './pause'
import { resolveCommand } from './resolve'
import { restoreCommand } from './restore'
import { resumeCommand } from './resume'
import { collectSurfaces, surfacesCommand } from './surfaces'
import { syncCommand } from './sync'
import { terminalCommand } from './terminal'
import { toolsCommand } from './tools'

export interface ConfigActionGroup {
  key: string
  label: string
  actions: readonly { label: string; description: string }[]
}

export const CONFIG_ACTIONS: readonly ConfigActionGroup[] = [
  {
    key: '1',
    label: 'Skills & MCPs',
    actions: [
      { label: 'Find skill/MCP files', description: 'Show the files to open in your editor.' },
      {
        label: 'Show all sync surfaces',
        description: 'Inspect every detected configuration area.',
      },
    ],
  },
  {
    key: '2',
    label: 'Review & sync',
    actions: [
      { label: 'Review changes', description: 'Compare local, remote, and last-synced content.' },
      { label: 'Preview sync plan', description: 'See what one sync pass would do.' },
      { label: 'Sync now', description: 'Publish and receive configuration changes.' },
      { label: 'Run diagnostics', description: 'Check the local setup and sync state.' },
    ],
  },
  {
    key: '3',
    label: 'History & restore',
    actions: [
      { label: 'View revision history', description: 'List recent synced revisions.' },
      {
        label: 'Restore selected files',
        description: 'Restore one surface or path from a revision.',
      },
    ],
  },
  {
    key: '4',
    label: 'Conflicts',
    actions: [
      { label: 'Resolve conflicts', description: 'Choose the content to keep for each conflict.' },
    ],
  },
  {
    key: '5',
    label: 'Device & sync settings',
    actions: [
      { label: 'List devices', description: 'See enrolled and revoked devices.' },
      { label: 'Rename a device', description: 'Change a device name.' },
      { label: 'Revoke a device', description: 'Remove a device from the account.' },
      {
        label: 'Find sync policy',
        description: 'Show the local policy file and current surfaces.',
      },
      { label: 'Pause background sync', description: 'Stop automatic sync while you review.' },
      { label: 'Resume background sync', description: 'Allow automatic sync to continue.' },
    ],
  },
  {
    key: '6',
    label: 'Terminal & tools',
    actions: [
      {
        label: 'Set a terminal preference',
        description: 'Update a shared keybinding or dimension.',
      },
      { label: 'Update curated tools', description: 'Review and apply the current tool lock.' },
    ],
  },
] as const

interface ConfigData {
  interactive: boolean
  actions: readonly ConfigActionGroup[]
}

type MenuResult = 'back' | 'quit'

function actionCatalog(): string {
  const lines = ['Laurencio configuration', '']
  for (const group of CONFIG_ACTIONS) {
    lines.push(`${group.key}. ${group.label}`)
    for (const action of group.actions) lines.push(`   ${action.label}: ${action.description}`)
  }
  return lines.join('\n')
}

function interactive(ctx: CommandContext): boolean {
  return ctx.io.terminal !== undefined && !ctx.flags.yes && !ctx.flags.json
}

function paint(ctx: CommandContext, text: string, style = '94'): string {
  return interactive(ctx) && ctx.io.terminal?.color ? `\x1b[${style}m${text}\x1b[0m` : text
}

function workbenchId(ctx: CommandContext): string | null {
  const recordPath = path.join(path.dirname(ctx.home), 'runtime-session.json')
  try {
    const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as Record<string, unknown>
    if (typeof record.id !== 'string' || typeof record.home !== 'string') return null
    if (path.resolve(record.home) !== path.resolve(ctx.home)) return null
    return record.id
  } catch {
    return null
  }
}

function header(ctx: CommandContext, temporaryId: string | null): string {
  const lines = [paint(ctx, 'Laurencio configuration', '1;94')]
  if (temporaryId !== null) {
    lines.push(`Temporary workbench: ${temporaryId}`)
    lines.push(
      `From the host terminal, keep edits with \`laurencio save ${temporaryId} --surface <id>\` before closing.`,
    )
    return lines.join('\n')
  }
  const identity = identityFor(ctx)
  lines.push(`Device: ${identity?.name ?? 'not enrolled'}`)
  const paused = readPause(ctx.home) !== null
  lines.push(
    `Background sync: ${paint(ctx, paused ? 'paused' : 'not paused', paused ? '33' : '94')}`,
  )
  return lines.join('\n')
}

function mainMenu(ctx: CommandContext, temporaryId: string | null): void {
  const rows = CONFIG_ACTIONS.map(
    (group) => `  ${paint(ctx, `${group.key}.`, '1;94')} ${group.label}`,
  )
  ctx.io.out([header(ctx, temporaryId), '', ...rows, '', paint(ctx, '  q. Quit', '2')].join('\n'))
}

function submenu(ctx: CommandContext, group: ConfigActionGroup): void {
  const rows = group.actions.map(
    (action, index) =>
      `  ${paint(ctx, `${index + 1}.`, '1;94')} ${action.label}  ${paint(ctx, action.description, '2')}`,
  )
  ctx.io.out(
    [
      paint(ctx, group.label, '1;94'),
      '',
      ...rows,
      '',
      paint(ctx, '  b. Back    q. Quit', '2'),
    ].join('\n'),
  )
}

function childContext(
  ctx: CommandContext,
  spec: CommandSpec,
  positionals: string[],
  flags: Partial<CommandContext['flags']> = {},
): CommandContext {
  return {
    ...ctx,
    command: spec.name,
    subcommand: positionals[0] ?? null,
    positionals,
    flags: {
      ...ctx.flags,
      json: false,
      help: false,
      yes: false,
      harness: [],
      surface: undefined,
      dryRun: false,
      prune: false,
      limit: undefined,
      name: undefined,
      keepLocal: false,
      keepRemote: false,
      editor: false,
      resume: false,
      ...flags,
    },
  }
}

function quoteArgument(value: string): string {
  return /^[a-zA-Z0-9_./:@=+-]+$/.test(value) ? value : JSON.stringify(value)
}

async function runCommand(
  ctx: CommandContext,
  spec: CommandSpec,
  positionals: string[],
  options: {
    flags?: Partial<CommandContext['flags']>
    display?: string
    mutation?: boolean
    temporaryId?: string | null
  } = {},
): Promise<void> {
  const argumentsText = positionals.map(quoteArgument).join(' ')
  const invocation =
    options.display ?? `laurencio ${spec.name}${argumentsText ? ` ${argumentsText}` : ''}`
  ctx.io.out(paint(ctx, `$ ${invocation}`))
  if (options.mutation && options.temporaryId !== undefined && options.temporaryId !== null) {
    ctx.io.err(
      [
        'This action changes the full synced profile.',
        `Save workbench edits with \`laurencio save ${options.temporaryId} --surface <id>\`, or run the action from your full device.`,
      ].join('\n'),
    )
    return
  }
  try {
    const result = await spec.run(childContext(ctx, spec, positionals, options.flags))
    const rendered = renderResult(result, false).trimEnd()
    if (result.exitCode === 0) ctx.io.out(rendered)
    else ctx.io.err(rendered)
  } catch (error) {
    showError(ctx, error)
  }
}

function showError(ctx: CommandContext, error: unknown): void {
  const described = describeError(error)
  ctx.io.err(
    renderResult(fail(described.code, described.message, 1, described.hint), false).trimEnd(),
  )
}

async function ask(ctx: CommandContext, prompt: string): Promise<string> {
  return (await ctx.io.readLine(paint(ctx, prompt))).trim()
}

function isBack(value: string): boolean {
  return value === '' || value.toLowerCase() === 'b' || value.toLowerCase() === 'back'
}

function isQuit(value: string): boolean {
  return value.toLowerCase() === 'q' || value.toLowerCase() === 'quit'
}

async function showSkillAndMcpFiles(ctx: CommandContext): Promise<void> {
  const data = await collectSurfaces(ctx)
  const selected = data.surfaces.filter((surface) => {
    if (surface.policy === 'never') return false
    return (
      surface.id.includes('skill') ||
      [
        'claude.mcp',
        'claude.settings',
        'codex.config',
        'opencode.config-json',
        'opencode.config-jsonc',
      ].includes(surface.id)
    )
  })
  const rows = selected.map((surface) => [
    surface.id,
    surface.enabled ? 'on' : 'off',
    displayPath(ctx.home, expand(surface.declaredPath, adapterContext(ctx))),
  ])
  ctx.io.out('Open these paths in your normal editor. Sync picks up saved changes.')
  ctx.io.out(
    rows.length === 0
      ? 'No skill or MCP configuration files were detected.'
      : table(rows, { header: ['SURFACE', 'SYNC', 'PATH'] }),
  )
}

async function showSyncPolicy(ctx: CommandContext): Promise<void> {
  const data = await collectSurfaces(ctx)
  const rows = data.surfaces.map((surface) => [
    surface.id,
    surface.policy,
    surface.enabled ? 'on' : 'off',
  ])
  ctx.io.out(`Sync policy: ${displayPath(ctx.home, configPath(ctx.home))}`)
  ctx.io.out('Use your normal editor to change harness and surface toggles.')
  ctx.io.out(table(rows, { header: ['SURFACE', 'POLICY', 'STATE'] }))
}

async function restoreGuide(ctx: CommandContext, temporaryId: string | null): Promise<void> {
  ctx.io.out(
    'Choose a revision from History. Pause background sync first if you want to review the restored files before publishing.',
  )
  const revision = await ask(ctx, 'Revision (b to back): ')
  if (isBack(revision)) return
  const selector = await ask(ctx, 'Surface ID, e.g. codex.skills, or store path (b to back): ')
  if (isBack(selector)) return
  await runCommand(ctx, restoreCommand, [revision, selector], {
    mutation: true,
    temporaryId,
  })
}

async function renameGuide(ctx: CommandContext, temporaryId: string | null): Promise<void> {
  const target = await ask(ctx, 'Device ID, name, or self (b to back): ')
  if (isBack(target)) return
  const name = await ask(ctx, 'New name (b to back): ')
  if (isBack(name)) return
  await runCommand(ctx, devicesCommand, ['rename', target], {
    display: `laurencio devices rename ${quoteArgument(target)} --name ${quoteArgument(name)}`,
    flags: { name },
    mutation: true,
    temporaryId,
  })
}

async function revokeGuide(ctx: CommandContext, temporaryId: string | null): Promise<void> {
  const target = await ask(ctx, 'Device ID, name, or self (b to back): ')
  if (isBack(target)) return
  await runCommand(ctx, devicesCommand, ['revoke', target], {
    mutation: true,
    temporaryId,
  })
}

async function terminalGuide(ctx: CommandContext, temporaryId: string | null): Promise<void> {
  const assignment = await ask(
    ctx,
    'Setting, for example split-horizontal=ctrl+d or columns=120 (b to back): ',
  )
  if (isBack(assignment)) return
  await runCommand(ctx, terminalCommand, ['set', assignment], {
    mutation: true,
    temporaryId,
  })
}

async function runGroup(
  ctx: CommandContext,
  group: ConfigActionGroup,
  temporaryId: string | null,
): Promise<MenuResult> {
  while (true) {
    submenu(ctx, group)
    const choice = (await ask(ctx, 'Choose an action: ')).toLowerCase()
    if (isBack(choice)) return 'back'
    if (isQuit(choice)) return 'quit'
    try {
      if (group.key === '1' && choice === '1') await showSkillAndMcpFiles(ctx)
      else if (group.key === '1' && choice === '2') await runCommand(ctx, surfacesCommand, [])
      else if (group.key === '2' && choice === '1') await runCommand(ctx, diffCommand, [])
      else if (group.key === '2' && choice === '2')
        await runCommand(ctx, syncCommand, [], {
          display: 'laurencio sync --dry-run',
          flags: { dryRun: true },
        })
      else if (group.key === '2' && choice === '3')
        await runCommand(ctx, syncCommand, [], { mutation: true, temporaryId })
      else if (group.key === '2' && choice === '4') await runCommand(ctx, doctorCommand, [])
      else if (group.key === '3' && choice === '1') await runCommand(ctx, logCommand, [])
      else if (group.key === '3' && choice === '2') await restoreGuide(ctx, temporaryId)
      else if (group.key === '4' && choice === '1')
        await runCommand(ctx, resolveCommand, [], { mutation: true, temporaryId })
      else if (group.key === '5' && choice === '1') await runCommand(ctx, devicesCommand, ['list'])
      else if (group.key === '5' && choice === '2') await renameGuide(ctx, temporaryId)
      else if (group.key === '5' && choice === '3') await revokeGuide(ctx, temporaryId)
      else if (group.key === '5' && choice === '4') await showSyncPolicy(ctx)
      else if (group.key === '5' && choice === '5')
        await runCommand(ctx, pauseCommand, [], { mutation: true, temporaryId })
      else if (group.key === '5' && choice === '6')
        await runCommand(ctx, resumeCommand, [], { mutation: true, temporaryId })
      else if (group.key === '6' && choice === '1') await terminalGuide(ctx, temporaryId)
      else if (group.key === '6' && choice === '2')
        await runCommand(ctx, toolsCommand, ['update'], { mutation: true, temporaryId })
      else ctx.io.err('Choose a listed action, b to go back, or q to quit.')
    } catch (error) {
      showError(ctx, error)
    }
  }
}

export const configCommand: CommandSpec = {
  name: 'config',
  summary: 'Open the configuration management menu',
  usage: 'laurencio config [--json]',
  details: ['Without an interactive terminal, prints the available actions and exits.'],
  async run(ctx) {
    const data: ConfigData = { interactive: interactive(ctx), actions: CONFIG_ACTIONS }
    if (!data.interactive) return ok(data, actionCatalog)

    const temporaryId = workbenchId(ctx)
    while (true) {
      mainMenu(ctx, temporaryId)
      const choice = (await ask(ctx, 'Choose a group: ')).toLowerCase()
      if (choice === '' || isQuit(choice)) break
      const group = CONFIG_ACTIONS.find((candidate) => candidate.key === choice)
      if (group === undefined) {
        ctx.io.err('Choose 1-6, or q to quit.')
        continue
      }
      if ((await runGroup(ctx, group, temporaryId)) === 'quit') break
    }
    return ok(data, () => 'Configuration menu closed.')
  },
}
