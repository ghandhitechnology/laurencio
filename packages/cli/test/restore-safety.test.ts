import { expect, test } from 'bun:test'
import { parse } from 'smol-toml'
import { makeScratch, readHomeFile, runForTest, seedStore, writeHomeFile } from './helpers'

test('restoring a revision retains native machine settings and current local instructions', async () => {
  const scratch = makeScratch()
  const options = {
    home: scratch.home,
    remoteDir: scratch.remoteDir,
    deps: { quiescence: { windowMs: 0 } },
  }
  try {
    await seedStore(options)
    writeHomeFile(
      scratch.home,
      '.codex/config.toml',
      'model = "first"\nnotify = ["first-device"]\nfuture_setting = "first"\n',
    )
    writeHomeFile(
      scratch.home,
      '.claude/CLAUDE.md',
      'first\n<!-- laurencio:local -->\nfirst local\n<!-- /laurencio:local -->\n',
    )
    expect((await runForTest(['init', '--yes'], options)).exitCode).toBe(0)
    const history = JSON.parse((await runForTest(['log', '--json'], options)).output) as {
      revisions: { id: string }[]
    }
    const first = history.revisions[0]?.id
    expect(first).toBeDefined()
    writeHomeFile(
      scratch.home,
      '.codex/config.toml',
      'model = "second"\nnotify = ["this-device"]\nfuture_setting = "keep me"\n',
    )
    writeHomeFile(
      scratch.home,
      '.claude/CLAUDE.md',
      'second\n<!-- laurencio:local -->\ncurrent local\n<!-- /laurencio:local -->\n',
    )
    const result = await runForTest(['restore', first as string, '--yes', '--json'], options)
    expect(result.exitCode, result.errorOutput).toBe(0)
    expect(parse(readHomeFile(scratch.home, '.codex/config.toml'))).toEqual({
      model: 'first',
      notify: ['this-device'],
      future_setting: 'keep me',
    })
    expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe(
      'first\n<!-- laurencio:local -->\ncurrent local\n<!-- /laurencio:local -->\n',
    )
  } finally {
    scratch.cleanup()
  }
})

test('a real two-device conflict resolves its portable copy without replacing machine settings', async () => {
  const first = makeScratch()
  const second = makeScratch()
  const a = { home: first.home, remoteDir: first.remoteDir, deps: { quiescence: { windowMs: 0 } } }
  const b = { home: second.home, remoteDir: first.remoteDir, deps: { quiescence: { windowMs: 0 } } }
  try {
    await seedStore(a)
    writeHomeFile(first.home, '.codex/config.toml', 'model = "base"\nnotify = ["this-device"]\n')
    expect((await runForTest(['init', '--yes'], a)).exitCode).toBe(0)
    await seedStore({ ...b, deviceName: 'other' })
    expect((await runForTest(['sync'], b)).exitCode).toBe(0)
    writeHomeFile(
      first.home,
      '.codex/config.toml',
      'model = "local"\nnotify = ["this-device"]\nfuture_setting = true\n',
    )
    writeHomeFile(
      second.home,
      '.codex/config.toml',
      'model = "remote"\nnotify = ["other-device"]\n',
    )
    expect((await runForTest(['sync'], b)).exitCode).toBe(0)
    const conflicted = await runForTest(['sync', '--json'], a)
    const report = JSON.parse(conflicted.output || conflicted.errorOutput) as {
      conflicts: string[]
    }
    expect(report.conflicts.length).toBe(1)
    const resolved = await runForTest(['resolve', '--keep-remote', '--json'], a)
    expect(resolved.exitCode, resolved.errorOutput).toBe(0)
    expect(parse(readHomeFile(first.home, '.codex/config.toml'))).toEqual({
      model: 'remote',
      notify: ['this-device'],
      future_setting: true,
    })
    expect(JSON.parse(resolved.output).remaining).toEqual([])
  } finally {
    first.cleanup()
    second.cleanup()
  }
})
