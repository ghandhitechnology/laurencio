import fs from 'node:fs'
import path from 'node:path'
import {
  assertCuratedToolSelection,
  type PortableProfile,
  parsePortableProfile,
  resolveToolLock,
  shippedToolLock,
  supportsProfile,
  type ToolLockChange,
  ToolManager,
} from '@laurencio/core'
import { cliError } from '../errors'
import { ensureProfileV2 } from '../profile-version'
import { askYesNo } from '../prompt'
import { ok } from '../result'
import { loadRemoteManifest, openSession } from '../session'
import { createSystemToolDependencies, toolArchitecture } from '../tools/system'
import {
  loadPortableProfile,
  savePortableProfile,
  updatePortableProfileManifest,
} from '../workbench/profile'
import type { CommandSpec } from './command'

interface ToolsUpdateData {
  applied: boolean
  generation: number | null
  changes: ToolLockChange[]
  installed: string[]
}

function describeChange(change: ToolLockChange): string {
  if (change.kind === 'add') {
    return `+ ${change.after.name} ${change.after.version} (${change.after.platform}/${change.after.architecture}, ${change.after.sourceHost})`
  }
  if (change.kind === 'remove') {
    return `- ${change.before.name} ${change.before.version} (${change.before.platform}/${change.before.architecture})`
  }
  return `~ ${change.before.name} ${change.before.version} -> ${change.after.version} (${change.changed.join(', ')})`
}

function humanToolsUpdate(data: ToolsUpdateData): string {
  if (data.changes.length === 0) return 'Tool lock is already current.'
  if (!data.applied) return `Tool lock update canceled (${data.changes.length} changes).`
  return `Tool lock updated: ${data.changes.length} changes, ${data.installed.length} installed, generation ${data.generation ?? 'unknown'}.`
}

export const toolsCommand: CommandSpec = {
  name: 'tools',
  summary: 'Review and apply pinned curated-tool updates',
  usage: 'laurencio tools update [lock.json] [--yes] [--json]',
  details: [
    'Shows a redacted version/source/checksum diff before changing the account profile.',
    'Without a file, follows the curated catalog shipped with this client.',
    'Lock files may select exact entries from that catalog; arbitrary executables are rejected.',
    'Artifacts are downloaded only when a workbench opens, then verified against the stored SHA-256.',
  ],
  async run(ctx) {
    if (ctx.subcommand !== 'update') {
      throw cliError('unknown-subcommand', `unknown tools subcommand: ${ctx.subcommand ?? ''}`, {
        hint: 'Known: update',
      })
    }
    const lockArgument = ctx.positionals[1]
    let tools: unknown[] = []
    if (lockArgument !== undefined) {
      const lockPath = path.resolve(ctx.cwd, lockArgument)
      let proposed: unknown
      try {
        proposed = JSON.parse(fs.readFileSync(lockPath, 'utf8'))
      } catch (error) {
        throw cliError(
          'invalid-tool-lock',
          `could not read tool lock: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const selected = Array.isArray(proposed)
        ? proposed
        : typeof proposed === 'object' && proposed !== null
          ? (proposed as Record<string, unknown>).tools
          : undefined
      if (!Array.isArray(selected)) {
        throw cliError('invalid-tool-lock', 'tool lock must be an array or an object with tools')
      }
      tools = selected
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
        throw cliError('empty-profile', 'enroll this device before updating tools')
      }
      stored = await updatePortableProfileManifest({
        remote: session.remote,
        storeId: session.credentials.storeId,
        key: session.credentials.key,
        manifest: current.manifest,
      })
    }
    let profile: PortableProfile
    try {
      profile = parsePortableProfile({ ...stored.profile, tools })
      assertCuratedToolSelection(profile.tools, ctx.deps.curatedTools ?? shippedToolLock())
    } catch (error) {
      throw cliError(
        'invalid-tool-lock',
        error instanceof Error ? error.message : 'tool lock is invalid',
      )
    }
    const catalog = ctx.deps.curatedTools ?? shippedToolLock()
    const currentTools =
      stored.profile.tools.length === 0
        ? catalog.map((entry) => ({ ...entry }))
        : stored.profile.tools.map((entry) => ({ ...entry }))
    const nextTools = resolveToolLock(profile.tools, catalog)
    const changes = new ToolManager(
      currentTools,
      createSystemToolDependencies({
        ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
      }),
    ).diff(nextTools)
    if (changes.length === 0) {
      const data: ToolsUpdateData = {
        applied: false,
        generation: stored.head.generation,
        changes,
        installed: [],
      }
      return ok(data, () => humanToolsUpdate(data))
    }
    if (!ctx.flags.json) ctx.io.out(changes.map(describeChange).join('\n'))
    const confirmed = ctx.flags.yes || (await askYesNo(ctx, 'Apply this tool lock update?', false))
    if (!confirmed) {
      const data: ToolsUpdateData = {
        applied: false,
        generation: stored.head.generation,
        changes,
        installed: [],
      }
      return ok(data, () => humanToolsUpdate(data))
    }
    const dependencies = createSystemToolDependencies({
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
    })
    const installed = await new ToolManager(nextTools, dependencies).install({
      platform: ctx.platform === 'win32' ? 'win32' : 'darwin',
      architecture: toolArchitecture(ctx.deps.architecture ?? process.arch),
      target: { kind: 'cache', root: path.join(ctx.home, '.laurencio', 'tools') },
    })
    const head = await savePortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
      profile,
      expectedGeneration: stored.head.generation,
    })
    const data: ToolsUpdateData = {
      applied: true,
      generation: head.generation,
      changes,
      installed: installed.map((tool) => tool.name),
    }
    return ok(data, () => humanToolsUpdate(data))
  },
}
