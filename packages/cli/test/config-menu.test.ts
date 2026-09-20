import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { runCli } from '../src/cli'
import { readPause } from '../src/pause'
import type { CliIo } from '../src/ui'
import { makeScratch, scriptedIo } from './helpers'

function menuIo(answers: string[]): CliIo & { output: string[] } {
  const io = scriptedIo(answers)
  return {
    ...io,
    terminal: { write: () => {}, columns: () => 80, onInterrupt: () => () => {} },
  }
}

test('menu uses blue accents only when terminal color is enabled', async () => {
  const scratch = makeScratch()
  try {
    for (const color of [true, false]) {
      const io = menuIo(['1', 'q'])
      if (io.terminal) io.terminal.color = color
      const result = await runCli(['config'], {
        home: scratch.home,
        platform: 'darwin',
        env: {},
        io,
      })
      expect(result.exitCode).toBe(0)
      expect(io.output.join('\n').includes('\x1b[1;94m')).toBe(color)
    }
    for (const flag of ['--json', '--yes']) {
      const io = menuIo([])
      if (io.terminal) io.terminal.color = true
      const result = await runCli(['config', flag], {
        home: scratch.home,
        platform: 'darwin',
        env: {},
        io,
      })
      expect(result.output).not.toContain('\x1b[')
    }
  } finally {
    scratch.cleanup()
  }
})

test('config catalog works offline without prompts, credentials, cleanup, or writes', async () => {
  const scratch = makeScratch()
  try {
    for (const flags of [[], ['--json'], ['--yes']]) {
      const io = menuIo([])
      if (flags.length === 0) delete io.terminal
      io.readLine = async () => {
        throw new Error('unexpected prompt')
      }
      io.readSecret = async () => {
        throw new Error('unexpected credential prompt')
      }
      const result = await runCli(['config', ...flags], {
        home: scratch.home,
        platform: 'darwin',
        env: {},
        io,
        fetch: Object.assign(
          async () => {
            throw new Error('unexpected network')
          },
          {
            preconnect: () => {
              throw new Error('unexpected network')
            },
          },
        ),
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('restore')
      expect(result.output).toContain('sync')
      if (flags.includes('--json')) expect(() => JSON.parse(result.output)).not.toThrow()
      expect(fs.readdirSync(scratch.home)).toEqual([])
    }
  } finally {
    scratch.cleanup()
  }
})

test('invalid menu input retries and blank exits without taking an action', async () => {
  const scratch = makeScratch()
  try {
    const io = menuIo(['invalid-choice', ''])
    const result = await runCli(['config'], { home: scratch.home, platform: 'darwin', env: {}, io })
    expect(result.exitCode).toBe(0)
    expect(io.output.join('\n')).toContain('Skills')
    expect(io.output.join('\n')).toContain('History')
    expect(fs.readdirSync(scratch.home)).toEqual([])
  } finally {
    scratch.cleanup()
  }
})

test('bare launcher opens config with the requested home and prints its menu before asking', async () => {
  const scratch = makeScratch()
  try {
    const io = menuIo(['c', 'q'])
    const result = await runCli(['--home', scratch.home], { platform: 'darwin', env: {}, io })
    expect(result.exitCode).toBe(0)
    expect(io.output.join('\n')).toContain('Manage configuration')
    expect(io.output.join('\n')).toContain('Skills')
    expect(fs.readdirSync(scratch.home)).toEqual([])
  } finally {
    scratch.cleanup()
  }
})

test('background sync can be paused and resumed through the settings menu', async () => {
  const scratch = makeScratch()
  try {
    const io = menuIo(['5', '5', 'b', 'q'])
    const result = await runCli(['config'], { home: scratch.home, platform: 'darwin', env: {}, io })
    expect(result.exitCode).toBe(0)
    expect(readPause(scratch.home)).not.toBeNull()
    expect(io.output.join('\n')).toContain('laurencio pause')
    const resumed = await runCli(['config'], {
      home: scratch.home,
      platform: 'darwin',
      env: {},
      io: menuIo(['5', '6', 'b', 'q']),
    })
    expect(resumed.exitCode).toBe(0)
    expect(readPause(scratch.home)).toBeNull()
  } finally {
    scratch.cleanup()
  }
})

test('canceling a restore selector never restores the whole profile', async () => {
  const scratch = makeScratch()
  try {
    const io = menuIo(['3', '2', 'some-revision', '', 'b', 'q'])
    const result = await runCli(['config'], { home: scratch.home, platform: 'darwin', env: {}, io })
    expect(result.exitCode).toBe(0)
    expect(io.output.join('\n')).not.toContain('$ laurencio restore')
    expect(fs.readdirSync(scratch.home)).toEqual([])
  } finally {
    scratch.cleanup()
  }
})

test('failed actions return to the menu and allow another action', async () => {
  const scratch = makeScratch()
  try {
    const io = menuIo(['3', '1', 'b', '5', '5', 'q'])
    const result = await runCli(['config'], {
      home: scratch.home,
      platform: 'darwin',
      env: {},
      io,
      keychain: null,
    })
    expect(result.exitCode).toBe(0)
    expect(io.output.join('\n')).toContain('laurencio log')
    expect(io.output.join('\n')).toContain('laurencio pause')
    expect(readPause(scratch.home)).not.toBeNull()
  } finally {
    scratch.cleanup()
  }
})

test('temporary workbench menu directs saves to the host and blocks full-mode mutations', async () => {
  const scratch = makeScratch()
  const record = path.join(path.dirname(scratch.home), 'runtime-session.json')
  try {
    fs.writeFileSync(record, JSON.stringify({ id: 'test-session', home: scratch.home }))
    const io = menuIo(['5', '5', 'q'])
    const result = await runCli(['config'], { home: scratch.home, platform: 'darwin', env: {}, io })
    expect(result.exitCode).toBe(0)
    expect(io.output.join('\n')).toContain('host terminal')
    expect(io.output.join('\n')).toContain('laurencio save test-session')
    expect(readPause(scratch.home)).toBeNull()
    expect(fs.readdirSync(scratch.home)).toEqual([])
  } finally {
    scratch.cleanup()
  }
})
