import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { Applier, SyncState } from '@laurencio/core'
import { readPause } from '../src/pause'
import { makeScratch, runForTest, writeHomeFile } from './helpers'

test('recovers a native configuration offline, preserves its link, and backs up the replaced version', async () => {
  const scratch = makeScratch()
  const state = SyncState.open({ home: scratch.home })
  try {
    writeHomeFile(scratch.home, 'config/native.toml', 'model = "original"\n')
    const physical = path.join(scratch.home, 'config/native.toml')
    const declared = path.join(scratch.home, 'config/agent.toml')
    fs.symlinkSync('native.toml', declared)
    const applier = new Applier({ state, planPaths: [physical, declared], platform: 'darwin' })
    applier.write({ declaredPath: declared, storePath: declared, content: 'model = "changed"\n' })
    const listing = await runForTest(['backups', '--json'], { home: scratch.home })
    expect(listing.exitCode).toBe(0)
    const backups = JSON.parse(listing.output).backups as { id: string; contentPath: string }[]
    expect(backups).toHaveLength(1)
    const backup = backups[0]
    if (backup === undefined) throw new Error('missing backup')
    const restored = await runForTest(['backups', 'restore', backup.id, '--yes', '--json'], {
      home: scratch.home,
    })
    expect(restored.exitCode).toBe(0)
    expect(fs.readFileSync(physical, 'utf8')).toBe('model = "original"\n')
    expect(fs.readlinkSync(declared)).toBe('native.toml')
    expect(readPause(scratch.home)?.by).toBe('backup-restore')
    const after = await runForTest(['backups', '--json'], { home: scratch.home })
    expect(JSON.parse(after.output).backups).toHaveLength(2)
    fs.writeFileSync(backup.contentPath, 'corrupted')
    const rejected = await runForTest(['backups', 'restore', backup.id, '--yes'], {
      home: scratch.home,
    })
    expect(rejected.exitCode).toBe(1)
    expect(rejected.errorOutput).toContain('integrity check')
    expect(fs.readFileSync(physical, 'utf8')).toBe('model = "original"\n')
  } finally {
    state.close()
    scratch.cleanup()
  }
})
