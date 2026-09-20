import { describe, expect, test } from 'bun:test'
import type { SyncProgress, SyncRunResult } from '@laurencio/core'
import { createTransferProgress } from '../src/progress'
import type { CliIo } from '../src/ui'

function fixture() {
  const writes: string[] = []
  let time = 0
  let interval: (() => void) | null = null
  let interrupt: (() => void) | null = null
  const io: CliIo = {
    out() {},
    err() {},
    async readLine() {
      return ''
    },
    async readSecret() {
      return ''
    },
    terminal: {
      write: (text) => {
        writes.push(text)
      },
      columns: () => 120,
      onInterrupt(cleanup) {
        interrupt = cleanup
        return () => {
          interrupt = null
        }
      },
    },
  }
  const timing = {
    now: () => time,
    every(callback: () => void) {
      interval = callback
      return () => {
        interval = null
      }
    },
  }
  return {
    io,
    timing,
    writes,
    tick(ms: number) {
      time += ms
      interval?.()
    },
    interrupt() {
      interrupt?.()
    },
    active: () => interval !== null || interrupt !== null,
  }
}

const upload: SyncProgress = {
  phase: 'uploading',
  completed: 0,
  planned: 20,
  uploaded: 0,
  downloaded: 0,
  uploadedBytes: 0,
  downloadedBytes: 0,
}
const idle: SyncRunResult = {
  status: 'idle',
  report: null,
  error: null,
  finishedAt: '',
  queue: { replayed: [], failed: [], pending: 0, offline: false },
}

describe('transfer progress', () => {
  test('animates while a request is pending and estimates only after measured progress', () => {
    const f = fixture()
    const progress = createTransferProgress(f.io, false, f.timing)
    progress.update(upload)
    f.tick(90)
    const initial = f.writes.at(-1)
    f.tick(90)
    expect(f.writes.at(-1)).not.toBe(initial)
    expect(f.writes.at(-1)).not.toContain('left')
    f.tick(2820)
    progress.update({ ...upload, completed: 5, uploaded: 5, uploadedBytes: 30_720 })
    f.tick(90)
    expect(f.writes.at(-1)).toContain('5/20')
    expect(f.writes.at(-1)).toContain('KB/s')
    expect(f.writes.at(-1)).toContain('~9s left')
    progress.finish(idle)
    expect(f.writes.at(-1)).toContain('Already up to date')
    expect(f.active()).toBe(false)
    const count = f.writes.length
    f.tick(1000)
    progress.update(upload)
    progress.finish()
    expect(f.writes).toHaveLength(count)
  })

  test('cleans up on errors and interrupt without claiming success', () => {
    for (const interrupted of [false, true]) {
      const f = fixture()
      const progress = createTransferProgress(f.io, false, f.timing)
      if (interrupted) f.interrupt()
      else progress.finish()
      expect(f.active()).toBe(false)
      expect(f.writes.at(-1)).toBe('\r\u001b[2K')
    }
  })

  test('JSON and non-TTY output never animate, emit escapes, or register timers', () => {
    for (const json of [false, true]) {
      const f = fixture()
      if (!json) delete f.io.terminal
      const progress = createTransferProgress(f.io, json, f.timing)
      progress.update(upload)
      f.tick(4000)
      progress.finish(idle)
      expect(f.active()).toBe(false)
      expect(f.writes).toEqual([])
    }
  })

  test('throttles bursts and fits narrow terminals without wrapping', () => {
    const f = fixture()
    if (f.io.terminal !== undefined) f.io.terminal.columns = () => 24
    const progress = createTransferProgress(f.io, false, f.timing)
    for (let i = 0; i < 1000; i++) progress.update(upload)
    expect(f.writes).toHaveLength(1)
    f.tick(100)
    expect(f.writes.at(-1)?.replace('\r\u001b[2K', '').length).toBeLessThan(24)
    progress.finish()
  })
})
