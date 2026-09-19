import { describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deriveMasterKey, kdfParamsToWire } from '../src/crypto/kdf'
import { sync } from '../src/engine'
import { createFileRemote } from '../src/remote/file'
import { SyncState, stateDbPath } from '../src/state'
import { testAdapter } from './helpers/adapter-fixtures'
import { buildFakeHome, type FakeHomeOptions } from './helpers/fake-home'
import {
  LOCK_DEVICE_HOLDER,
  LOCK_DEVICE_RACER,
  LOCK_DEVICE_SEED,
  LOCK_KDF,
  LOCK_STORE_ID,
  lockSurfaces,
} from './helpers/lock-child'

const CHILD_SCRIPT = path.resolve(import.meta.dir, 'helpers/lock-child.ts')
const CREATED_AT = '2026-01-01T00:00:00.000Z'

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-lock-'))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

function runChild(args: readonly string[]): {
  child: ChildProcess
  result: Promise<ChildResult>
} {
  const child = spawn(process.execPath, [CHILD_SCRIPT, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, result }
}

async function waitForMarker(marker: string, result: Promise<ChildResult>): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!fs.existsSync(marker)) {
    if (Date.now() > deadline) {
      const outcome = await Promise.race([result, Promise.resolve(null)])
      throw new Error(`holder never reached the apply hook: ${JSON.stringify(outcome)}`)
    }
    await sleep(20)
  }
}

function leftoverTemps(dir: string): string[] {
  const found: string[] = []
  const walk = (current: string): void => {
    for (const name of fs.readdirSync(current)) {
      const full = path.join(current, name)
      if (name.startsWith('.laurencio-')) found.push(full)
      if (fs.lstatSync(full).isDirectory()) walk(full)
    }
  }
  walk(dir)
  return found
}

const seedEntries: FakeHomeOptions['entries'] = [
  { kind: 'dir', path: '.claude' },
  { kind: 'file', path: '.claude/CLAUDE.md', content: '# shared rules\n' },
]

describe('cross-process sync lock', () => {
  test('one process holds the lock, the other exits busy, and no reconcile touches the holder', async () => {
    const remoteDir = tempDir()
    const seed = buildFakeHome({ entries: seedEntries })
    const seedState = SyncState.open({ path: stateDbPath(seed.home) })
    await sync({
      adapters: [testAdapter('claude', lockSurfaces())],
      ctx: seed.ctx,
      deviceId: LOCK_DEVICE_SEED,
      storeId: LOCK_STORE_ID,
      key: deriveMasterKey('lock-race', LOCK_KDF),
      state: seedState,
      remote: createFileRemote({
        dir: remoteDir,
        storeId: LOCK_STORE_ID,
        kdf: kdfParamsToWire(LOCK_KDF, CREATED_AT),
        now: () => new Date(CREATED_AT),
      }),
      quiescence: { windowMs: 0 },
    })
    seedState.close()
    seed.cleanup()

    // The holder home lacks the file the remote has, so its first plan writes.
    const home = buildFakeHome({ entries: [{ kind: 'dir', path: '.claude' }] })
    const marker = path.join(home.home, 'holding')
    const release = path.join(home.home, 'release')
    const holder = runChild([
      '--mode',
      'hold',
      '--home',
      home.home,
      '--remote',
      remoteDir,
      '--device',
      String(LOCK_DEVICE_HOLDER),
      '--marker',
      marker,
      '--release',
      release,
    ])
    await waitForMarker(marker, holder.result)

    // The holder is mid-apply: an intent row and a temp file exist right now.
    const during = SyncState.open({ path: stateDbPath(home.home) })
    const journal = during.listJournal()
    during.close()
    expect(journal.length).toBeGreaterThan(0)
    expect(journal.some((row) => row.state === 'intent')).toBe(true)
    const tempsDuring = leftoverTemps(home.home)
    expect(tempsDuring.length).toBeGreaterThan(0)

    const racer = await runChild([
      '--mode',
      'once',
      '--home',
      home.home,
      '--remote',
      remoteDir,
      '--device',
      String(LOCK_DEVICE_RACER),
    ]).result
    expect(racer.code).toBe(0)
    const racerReport = JSON.parse(racer.stdout) as { busy?: boolean; holder?: { pid: number } }
    expect(racerReport.busy).toBe(true)
    expect(racerReport.holder?.pid).toBe(holder.child.pid)

    // The loser must not have reconciled the winner's in-flight work.
    const still = SyncState.open({ path: stateDbPath(home.home) })
    expect(still.listJournal().length).toBe(journal.length)
    still.close()
    expect(leftoverTemps(home.home).length).toBe(tempsDuring.length)

    fs.writeFileSync(release, 'go')
    const finished = await holder.result
    expect(finished.code).toBe(0)
    expect((JSON.parse(finished.stdout) as { ok?: boolean }).ok).toBe(true)

    const after = SyncState.open({ path: stateDbPath(home.home) })
    expect(after.listJournal()).toEqual([])
    after.close()
    expect(leftoverTemps(home.home)).toEqual([])
    expect(fs.existsSync(marker)).toBe(true)
    home.cleanup()
    fs.rmSync(remoteDir, { recursive: true, force: true })
  }, 30_000)
})
