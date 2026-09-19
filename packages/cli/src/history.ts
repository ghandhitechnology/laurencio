/**
 * History reads shared by `log` and `restore`: revision listing, prefix
 * resolution, and manifest decryption at a chosen revision.
 */

import type { Manifest, RevisionMeta } from '@laurencio/core'
import type { RevisionId } from '@laurencio/protocol'
import type { CommandContext } from './context'
import { cliError } from './errors'
import { type CliSession, decryptManifest, identityFor, openState } from './session'
import { shortId } from './ui'

export interface RevisionRow {
  id: string
  shortId: string
  createdAt: string
  deviceId: string
  deviceName: string | null
  parents: string[]
  files: number
  bytes: number
  isBase: boolean
  isHead: boolean
}

export interface HistoryView {
  base: string | null
  head: string | null
  revisions: RevisionRow[]
}

async function deviceNames(session: CliSession): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  try {
    for (const device of await session.remote.listDevices()) names.set(device.id, device.name)
  } catch {
    // Names are cosmetic; an unreachable device list never blocks log.
  }
  return names
}

export async function listHistory(
  ctx: CommandContext,
  session: CliSession,
  limit: number,
): Promise<HistoryView> {
  const state = openState(ctx)
  let base: string | null
  try {
    base = state.getBaseRevision()
  } finally {
    state.close()
  }
  const page = await session.remote.listRevisions({ limit })
  const names = await deviceNames(session)
  const identity = identityFor(ctx)
  if (identity !== null) names.set(identity.deviceId, identity.name)
  const revisions = page.revisions.map((meta: RevisionMeta): RevisionRow => {
    let files = 0
    let bytes = 0
    for (const digest of meta.digest) {
      files += digest.files
      bytes += digest.bytes
    }
    return {
      id: meta.id,
      shortId: shortId(meta.id),
      createdAt: meta.createdAt,
      deviceId: meta.deviceId,
      deviceName: names.get(meta.deviceId) ?? null,
      parents: [...meta.parents],
      files,
      bytes,
      isBase: meta.id === base,
      isHead: meta.id === page.head,
    }
  })
  return { base, head: page.head, revisions }
}

export async function resolveRevisionId(session: CliSession, prefix: string): Promise<RevisionId> {
  const page = await session.remote.listRevisions()
  const matches = page.revisions.filter((revision) => revision.id.startsWith(prefix))
  if (matches.length === 0) {
    throw cliError('unknown-revision', `no revision matches ${prefix}`, {
      hint: 'Run `laurencio log` to list revisions.',
    })
  }
  if (matches.length > 1) {
    throw cliError('ambiguous-revision', `${prefix} matches ${matches.length} revisions`, {
      hint: `Candidates: ${matches.map((revision) => shortId(revision.id, 14)).join(', ')}`,
    })
  }
  const match = matches[0]
  if (match === undefined) throw cliError('unknown-revision', `no revision matches ${prefix}`)
  return match.id
}

export async function fetchManifestAt(
  session: CliSession,
  revisionId: RevisionId,
): Promise<Manifest> {
  const bytes = await session.remote.getManifest(revisionId)
  return decryptManifest(session, bytes)
}
