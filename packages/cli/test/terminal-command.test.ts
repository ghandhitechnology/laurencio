import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { createFileRemote } from '@laurencio/core'
import { loadPortableProfile } from '../src/workbench/profile'
import { makeScratch, runForTest, STORE_ID, seedStore, writeHomeFile } from './helpers'

describe('portable terminal settings', () => {
  test('imports recognized tmux semantics during first enrollment', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(
        scratch.home,
        '.tmux.conf',
        [
          'set -g mouse on',
          'bind-key -n C-M-h split-window -h',
          'bind -n C-M-v split-window -v',
          'set -g default-size 132x44',
          '',
        ].join('\n'),
      )

      expect(
        (await runForTest(['init', '--yes'], { home: scratch.home, remoteDir: scratch.remoteDir }))
          .exitCode,
      ).toBe(0)
      const stored = await loadPortableProfile({
        remote: createFileRemote({ dir: scratch.remoteDir }),
        storeId: STORE_ID,
        key: seeded.key,
      })
      expect(stored?.profile.shared).toEqual({
        keybindings: {
          'split-horizontal': 'ctrl+alt+h',
          'split-vertical': 'ctrl+alt+v',
        },
        layout: { columns: '132', rows: '44' },
      })
      expect(fs.readFileSync(path.join(scratch.home, '.tmux.conf'), 'utf8')).toContain(
        'laurencio:terminal:begin',
      )
    } finally {
      scratch.cleanup()
    }
  })

  test('updates and clears shared and platform settings through profile CAS', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      expect(
        (await runForTest(['init', '--yes'], { home: scratch.home, remoteDir: scratch.remoteDir }))
          .exitCode,
      ).toBe(0)
      const result = await runForTest(
        [
          'terminal',
          'set',
          'split-horizontal=ctrl+alt+h',
          'columns=120',
          'win32.split-horizontal=ctrl+shift+s',
        ],
        { home: scratch.home, remoteDir: scratch.remoteDir },
      )
      expect(result.exitCode).toBe(0)
      const remote = createFileRemote({ dir: scratch.remoteDir })
      let stored = await loadPortableProfile({ remote, storeId: STORE_ID, key: seeded.key })
      expect(stored?.profile.shared).toEqual({
        keybindings: { 'split-horizontal': 'ctrl+alt+h' },
        layout: { columns: '120' },
      })
      expect(stored?.profile.platforms.win32?.keybindings).toEqual({
        'split-horizontal': 'ctrl+shift+s',
      })
      expect(
        fs.readFileSync(path.join(scratch.home, '.laurencio/generated/tmux.conf'), 'utf8'),
      ).toContain('split-window -h')

      const cleared = await runForTest(['terminal', 'set', 'columns=', 'win32.split-horizontal='], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(cleared.exitCode).toBe(0)
      stored = await loadPortableProfile({ remote, storeId: STORE_ID, key: seeded.key })
      expect(stored?.profile.shared.layout).toEqual({})
      expect(stored?.profile.platforms.win32).toBeUndefined()
    } finally {
      scratch.cleanup()
    }
  })

  test('rejects unsupported semantic values before writing the profile', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      await runForTest(['init', '--yes'], { home: scratch.home, remoteDir: scratch.remoteDir })
      const result = await runForTest(['terminal', 'set', 'palette=cmd+k'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(result.exitCode).toBe(1)
      expect(result.errorOutput).toContain('unsupported terminal modifier')
    } finally {
      scratch.cleanup()
    }
  })
})
