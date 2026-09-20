import fs from 'node:fs'
import {
  Applier,
  type CredentialIo,
  expand,
  type FileFingerprint,
  hashContent,
  StaleWriteError,
  type SyncState,
  type VaultReference,
} from '@laurencio/core'
import { adapterContext, type CommandContext } from './context'
import { createSystemCredentialIo } from './workbench/credentials'

/** Native credential writes share configuration backups and compare-and-swap guards. */
export function createNativeCredentialIo(
  ctx: CommandContext,
  state: SyncState,
  references: readonly VaultReference[],
): CredentialIo {
  if (ctx.platform !== 'darwin' && ctx.platform !== 'win32') {
    throw new Error('Native credentials require macOS or Windows')
  }
  const paths = references
    .filter((reference) => reference.kind === 'agent-auth')
    .map((reference) => expand(reference.path, adapterContext(ctx)))
  const applier = new Applier({ state, planPaths: paths, platform: ctx.platform, now: ctx.now })
  const snapshots = new Map<string, { physicalPath: string; expected: FileFingerprint | null }>()
  const physicalPath = (filePath: string): string => {
    const target = applier.resolve(filePath).writePaths[0]
    if (target === undefined || !paths.includes(filePath))
      throw new Error('Undeclared credential path')
    return target
  }
  // Explicit keep-remote does not read local credentials before fetching the vault.
  // Capture its guard now, so a native agent rotation during that fetch survives.
  for (const filePath of paths) {
    snapshots.set(filePath, {
      physicalPath: physicalPath(filePath),
      expected: applier.fingerprint(filePath),
    })
  }
  const io = createSystemCredentialIo(ctx.env, {
    durableMcp: {
      platform: ctx.platform,
      ...(ctx.deps.keychain === undefined ? {} : { keychain: ctx.deps.keychain }),
    },
  })
  return {
    ...io,
    async readFile(filePath) {
      const target = physicalPath(filePath)
      const expected = applier.fingerprint(filePath)
      let value: Uint8Array | null = null
      try {
        value = new Uint8Array(fs.readFileSync(filePath))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      const after = applier.fingerprint(filePath)
      if (
        physicalPath(filePath) !== target ||
        expected?.hash !== after?.hash ||
        expected?.mtimeMs !== after?.mtimeMs ||
        (value === null ? expected !== null : hashContent(value) !== expected?.hash)
      ) {
        value?.fill(0)
        throw new StaleWriteError(filePath, expected, after)
      }
      snapshots.set(filePath, { physicalPath: target, expected })
      return value
    },
    async writeFileAtomic(filePath, content, mode) {
      const snapshot = snapshots.get(filePath)
      if (snapshot === undefined || physicalPath(filePath) !== snapshot.physicalPath) {
        throw new StaleWriteError(
          filePath,
          snapshot?.expected ?? null,
          applier.fingerprint(filePath),
        )
      }
      applier.write({
        storePath: filePath,
        declaredPath: filePath,
        content,
        mode,
        expected: snapshot.expected,
      })
      snapshots.set(filePath, {
        physicalPath: snapshot.physicalPath,
        expected: applier.fingerprint(filePath),
      })
    },
  }
}
