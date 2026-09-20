import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createFileRemote,
  DEFAULT_VAULT_REFERENCES,
  SyncState,
  type VaultReference,
  vaultRecordId,
} from '@laurencio/core'
import { createSystemCredentialIo } from '../src/workbench/credentials'
import { captureCredentialVault, materializeCredentialVault } from '../src/workbench/vault'
import {
  makeScratch,
  readHomeFile,
  runForTest,
  STORE_ID,
  seedStore,
  writeHomeFile,
} from './helpers'

function defaultCodexReference(): VaultReference {
  const reference = DEFAULT_VAULT_REFERENCES.find((candidate) => candidate.name === 'codex-login')
  if (reference === undefined) throw new Error('expected the default Codex credential reference')
  return reference
}

const CODEX_REFERENCE = defaultCodexReference()

async function seedRemoteCredential(
  home: string,
  remoteDir: string,
  key: Awaited<ReturnType<typeof seedStore>>['key'],
  value: string,
): Promise<void> {
  writeHomeFile(home, '.codex/auth.json', value)
  const captured = await captureCredentialVault({
    remote: createFileRemote({ dir: remoteDir }),
    storeId: STORE_ID,
    key,
    references: [CODEX_REFERENCE],
    tokenEnv: { home, platform: 'darwin', env: {} },
    io: createSystemCredentialIo({}),
  })
  expect(captured.head?.generation).toBe(1)
}

function persistedCodexBaseline(home: string): { version: number; digest: string } {
  const state = SyncState.open({ home })
  try {
    const raw = state.getMeta('credential_vault_baselines')
    if (raw === null) throw new Error('expected a credential baseline')
    const baselines = JSON.parse(raw) as Record<string, { version: number; digest: string }>
    const baseline = baselines[vaultRecordId(CODEX_REFERENCE)]
    if (baseline === undefined) throw new Error('expected the Codex credential baseline')
    return baseline
  } finally {
    state.close()
  }
}

describe('credentials resolve', () => {
  test('keeps a first-seen divergent local agent login with a vault CAS and resets its baseline', async () => {
    const scratch = makeScratch()
    const target = makeScratch()
    const remoteSecret = '{"token":"remote-secret"}\n'
    const localSecret = '{"token":"local-secret"}\n'
    const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
    try {
      await seedRemoteCredential(scratch.home, scratch.remoteDir, seeded.key, remoteSecret)
      writeHomeFile(scratch.home, '.codex/auth.json', localSecret)
      const conflicted = await runForTest(['sync', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: { quiescence: { windowMs: 0 } },
      })
      expect(conflicted.exitCode).toBe(1)
      expect(JSON.parse(conflicted.errorOutput)).toMatchObject({
        error: {
          code: 'credential-conflict',
          hint: expect.stringContaining('laurencio credentials resolve <reference>'),
        },
      })
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const expectedGenerations: Array<number | null> = []
      const instrumented = {
        ...remote,
        async putVaultHead(input: Parameters<typeof remote.putVaultHead>[0]) {
          expectedGenerations.push(input.expectedGeneration)
          return remote.putVaultHead(input)
        },
      }

      const result = await runForTest(
        ['credentials', 'resolve', 'codex-login', '--keep-local', '--json'],
        {
          home: scratch.home,
          remoteDir: scratch.remoteDir,
          deps: { remote: () => instrumented },
        },
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.output)).toEqual({
        name: 'codex-login',
        kind: 'agent-auth',
        harness: 'codex',
        direction: 'keep-local',
        status: 'resolved',
        version: 2,
      })
      expect(result.combined).not.toContain('local-secret')
      expect(result.combined).not.toContain('remote-secret')
      expect(expectedGenerations).toEqual([1])
      expect(persistedCodexBaseline(scratch.home)).toMatchObject({ version: 2 })
      expect(persistedCodexBaseline(scratch.home).digest).toMatch(/^[0-9a-f]{64}$/)

      await materializeCredentialVault({
        remote,
        storeId: STORE_ID,
        key: seeded.key,
        references: [CODEX_REFERENCE],
        tokenEnv: { home: target.home, platform: 'darwin', env: {} },
        io: createSystemCredentialIo({}),
      })
      expect(readHomeFile(target.home, '.codex/auth.json')).toBe(localSecret)
      expect((await remote.getVaultHead())?.generation).toBe(2)
    } finally {
      seeded.key.zeroize()
      scratch.cleanup()
      target.cleanup()
    }
  })

  test('keeps a first-seen divergent remote agent login and resets its local baseline', async () => {
    const scratch = makeScratch()
    const remoteSecret = '{"token":"remote-secret"}\n'
    const localSecret = '{"token":"local-secret"}\n'
    const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
    try {
      await seedRemoteCredential(scratch.home, scratch.remoteDir, seeded.key, remoteSecret)
      writeHomeFile(scratch.home, '.codex/auth.json', localSecret)

      const result = await runForTest(
        ['credentials', 'resolve', 'codex-login', '--keep-remote', '--json'],
        {
          home: scratch.home,
          remoteDir: scratch.remoteDir,
        },
      )

      expect(result.exitCode).toBe(0)
      expect(JSON.parse(result.output)).toEqual({
        name: 'codex-login',
        kind: 'agent-auth',
        harness: 'codex',
        direction: 'keep-remote',
        status: 'resolved',
        version: 1,
      })
      expect(result.combined).not.toContain('local-secret')
      expect(result.combined).not.toContain('remote-secret')
      expect(readHomeFile(scratch.home, '.codex/auth.json')).toBe(remoteSecret)
      expect(persistedCodexBaseline(scratch.home)).toMatchObject({ version: 1 })
      expect(persistedCodexBaseline(scratch.home).digest).toMatch(/^[0-9a-f]{64}$/)
      expect((await createFileRemote({ dir: scratch.remoteDir }).getVaultHead())?.generation).toBe(
        1,
      )
      expect(fs.statSync(path.join(scratch.home, '.codex/auth.json')).mode & 0o777).toBe(0o600)
    } finally {
      seeded.key.zeroize()
      scratch.cleanup()
    }
  })
})
