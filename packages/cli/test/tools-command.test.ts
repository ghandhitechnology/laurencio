import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createFileRemote, openProfile, shippedToolLock } from '@laurencio/core'
import { makeScratch, runForTest, STORE_ID, seedStore, writeHomeFile } from './helpers'

describe('tools update command', () => {
  test('shows and stores a validated pinned lock in the encrypted account profile', async () => {
    const scratch = makeScratch()
    const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
    try {
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Instructions\n')
      const enrolled = await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: { quiescence: { windowMs: 0 } },
      })
      expect(enrolled.exitCode).toBe(0)
      const lockPath = path.join(scratch.home, 'next-tools.json')
      const selected = shippedToolLock().filter(
        (entry) => entry.name === 'powershell' && entry.arch === 'x64',
      )
      fs.writeFileSync(lockPath, JSON.stringify(selected))

      const updated = await runForTest(['tools', 'update', lockPath, '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: { architecture: 'arm64' },
      })

      expect(updated.exitCode).toBe(0)
      expect(updated.output).toContain('Tool lock updated: 4 changes, 0 installed, generation 2')
      expect(updated.combined).not.toContain(selected[0]?.sha256 ?? 'missing')
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const head = await remote.getProfileHead()
      expect(head?.generation).toBe(2)
      if (head === null) throw new Error('profile head was not written')
      const encrypted = await remote.getBlob(head.blob.id)
      const profile = openProfile(seeded.key, encrypted, {
        storeId: STORE_ID,
        protocolVersion: 1,
      })
      expect(profile.tools).toHaveLength(1)
      expect(profile.tools).toEqual(selected)
    } finally {
      seeded.key.zeroize()
      scratch.cleanup()
    }
  })

  test('rejects executable pins outside the embedded curated catalog', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.codex/AGENTS.md', '# Instructions\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: { quiescence: { windowMs: 0 } },
      })
      const lockPath = path.join(scratch.home, 'untrusted-tools.json')
      fs.writeFileSync(
        lockPath,
        JSON.stringify([
          {
            name: 'arbitrary',
            platform: 'darwin',
            arch: 'arm64',
            version: '1.0.0',
            url: 'https://tools.example/arbitrary',
            sha256: 'a'.repeat(64),
          },
        ]),
      )

      const result = await runForTest(['tools', 'update', lockPath, '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })

      expect(result.exitCode).toBe(1)
      expect(result.errorOutput).toContain('not in the shipped curated catalog')
    } finally {
      scratch.cleanup()
    }
  })
})
