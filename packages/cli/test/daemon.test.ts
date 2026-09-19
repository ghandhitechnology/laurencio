import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createFileRemote,
  type FileSurface,
  type HarnessAdapter,
  LockHeldError,
  SyncLoop,
  type SyncRunResult,
  SyncState,
} from '@laurencio/core'
import { SurfaceId } from '@laurencio/protocol'
import { nextBackoffMs, shouldBackoff } from '../src/daemon/backoff'
import { eventWakesSync, parseHarnessEvent } from '../src/daemon/events'
import {
  acquireDaemonLock,
  daemonLockPath,
  liveDaemonLock,
  readDaemonLock,
  releaseDaemonLock,
} from '../src/daemon/lock'
import { DaemonRuntime } from '../src/daemon/runtime'
import { readDaemonState } from '../src/daemon/state'
import { surfaceWatchRoots } from '../src/daemon/watcher'
import { clearPause, writePause } from '../src/pause'
import { DEVICE_ID, makeScratch, NOW, STORE_ID, seedStore, writeHomeFile } from './helpers'

function idleResult(): SyncRunResult {
  return {
    status: 'idle',
    report: null,
    queue: { replayed: [], failed: [], pending: 0, offline: false },
    error: null,
    finishedAt: new Date().toISOString(),
  }
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await condition()) return
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await Bun.sleep(25)
  }
}

describe('daemon lock', () => {
  test('admits one live holder, replaces stale owners, and releases by owner', () => {
    const scratch = makeScratch()
    try {
      const lockPath = daemonLockPath(scratch.home)
      const holder = acquireDaemonLock(scratch.home, {
        pid: 4242,
        startedAt: NOW,
        processStart: () => NOW,
      })
      expect(readDaemonLock(scratch.home)).toEqual(holder)

      // A live owner with a matching process start time holds the lock.
      expect(() =>
        acquireDaemonLock(scratch.home, {
          pid: 4243,
          startedAt: NOW,
          isAlive: () => true,
          processStart: () => NOW,
        }),
      ).toThrow(LockHeldError)
      expect(
        liveDaemonLock(scratch.home, { isAlive: () => true, processStart: () => NOW }),
      ).toEqual(holder)

      // Dead owner: replaced.
      const afterDeath = acquireDaemonLock(scratch.home, {
        pid: 4244,
        startedAt: NOW,
        isAlive: () => false,
        processStart: () => NOW,
      })
      expect(afterDeath.pid).toBe(4244)

      // PID reuse: the process is alive but started at a different time.
      const afterReuse = acquireDaemonLock(scratch.home, {
        pid: 4245,
        startedAt: NOW,
        isAlive: () => true,
        processStart: () => '2026-09-19T13:00:00.000Z',
      })
      expect(afterReuse.pid).toBe(4245)

      expect(releaseDaemonLock(scratch.home, 999)).toBe(false)
      expect(readDaemonLock(scratch.home)).toEqual(afterReuse)
      expect(releaseDaemonLock(scratch.home, afterReuse.pid, afterReuse)).toBe(true)
      expect(fs.existsSync(lockPath)).toBe(false)
    } finally {
      scratch.cleanup()
    }
  })
})

describe('daemon backoff', () => {
  test('doubles per failure and stops at the ceiling', () => {
    expect(nextBackoffMs(1)).toBe(5_000)
    expect(nextBackoffMs(2)).toBe(10_000)
    expect(nextBackoffMs(3)).toBe(20_000)
    expect(nextBackoffMs(4, { baseMs: 100, maxMs: 500 })).toBe(500)
    expect(nextBackoffMs(40, { baseMs: 1_000, maxMs: 60_000 })).toBe(60_000)
    expect(nextBackoffMs(0)).toBe(5_000)
  })

  test('only failures and offline runs back off', () => {
    expect(shouldBackoff('failed')).toBe(true)
    expect(shouldBackoff('offline')).toBe(true)
    expect(shouldBackoff('synced')).toBe(false)
    expect(shouldBackoff('idle')).toBe(false)
  })
})

describe('daemon watchers', () => {
  test('resolves surface roots, skips never surfaces, and drops nested roots', () => {
    const scratch = makeScratch()
    try {
      fs.mkdirSync(path.join(scratch.home, '.claude', 'agents'), { recursive: true })
      fs.mkdirSync(path.join(scratch.home, '.config', 'opencode'), { recursive: true })
      const surface = (id: string, surfacePath: string, policy: FileSurface['policy']) => {
        const entry: FileSurface = {
          id: SurfaceId.parse(id),
          harness: 'claude',
          kind: 'file',
          path: surfacePath,
          policy,
          description: id,
          format: 'text',
          merge: 'text3way',
          transforms: [],
          secretRules: [],
        }
        return entry
      }
      const adapter: HarnessAdapter = {
        id: 'claude',
        displayName: 'test',
        detect: () => ({ installed: true, configRoots: [], notes: [] }),
        surfaces: () => [
          surface('claude.instructions', '$HOME/.claude/CLAUDE.md', 'sync'),
          surface('claude.agents', '$HOME/.claude/agents', 'sync'),
          surface('claude.memory', '$HOME/.claude/memory', 'never'),
          surface('claude.global', '$HOME/.claude.json', 'sync'),
          surface('opencode.config', '$HOME/.config/opencode/opencode.json', 'sync'),
        ],
      }
      const roots = surfaceWatchRoots([adapter], {
        home: scratch.home,
        platform: 'darwin',
        env: {},
      })
      expect(roots).toEqual([
        path.join(scratch.home, '.claude'),
        path.join(scratch.home, '.config', 'opencode'),
      ])
      // Home itself is never watched: ~/.laurencio churn would loop the daemon.
      expect(roots).not.toContain(scratch.home)
    } finally {
      scratch.cleanup()
    }
  })
})

describe('daemon runtime', () => {
  test('skips syncs while paused and resumes after resume', async () => {
    const scratch = makeScratch()
    const state = SyncState.open({ home: scratch.home })
    try {
      writePause(scratch.home, { pausedAt: NOW, by: 'test' })
      const calls: string[] = []
      const runtime = DaemonRuntime.start({
        home: scratch.home,
        state,
        runner: {
          async runOnce() {
            calls.push('run')
            return idleResult()
          },
        },
        intervalMs: 25,
        pausedPollMs: 20,
      })
      await Bun.sleep(120)
      expect(calls.length).toBe(0)
      expect(readDaemonState(state)?.paused).toBe(true)

      // No wake call: the runtime re-checks the flag on its own paused poll.
      clearPause(scratch.home)
      await waitFor(async () => calls.length > 0, 2000)
      expect(readDaemonState(state)?.paused).toBe(false)
      await runtime.stop()
    } finally {
      state.close()
      scratch.cleanup()
    }
  })

  test('refuses a second runtime and clears the lock on stop', async () => {
    const scratch = makeScratch()
    const state = SyncState.open({ home: scratch.home })
    try {
      const runtime = DaemonRuntime.start({
        home: scratch.home,
        state,
        runner: { runOnce: async () => idleResult() },
        intervalMs: 50,
      })
      expect(() =>
        DaemonRuntime.start({
          home: scratch.home,
          state,
          runner: { runOnce: async () => idleResult() },
          intervalMs: 50,
        }),
      ).toThrow(LockHeldError)
      await runtime.stop()
      expect(readDaemonLock(scratch.home)).toBeNull()
    } finally {
      state.close()
      scratch.cleanup()
    }
  })
})

describe('harness events', () => {
  test('parses session events, and only a finished session wakes a sync', () => {
    const stop = parseHarnessEvent({
      harness: 'claude',
      kind: 'session-stop',
      at: NOW,
      sessionId: 'abc',
    })
    expect(stop).toEqual({ harness: 'claude', kind: 'session-stop', at: NOW, sessionId: 'abc' })
    expect(stop === null ? false : eventWakesSync(stop)).toBe(true)

    const start = parseHarnessEvent({ harness: 'codex', kind: 'session-start', at: NOW })
    expect(start?.sessionId).toBeNull()
    expect(start === null ? true : eventWakesSync(start)).toBe(false)

    expect(parseHarnessEvent({ harness: 'nope', kind: 'session-stop', at: NOW })).toBeNull()
    expect(parseHarnessEvent('not an object')).toBeNull()
  })
})

describe('daemon end to end', () => {
  test('syncs a watched edit within the interval against a FileRemote', async () => {
    const scratch = makeScratch()
    const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
    writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n')
    const state = SyncState.open({ home: scratch.home })
    const remote = createFileRemote({ dir: scratch.remoteDir })
    const surface: FileSurface = {
      id: SurfaceId.parse('claude.instructions'),
      harness: 'claude',
      kind: 'file',
      path: '$HOME/.claude/CLAUDE.md',
      policy: 'sync',
      description: 'test instructions',
      format: 'markdown',
      merge: 'text3way',
      transforms: [],
      secretRules: [],
    }
    const adapter: HarnessAdapter = {
      id: 'claude',
      displayName: 'test',
      detect: () => ({ installed: true, configRoots: [], notes: [] }),
      surfaces: () => [surface],
    }
    const loop = new SyncLoop({
      adapters: [adapter],
      ctx: { home: scratch.home, platform: 'darwin', env: {} },
      deviceId: DEVICE_ID,
      storeId: STORE_ID,
      key: seeded.key,
      state,
      remote,
      quiescence: { windowMs: 0 },
    })
    const statuses: string[] = []
    const runner = {
      async runOnce() {
        const result = await loop.runOnce()
        statuses.push(result.status)
        return result
      },
    }
    const runtime = DaemonRuntime.start({
      home: scratch.home,
      state,
      runner,
      intervalMs: 3000,
      debounceMs: 25,
      watchRoots: [path.join(scratch.home, '.claude')],
    })
    try {
      await waitFor(async () => (await remote.listRevisions()).revisions.length >= 1)
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nEdited.\n')
      await waitFor(async () => (await remote.listRevisions()).revisions.length >= 2)
      await waitFor(async () => statuses.filter((status) => status === 'synced').length >= 2)
      const record = readDaemonState(state)
      expect(record?.lastResult).not.toBeNull()
      expect(record?.paused).toBe(false)
      expect(record?.pid).toBe(runtime.state.pid)
    } finally {
      await runtime.stop()
      state.close()
      scratch.cleanup()
    }
  })
})
