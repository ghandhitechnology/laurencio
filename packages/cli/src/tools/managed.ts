import path from 'node:path'
import {
  type InstalledTool,
  resolveToolLock,
  shippedToolLock,
  supportsProfile,
  type ToolLockEntry,
  ToolManager,
} from '@laurencio/core'
import type { CommandContext } from '../context'
import type { CliSession } from '../session'
import { loadPortableProfile } from '../workbench/profile'
import { createSystemToolDependencies, toolArchitecture } from './system'

/** Installs this account's pinned runtimes into the persistent full-mode tool directory. */
export async function provisionManagedTools(
  ctx: CommandContext,
  session: CliSession,
): Promise<InstalledTool[]> {
  let profileLock: readonly ToolLockEntry[] = []
  if (supportsProfile(session.remote)) {
    const stored = await loadPortableProfile({
      remote: session.remote,
      storeId: session.credentials.storeId,
      key: session.credentials.key,
    })
    profileLock = stored?.profile.tools ?? []
  }
  return new ToolManager(
    resolveToolLock(profileLock, ctx.deps.curatedTools ?? shippedToolLock()),
    createSystemToolDependencies({
      ...(ctx.deps.fetch === undefined ? {} : { fetch: ctx.deps.fetch }),
    }),
  ).install({
    platform: ctx.platform === 'win32' ? 'win32' : 'darwin',
    architecture: toolArchitecture(ctx.deps.architecture ?? process.arch),
    target: { kind: 'cache', root: path.join(ctx.home, '.laurencio', 'tools') },
  })
}
