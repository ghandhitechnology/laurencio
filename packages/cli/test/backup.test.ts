import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createBackup, pruneBackups } from '../src/backup'

test('backups retain symlink target bytes, same-second snapshots, and the baseline', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'laurencio-backup-'))
  try {
    const target = path.join(home, 'config')
    const link = path.join(home, 'link')
    fs.writeFileSync(target, 'original')
    fs.symlinkSync('config', link)
    const now = new Date('2026-09-21T12:00:00Z')
    const roots = [{ label: 'config', path: link }]
    const baseline = createBackup(home, roots, now)
    fs.writeFileSync(target, 'updated')
    const next = createBackup(home, roots, now)
    expect(next.dir).not.toBe(baseline.dir)
    expect(fs.readFileSync(path.join(baseline.dir, '01-config'), 'utf8')).toBe('original')
    expect(baseline.entries[0]?.linkTarget).toBe('config')
    const terminal = path.join(home, '.laurencio/backups/terminal')
    fs.mkdirSync(terminal)
    fs.writeFileSync(path.join(terminal, 'original'), 'terminal')
    pruneBackups(home, 0)
    expect(fs.existsSync(baseline.dir)).toBe(true)
    expect(fs.existsSync(next.dir)).toBe(false)
    expect(fs.readFileSync(path.join(terminal, 'original'), 'utf8')).toBe('terminal')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('offline recovery restores a deleted symlink target and refuses a retargeted link', async () => {
  const { Applier, hashContent, SyncState } = await import('@laurencio/core')
  const { SurfaceId } = await import('@laurencio/protocol')
  const { makeScratch, runForTest } = await import('./helpers')
  const scratch = makeScratch()
  const home = fs.realpathSync(scratch.home)
  const target = path.join(home, 'config.toml')
  const link = path.join(home, 'linked.toml')
  fs.writeFileSync(target, 'original')
  fs.symlinkSync('config.toml', link)
  const state = SyncState.open({ home })
  try {
    const applier = new Applier({ state, planPaths: [link, target], platform: 'darwin' })
    applier.write({ storePath: 'config', declaredPath: link, content: 'updated' })
    applier.remove({
      storePath: 'config',
      declaredPath: link,
      surfaceId: SurfaceId.parse('codex.config'),
    })
    const listing = await runForTest(['backups', '--json'], { home })
    const original = (
      JSON.parse(listing.output) as { backups: { id: string; hash: string }[] }
    ).backups.find((item) => item.hash === hashContent('original'))
    if (original === undefined) throw new Error('missing original backup')
    const recovered = await runForTest(['backups', 'restore', original.id, '--yes', '--json'], {
      home,
    })
    expect(recovered.exitCode, recovered.errorOutput).toBe(0)
    expect(fs.readFileSync(target, 'utf8')).toBe('original')
    expect(fs.readlinkSync(link)).toBe('config.toml')
    fs.unlinkSync(link)
    fs.symlinkSync('different.toml', link)
    const refused = await runForTest(['backups', 'restore', original.id, '--yes', '--json'], {
      home,
    })
    expect(refused.exitCode).toBe(1)
    expect(refused.errorOutput).toContain('backup-path-changed')
    expect(fs.existsSync(path.join(home, 'different.toml'))).toBe(false)
  } finally {
    state.close()
    scratch.cleanup()
  }
})
