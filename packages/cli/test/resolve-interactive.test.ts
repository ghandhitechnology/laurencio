import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  conflictCopyPath,
  SyncState,
} from '@laurencio/core'
import { makeScratch, NOW, readHomeFile, runForTest, seedStore, writeHomeFile } from './helpers'

interface ConflictFixture {
  source: string
  copy: string
}

function plantConflict(home: string): ConflictFixture {
  writeHomeFile(home, '.claude/CLAUDE.md', 'local\n')
  const source = path.join(home, '.claude/CLAUDE.md')
  const copy = conflictCopyPath(source, 'other-device', NOW)
  fs.writeFileSync(copy, 'remote\n')

  const state = SyncState.open({ home })
  try {
    state.setMeta(
      CONFLICT_LEDGER_META_KEY,
      new ConflictLedger([
        { path: copy, sourcePath: source, device: 'other-device', createdAt: NOW },
      ]).toJSON(),
    )
  } finally {
    state.close()
  }

  return { source, copy }
}

function openConflicts(home: string): ReturnType<ConflictLedger['records']> {
  const state = SyncState.open({ home })
  try {
    const raw = state.getMeta(CONFLICT_LEDGER_META_KEY)
    return raw === null ? [] : ConflictLedger.fromJSON(raw).records()
  } finally {
    state.close()
  }
}

describe('interactive resolve', () => {
  test('keeps local content when the user chooses l', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const conflict = plantConflict(scratch.home)

      const result = await runForTest(['resolve'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        answers: ['l'],
      })

      expect(result.exitCode).toBe(0)
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('local\n')
      expect(fs.existsSync(conflict.copy)).toBe(false)
      expect(openConflicts(scratch.home)).toEqual([])
      expect(result.output).toContain('(keep-local)')
    } finally {
      scratch.cleanup()
    }
  })

  test('keeps remote content when the user chooses r', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const conflict = plantConflict(scratch.home)

      const result = await runForTest(['resolve'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        answers: ['r'],
      })

      expect(result.exitCode).toBe(0)
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('remote\n')
      expect(fs.existsSync(conflict.copy)).toBe(false)
      expect(openConflicts(scratch.home)).toEqual([])
      expect(result.output).toContain('(keep-remote)')
    } finally {
      scratch.cleanup()
    }
  })

  test('leaves the conflict open when the user chooses s', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const conflict = plantConflict(scratch.home)

      const result = await runForTest(['resolve'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        answers: ['s'],
      })

      expect(result.exitCode).toBe(2)
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('local\n')
      expect(fs.readFileSync(conflict.copy, 'utf8')).toBe('remote\n')
      expect(openConflicts(scratch.home)).toEqual([
        {
          path: conflict.copy,
          sourcePath: conflict.source,
          device: 'other-device',
          createdAt: NOW,
        },
      ])
      expect(result.errorOutput).toBe('No conflicts were resolved.\n')
    } finally {
      scratch.cleanup()
    }
  })

  test.skipIf(process.platform === 'win32')(
    '--editor opens the source with the configured editor',
    async () => {
      const scratch = makeScratch()
      try {
        await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
        const conflict = plantConflict(scratch.home)

        const result = await runForTest(['resolve', '--editor'], {
          home: scratch.home,
          remoteDir: scratch.remoteDir,
          env: { EDITOR: '/usr/bin/true' },
        })

        expect(result.exitCode).toBe(0)
        expect(fs.existsSync(conflict.copy)).toBe(false)
        expect(openConflicts(scratch.home)).toEqual([])
        expect(result.output).toContain('(editor)')
      } finally {
        scratch.cleanup()
      }
    },
  )

  test.skipIf(process.platform === 'win32')(
    '--editor leaves the conflict open when the editor exits unsuccessfully',
    async () => {
      const scratch = makeScratch()
      try {
        await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
        const conflict = plantConflict(scratch.home)

        const result = await runForTest(['resolve', '--editor'], {
          home: scratch.home,
          remoteDir: scratch.remoteDir,
          env: { EDITOR: '/usr/bin/false' },
        })

        expect(result.exitCode).toBe(1)
        expect(fs.readFileSync(conflict.copy, 'utf8')).toBe('remote\n')
        expect(openConflicts(scratch.home)).toEqual([
          {
            path: conflict.copy,
            sourcePath: conflict.source,
            device: 'other-device',
            createdAt: NOW,
          },
        ])
      } finally {
        scratch.cleanup()
      }
    },
  )
})
