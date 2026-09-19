/**
 * The daemon loop: one long-running process that syncs on the device cadence,
 * wakes early when a watched surface changes, backs off after failures, and
 * stays idle while paused. It owns the daemon lock and the daemon state record;
 * the merging and writing stays in the core sync loop.
 */

import {
  type DevicePolicy,
  defaultPolicy,
  type SyncRunResult,
  type SyncState,
} from '@laurencio/core'
import { readPause } from '../pause'
import { type BackoffOptions, nextBackoffMs, shouldBackoff } from './backoff'
import {
  acquireDaemonLock,
  type DaemonLockInfo,
  type DaemonLockOptions,
  releaseDaemonLock,
} from './lock'
import { type DaemonState, writeDaemonState } from './state'
import { type SurfaceWatcher, startSurfaceWatchers } from './watcher'

/** What the runtime needs from a runner; `SyncLoop` satisfies it as is. */
export interface SyncRunner {
  runOnce(): Promise<SyncRunResult>
}

export interface DaemonRuntimeOptions {
  home: string
  state: SyncState
  runner: SyncRunner
  policy?: DevicePolicy
  /** Test lever: overrides `policy.cadence.intervalSeconds`. */
  intervalMs?: number
  /** How often to re-check the pause flag while paused. */
  pausedPollMs?: number
  /** Resolved directories to watch. No watchers when omitted or empty. */
  watchRoots?: readonly string[]
  debounceMs?: number
  backoff?: BackoffOptions
  now?: () => Date
  log?: (line: string) => void
  /** External cancellation, for example a test's AbortController. */
  signal?: AbortSignal
  /** Test levers for the lock and the pause file. */
  lockOptions?: DaemonLockOptions
  readPaused?: (home: string) => boolean
  onError?: (message: string) => void
}

const MAX_TIMER_MS = 2_147_483_647
const DEFAULT_PAUSED_POLL_MS = 5_000

export class DaemonRuntime {
  readonly state: DaemonState
  #state: SyncState
  #runner: SyncRunner
  #policy: DevicePolicy
  #intervalMs: number
  #pausedPollMs: number
  #backoff: BackoffOptions
  #home: string
  #now: () => Date
  #log: (line: string) => void
  #readPaused: (home: string) => boolean
  #lock: DaemonLockInfo
  #controller: AbortController
  #done: Promise<void>
  #watcher: SurfaceWatcher | null = null
  #scheduleAt: number
  #notBefore = 0
  #failures = 0
  #lastSync: string | null = null
  #lastResult: DaemonState['lastResult'] = null
  #pendingWake = false
  #wakeResolve: (() => void) | null = null
  #lastPaused: boolean | null = null
  #stopped = false

  private constructor(options: DaemonRuntimeOptions, lock: DaemonLockInfo, startedAt: string) {
    this.#state = options.state
    this.#runner = options.runner
    this.#policy = options.policy ?? defaultPolicy()
    this.#intervalMs = options.intervalMs ?? this.#policy.cadence.intervalSeconds * 1000
    this.#pausedPollMs = options.pausedPollMs ?? DEFAULT_PAUSED_POLL_MS
    this.#backoff = options.backoff ?? {}
    this.#home = options.home
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? (() => {})
    this.#readPaused = options.readPaused ?? ((home) => readPause(home) !== null)
    this.#lock = lock
    this.#controller = new AbortController()
    this.state = {
      pid: lock.pid,
      startedAt,
      paused: false,
      lastSync: null,
      lastResult: null,
    }
    this.#scheduleAt = this.#now().getTime()
    this.#publish(false)
    this.#done = this.#runLoop()
  }

  /**
   * Takes the daemon lock and starts the loop. Throws `LockHeldError` when a
   * live daemon already owns this home.
   */
  static start(options: DaemonRuntimeOptions): DaemonRuntime {
    const lock = acquireDaemonLock(options.home, options.lockOptions ?? {})
    const startedAt = (options.now ?? (() => new Date()))().toISOString()
    const runtime = new DaemonRuntime(options, lock, startedAt)
    if (options.signal !== undefined) {
      const signal = options.signal
      if (signal.aborted) {
        runtime.stop().catch(() => {})
      } else {
        signal.addEventListener('abort', () => {
          runtime.stop().catch(() => {})
        })
      }
    }
    const roots = options.watchRoots ?? []
    if (roots.length > 0) {
      runtime.#watcher = startSurfaceWatchers({
        roots,
        ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
        onChange: () => {
          runtime.wake()
        },
        ...(options.onError === undefined ? {} : { onError: options.onError }),
      })
      runtime.#log(`watching ${roots.length} root${roots.length === 1 ? '' : 's'}`)
    }
    runtime.#log(`daemon started (pid ${lock.pid})`)
    return runtime
  }

  /** A sync attempt right now, coalesced with the periodic schedule. */
  wake(): void {
    if (this.#stopped) return
    if (this.#wakeResolve !== null) {
      const resolve = this.#wakeResolve
      this.#wakeResolve = null
      resolve()
      return
    }
    this.#pendingWake = true
  }

  whenDone(): Promise<void> {
    return this.#done
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#done
      return
    }
    this.#stopped = true
    this.#controller.abort()
    this.wake()
    await this.#done
    this.#watcher?.close()
    releaseDaemonLock(this.#home, this.#lock.pid, this.#lock)
    this.#log('daemon stopped')
  }

  #nowMs(): number {
    return this.#now().getTime()
  }

  #publish(paused: boolean): void {
    this.state.paused = paused
    this.state.lastSync = this.#lastSync
    this.state.lastResult = this.#lastResult
    writeDaemonState(this.#state, this.state)
  }

  async #runLoop(): Promise<void> {
    while (!this.#controller.signal.aborted) {
      const target = Math.max(this.#scheduleAt, this.#notBefore)
      const outcome = await this.#waitUntil(target)
      if (outcome === 'stop') return
      const nowMs = this.#nowMs()
      if (outcome === 'wake') this.#scheduleAt = nowMs - 1
      if (nowMs < Math.max(this.#scheduleAt, this.#notBefore)) continue
      await this.#tick()
      if (this.#pendingWake) {
        this.#pendingWake = false
        this.#scheduleAt = Math.min(this.#scheduleAt, this.#nowMs() - 1)
      }
    }
  }

  #waitUntil(target: number): Promise<'timeout' | 'wake' | 'stop'> {
    if (this.#controller.signal.aborted) return Promise.resolve('stop')
    const delay = Math.max(0, Math.min(target - this.#nowMs(), MAX_TIMER_MS))
    return new Promise((resolve) => {
      let settled = false
      const finish = (outcome: 'timeout' | 'wake' | 'stop'): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#controller.signal.removeEventListener('abort', onAbort)
        if (this.#wakeResolve === wake) this.#wakeResolve = null
        resolve(outcome)
      }
      const wake = (): void => finish('wake')
      const onAbort = (): void => finish('stop')
      const timer = setTimeout(() => finish('timeout'), delay)
      this.#wakeResolve = wake
      this.#controller.signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  async #tick(): Promise<void> {
    if (this.#readPaused(this.#home)) {
      // Poll the flag more often than the cadence so `resume` takes effect in
      // seconds, and publish the paused state only on the transition.
      if (this.#lastPaused !== true) {
        this.#publish(true)
        this.#log('paused, skipping sync')
      }
      this.#lastPaused = true
      this.#scheduleAt = this.#nowMs() + this.#pausedPollMs
      return
    }
    this.#lastPaused = false
    let result: SyncRunResult
    try {
      result = await this.#runner.runOnce()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#lastSync = this.#now().toISOString()
      this.#lastResult = 'failed'
      this.#failures += 1
      this.#notBefore = this.#nowMs() + nextBackoffMs(this.#failures, this.#backoff)
      this.#publish(false)
      this.#log(`sync crashed: ${message}`)
      this.#scheduleAt = this.#nowMs() + this.#intervalMs
      return
    }
    this.#lastSync = result.finishedAt
    this.#lastResult = result.status
    if (shouldBackoff(result.status)) {
      this.#failures += 1
      this.#notBefore = this.#nowMs() + nextBackoffMs(this.#failures, this.#backoff)
      this.#log(`sync ${result.status}: ${result.error?.message ?? 'no error detail'}`)
    } else {
      this.#failures = 0
      this.#notBefore = 0
      this.#log(`sync ${result.status}`)
    }
    this.#publish(false)
    this.#scheduleAt = this.#nowMs() + this.#intervalMs
  }
}
