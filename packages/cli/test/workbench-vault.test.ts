import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createFileRemote, DEFAULT_VAULT_REFERENCES, type VaultReference } from '@laurencio/core'
import { createSystemCredentialIo } from '../src/workbench/credentials'
import { captureCredentialVault, materializeCredentialVault } from '../src/workbench/vault'
import { makeScratch, STORE_ID, seedStore, writeHomeFile } from './helpers'

describe('encrypted credential-vault lifecycle', () => {
  test('captures host credentials and materializes them only into a private environment', async () => {
    const source = makeScratch()
    const target = makeScratch()
    const seeded = await seedStore({ home: source.home, remoteDir: source.remoteDir })
    try {
      writeHomeFile(source.home, '.claude/.credentials.json', '{"token":"claude-secret"}')
      writeHomeFile(source.home, '.codex/auth.json', '{"token":"codex-secret"}')
      const sourceEnvironment: Record<string, string | undefined> = {
        GITHUB_TOKEN: 'github-secret',
      }
      const references: VaultReference[] = [
        ...DEFAULT_VAULT_REFERENCES,
        {
          kind: 'mcp-secret',
          name: 'github-token',
          harness: 'opencode',
          vault: 'laurencio',
          item: 'github',
          field: 'token',
          server: 'github',
          env: 'GITHUB_TOKEN',
        },
      ]
      const remote = createFileRemote({ dir: source.remoteDir })
      const capture = await captureCredentialVault({
        remote,
        storeId: STORE_ID,
        key: seeded.key,
        references,
        tokenEnv: { home: source.home, platform: 'darwin', env: sourceEnvironment },
        io: createSystemCredentialIo(sourceEnvironment),
        now: () => '2026-09-20T00:00:00.000Z',
      })

      expect(capture.results.map((result) => result.status)).toEqual([
        'captured',
        'captured',
        'missing',
        'captured',
      ])
      expect(capture.head?.generation).toBe(1)
      const encrypted = fs.readFileSync(
        path.join(source.remoteDir, 'blobs', capture.head?.blob.id ?? ''),
      )
      expect(encrypted.toString('utf8')).not.toContain('claude-secret')
      expect(encrypted.toString('utf8')).not.toContain('github-secret')

      const privateEnvironment: Record<string, string | undefined> = {}
      const materialized = await materializeCredentialVault({
        remote,
        storeId: STORE_ID,
        key: seeded.key,
        references,
        tokenEnv: { home: target.home, platform: 'darwin', env: privateEnvironment },
        io: createSystemCredentialIo(privateEnvironment),
      })

      expect(materialized.map((result) => result.status)).toEqual([
        'materialized',
        'materialized',
        'missing',
        'materialized',
      ])
      expect(fs.readFileSync(path.join(target.home, '.codex/auth.json'), 'utf8')).toContain(
        'codex-secret',
      )
      expect(privateEnvironment.GITHUB_TOKEN).toBe('github-secret')
      expect(fs.existsSync(path.join(source.home, '.local/share/opencode/auth.json'))).toBe(false)
    } finally {
      seeded.key.zeroize()
      source.cleanup()
      target.cleanup()
    }
  })
})
