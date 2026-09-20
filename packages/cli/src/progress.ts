import type { SyncProgress, SyncRunResult } from '@laurencio/core'
import type { CliIo } from './ui'

interface ProgressClock {
  now(): number
  every(callback: () => void, ms: number): () => void
}

const clock: ProgressClock = {
  now: () => Date.now(),
  every(callback, ms) {
    const timer = setInterval(callback, ms)
    timer.unref()
    return () => clearInterval(timer)
  },
}

const phases: Record<SyncProgress['phase'], string> = {
  scanning: 'Finding changes',
  comparing: 'Comparing devices',
  downloading: 'Bringing files here',
  merging: 'Combining changes',
  uploading: 'Sending your files',
  saving: 'Saving sync state',
}
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export type WorkbenchSetupPhase =
  | 'authorizing'
  | 'preparing'
  | 'syncing'
  | 'credentials'
  | 'tools'
  | 'launching'

const workbenchPhases: Record<WorkbenchSetupPhase, { index: number; label: string }> = {
  authorizing: { index: 1, label: 'Authorizing this session' },
  preparing: { index: 2, label: 'Creating private workspace' },
  syncing: { index: 3, label: 'Loading config and skills' },
  credentials: { index: 4, label: 'Unlocking selected credentials' },
  tools: { index: 5, label: 'Verifying tools' },
  launching: { index: 6, label: 'Starting terminal' },
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function bytes(value: number): string {
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

/** One setup line for the temporary workbench, including its nested file sync. */
export function createWorkbenchProgress(
  io: CliIo,
  json: boolean,
  timing: ProgressClock = clock,
): {
  phase(phase: WorkbenchSetupPhase): void
  sync(progress: SyncProgress): void
  pause(): void
  succeed(): void
  finish(): void
} {
  const terminal = json ? undefined : io.terminal
  if (terminal === undefined) {
    return { phase() {}, sync() {}, pause() {}, succeed() {}, finish() {} }
  }
  const started = timing.now()
  let current: WorkbenchSetupPhase | null = null
  let syncProgress: SyncProgress | null = null
  let frame = 0
  let visible = false
  let closed = false
  let lastDraw = -Infinity
  let detach = (): void => {}
  let stop = (): void => {}
  const write = (line: string, final = false): void => {
    const width = Math.max(1, terminal.columns() - 1)
    const text = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line
    const colored =
      terminal.color === true
        ? text.replace(
            /[\u280b\u2819\u2839\u2838\u283c\u2834\u2826\u2827\u2807\u280f━─✓]+/g,
            '\u001b[94m$&\u001b[0m',
          )
        : text
    terminal.write(`\r\u001b[2K${colored}${final ? '\n' : ''}`)
  }
  const draw = (): void => {
    if (closed || !visible || current === null) return
    lastDraw = timing.now()
    const { index, label } = workbenchPhases[current]
    const known = current === 'syncing' ? syncProgress : null
    const hasExactProgress = known?.planned !== null && (known?.planned ?? 0) > 0
    const ratio = hasExactProgress
      ? Math.min(1, (known?.completed ?? 0) / (known?.planned ?? 1))
      : 0
    const filled = Math.min(12, Math.floor(((index - 1 + ratio) / 6) * 12))
    const bar = `${'━'.repeat(filled)}${'─'.repeat(12 - filled)}`
    const indicator = `${frames[frame++ % frames.length]}  ${bar}`
    const syncDetail =
      known === null
        ? ''
        : `  ${phases[known.phase]}${hasExactProgress ? ` ${known.completed}/${known.planned}` : ''}`
    const transfers =
      known !== null && terminal.columns() >= 100
        ? `  ↑ ${known.uploaded}  ↓ ${known.downloaded}`
        : ''
    write(`${indicator}  ${index}/6  ${label}${syncDetail}${transfers}`)
  }
  const clear = (): void => {
    if (!visible) return
    visible = false
    terminal.write('\r\u001b[2K')
  }
  const finish = (): void => {
    if (closed) return
    closed = true
    stop()
    detach()
    clear()
  }
  stop = timing.every(draw, 90)
  detach = terminal.onInterrupt(finish)
  return {
    phase(phase) {
      if (closed) return
      current = phase
      syncProgress = null
      visible = true
      draw()
    },
    sync(progress) {
      if (closed) return
      const entering = current !== 'syncing' || syncProgress === null
      current = 'syncing'
      syncProgress = progress
      visible = true
      if (entering || timing.now() - lastDraw >= 90) draw()
    },
    pause: clear,
    succeed() {
      if (closed) return
      current = 'launching'
      visible = true
      closed = true
      stop()
      detach()
      const elapsed = duration(timing.now() - started)
      write(`✓  ${'━'.repeat(12)}  6/6  Temporary workbench ready  ${elapsed}`, true)
    },
    finish,
  }
}

/** One stderr line, independent of stdout results and disabled for JSON or pipes. */
export function createTransferProgress(
  io: CliIo,
  json: boolean,
  timing: ProgressClock = clock,
): { update(progress: SyncProgress): void; finish(result?: SyncRunResult): void } {
  const terminal = json ? undefined : io.terminal
  if (terminal === undefined) return { update() {}, finish() {} }
  const started = timing.now()
  let transferStarted: number | null = null
  let latest: SyncProgress | null = null
  let frame = 0
  let closed = false
  let lastDraw = -Infinity
  let detach = (): void => {}
  let stop = (): void => {}
  const write = (line: string, final = false): void => {
    const width = Math.max(1, terminal.columns() - 1)
    const text = line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line
    const colored =
      terminal.color === true ? text.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏━╸]+/g, '\u001b[36m$&\u001b[0m') : text
    terminal.write(`\r\u001b[2K${colored}${final ? '\n' : ''}`)
  }
  const draw = (): void => {
    if (closed) return
    const now = timing.now()
    lastDraw = now
    const progress = latest
    const parts = [phases[progress?.phase ?? 'scanning']]
    if (progress !== null && progress.planned !== null && progress.planned > 0) {
      const ratio = Math.min(1, progress.completed / progress.planned)
      // Leave room for the final save. Only a successful result completes the line.
      const filled = Math.min(11, Math.floor(ratio * 12))
      const bar = `${'━'.repeat(filled)}╸${'─'.repeat(11 - filled)}`
      parts.push(`${bar} ${progress.completed}/${progress.planned}`)
    }
    if (progress !== null && transferStarted !== null) {
      if (terminal.columns() >= 100) parts.push(`↑ ${progress.uploaded} ↓ ${progress.downloaded}`)
      const elapsed = now - transferStarted
      const count = progress.uploaded + progress.downloaded
      const transferred = progress.uploadedBytes + progress.downloadedBytes
      if (elapsed >= 1500 && transferred > 0)
        parts.push(`${bytes(transferred / (elapsed / 1000))}/s`)
      if (
        elapsed >= 2500 &&
        count >= 3 &&
        progress.completed >= 3 &&
        progress.planned !== null &&
        progress.completed < progress.planned &&
        progress.phase !== 'saving'
      ) {
        parts.push(
          `~${duration((elapsed * (progress.planned - progress.completed)) / progress.completed)} left`,
        )
      }
    }
    parts.push(duration(now - started))
    write(`${frames[frame++ % frames.length]}  ${parts.join('  ')}`)
  }
  const finish = (result?: SyncRunResult): void => {
    if (closed) return
    closed = true
    stop()
    detach()
    if (result === undefined) {
      write('')
      return
    }
    const report = result.report
    const needsAttention =
      (report?.blocked.length ?? 0) +
        (report?.conflicts.length ?? 0) +
        (report?.deferred.length ?? 0) >
      0
    const label =
      result.status === 'offline'
        ? 'Sync paused offline'
        : result.status === 'failed'
          ? 'Sync needs attention'
          : needsAttention
            ? 'Sync finished with items to review'
            : result.status === 'idle'
              ? 'Already up to date'
              : 'Sync complete'
    const transfers = report === null ? '' : `  ↑ ${report.uploaded}  ↓ ${report.downloaded}`
    write(`${label}${transfers}  ${duration(timing.now() - started)}`, true)
  }
  draw()
  stop = timing.every(draw, 90)
  detach = terminal.onInterrupt(() => finish())
  return {
    update(progress) {
      if (closed) return
      if (progress.phase === 'scanning') transferStarted = null
      latest = progress
      if (
        transferStarted === null &&
        ['uploading', 'downloading', 'merging'].includes(progress.phase)
      ) {
        transferStarted = timing.now()
      }
      // A fast batch can emit thousands of events; cap terminal writes at the animation rate.
      if (timing.now() - lastDraw >= 90) draw()
    },
    finish,
  }
}
