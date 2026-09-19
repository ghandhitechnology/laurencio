/**
 * The two-home convergence harness. Builds two fake HOMEs and a FileRemote,
 * syncs them in a deterministic order, and asserts every invariant phase 9
 * promises: convergence, idempotence, marker round-trip, conflict copies,
 * secret blocking, symlink preservation, tombstones, and crash recovery with
 * a real SIGKILL mid-apply followed by a rerun.
 *
 * Run: bun run e2e:two-home
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { open } from '../packages/core/src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../packages/core/src/crypto/kdf'
import { type SyncOptions, sync } from '../packages/core/src/engine'
import type { Manifest, SyncReport } from '../packages/core/src/model'
import { createFileRemote, type FileRemote } from '../packages/core/src/remote/file'
import { SyncState, stateDbPath } from '../packages/core/src/state'
import type { Surface } from '../packages/core/src/types'
import { file, testAdapter, tree } from '../packages/core/test/helpers/adapter-fixtures'
import {
  buildFakeHome,
  type FakeHome,
  type FakeHomeOptions,
} from '../packages/core/test/helpers/fake-home'
import { DeviceId, RevisionId, StoreId } from '../packages/protocol/src/index'

const SCRIPT_PATH = path.resolve(import.meta.dir, 'two-home-e2e.ts')
const REMOTE_STORE_ID = StoreId.parse('00000000000000000000000900')
const DEVICE_A = DeviceId.parse('00000000000000000000000901')
const DEVICE_B = DeviceId.parse('00000000000000000000000902')
const PASSPHRASE = 'two-home-e2e-passphrase'
const NOW = '2026-09-19T16:39:12.000Z'
const KDF: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const KEY = deriveMasterKey(PASSPHRASE, KDF)
const MARKER_FILE = '.agents/skills/notes.md'

interface CrashChildArgs {
  home: string
  remoteDir: string
}

function crashChildArgs(argv: readonly string[]): CrashChildArgs | null {
  if (argv[0] !== '--crash-child') return null
  const home = argv[1]
  const remoteDir = argv[2]
  if (home === undefined || remoteDir === undefined) {
    throw new Error('--crash-child needs a home and a remote directory')
  }
  return { home, remoteDir }
}

function surfaces(): Surface[] {
  return [
    file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' }),
    file({
      id: 'claude.settings',
      path: '$HOME/.claude/settings.json',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
    }),
    tree({ id: 'claude.skills', path: '$HOME/.claude/skills' }),
    tree({
      id: 'claude.shared-skills',
      path: '$HOME/.agents/skills',
      transforms: [{ kind: 'markerBlocks' }],
    }),
  ]
}

function contextFor(home: string): SyncOptions['ctx'] {
  return { home, platform: 'darwin', env: {} }
}

function openRemote(remoteDir: string): FileRemote {
  return createFileRemote({
    dir: remoteDir,
    storeId: REMOTE_STORE_ID,
    kdf: kdfParamsToWire(KDF, NOW),
    now: () => new Date(NOW),
  })
}

async function runSync(
  home: string,
  remoteDir: string,
  deviceId: DeviceId,
  hooks?: SyncOptions['hooks'],
): Promise<SyncReport> {
  const state = SyncState.open({ path: stateDbPath(home) })
  try {
    return await sync({
      adapters: [testAdapter('claude', surfaces())],
      ctx: contextFor(home),
      deviceId,
      storeId: REMOTE_STORE_ID,
      key: KEY,
      state,
      remote: openRemote(remoteDir),
      quiescence: { windowMs: 0 },
      now: () => new Date(NOW),
      createRevisionId: () => nextRevisionId(),
      ...(hooks !== undefined ? { hooks } : {}),
    })
  } finally {
    state.close()
  }
}

let revisionCounter = 10
function nextRevisionId(): RevisionId {
  const value = String(revisionCounter++)
  return RevisionId.parse(value.padStart(26, '0'))
}

async function decryptHeadManifest(remote: FileRemote): Promise<Manifest> {
  const list = await remote.listRevisions()
  if (list.head === null) throw new Error('remote has no head revision')
  const bytes = await remote.getManifest(list.head)
  const text = new TextDecoder().decode(
    open(KEY, 'manifest', bytes, {
      storeId: REMOTE_STORE_ID,
      blobType: 'manifest',
      protocolVersion: 1,
    }),
  )
  return JSON.parse(text) as Manifest
}

function readRemoteBytes(remoteDir: string): string {
  const chunks: string[] = []
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      if (fs.statSync(full).isDirectory()) walk(full)
      else chunks.push(fs.readFileSync(full, 'latin1'))
    }
  }
  walk(remoteDir)
  return chunks.join('\n')
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-two-home-'))
}

function snapshots(home: FakeHome): Map<string, number> {
  const map = new Map<string, number>()
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      const stat = fs.lstatSync(full)
      if (stat.isDirectory()) walk(full)
      else if (stat.isFile()) map.set(path.relative(home.home, full), stat.mtimeMs)
    }
  }
  walk(home.path('.claude'))
  walk(home.path('.agents'))
  return map
}

function leftovers(dir: string): string[] {
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

let failures = 0
let stepNumber = 0

function step(label: string): void {
  stepNumber += 1
  console.log(`\n[${String(stepNumber).padStart(2, '0')}] ${label}`)
}

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ok   ${label}${detail === undefined ? '' : ` (${detail})`}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` (${detail})`}`)
}

function sharedLayout(): FakeHomeOptions['entries'] {
  return [
    { kind: 'dir', path: '.claude' },
    { kind: 'dir', path: '.agents/skills' },
    { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
    { kind: 'file', path: '.claude/CLAUDE.md', content: '# shared rules\n' },
  ]
}

async function main(): Promise<void> {
  const remoteDir = tempDir()
  const a = buildFakeHome({
    entries: [
      ...sharedLayout(),
      {
        kind: 'file',
        path: '.claude/settings.json',
        content: '{\n  "model": "opus",\n  "theme": "dark"\n}\n',
      },
      {
        kind: 'file',
        path: MARKER_FILE,
        content:
          '# Notes\n<!-- laurencio:local -->\nA local secret\n<!-- /laurencio:local -->\nshared line\n',
      },
      { kind: 'dir', path: '.agents/skills/foo' },
      { kind: 'file', path: '.agents/skills/foo/SKILL.md', content: '# foo v1\n' },
    ],
  })
  const b = buildFakeHome({
    entries: [
      ...sharedLayout(),
      {
        kind: 'file',
        path: '.claude/settings.json',
        content: '{\n  "model": "opus",\n  "theme": "light"\n}\n',
      },
      { kind: 'dir', path: '.agents/skills/bar' },
      { kind: 'file', path: '.agents/skills/bar/SKILL.md', content: '# bar\n' },
    ],
  })

  console.log('two-home e2e: file remote, encrypted, crash-safe')
  console.log(`  remote: ${remoteDir}`)
  console.log(`  home A: ${a.home}`)
  console.log(`  home B: ${b.home}`)

  try {
    step('sync A: upload the base')
    const first = await runSync(a.home, remoteDir, DEVICE_A)
    const remote = openRemote(remoteDir)
    const head1 = await decryptHeadManifest(remote)
    check('revision committed', first.revisionId !== null, String(first.revisionId))
    check('claude.instructions uploaded', first.changed.includes('$HOME/.claude/CLAUDE.md'))
    check(
      'settings uploaded',
      head1.entries.some((entry) => entry.path === '$HOME/.claude/settings.json'),
    )
    check(
      'notes projection uploaded',
      head1.entries.some((entry) => entry.path.endsWith('notes.md')),
    )
    check(
      'remote never sees the local marker body',
      !readRemoteBytes(remoteDir).includes('A local secret'),
    )
    check('remote never sees plaintext', !readRemoteBytes(remoteDir).includes('# shared rules'))

    step('sync B: merge the other device in')
    const second = await runSync(b.home, remoteDir, DEVICE_B)
    check('B committed its own revision', second.revisionId !== null)
    check(
      'B downloaded the notes projection',
      b.read('.agents/skills/notes.md').includes('<!-- laurencio:local -->'),
    )
    check(
      'B did not download the secret',
      !b.read('.agents/skills/notes.md').includes('A local secret'),
    )
    check('B kept its settings edit', b.read('.claude/settings.json').includes('"theme": "light"'))
    check('B link is still a symlink', fs.lstatSync(b.path('.claude/skills')).isSymbolicLink())

    step('sync A: converge')
    await runSync(a.home, remoteDir, DEVICE_A)
    check('A sees the B skill', a.read('.agents/skills/bar/SKILL.md') === '# bar\n')
    check('A sees the B settings', a.read('.claude/settings.json').includes('"theme": "light"'))
    check('A kept its marker body', a.read(MARKER_FILE).includes('A local secret'))
    check('A link is still a symlink', fs.lstatSync(a.path('.claude/skills')).isSymbolicLink())
    const revisionsAfterConvergence = (await remote.listRevisions()).revisions.length
    check(
      'two revisions, no runaway commits',
      revisionsAfterConvergence === 2,
      String(revisionsAfterConvergence),
    )

    step('idempotence: a second run writes nothing')
    const before = snapshots(a)
    const idle = await runSync(a.home, remoteDir, DEVICE_A)
    const after = snapshots(a)
    check(
      'no changes reported',
      idle.changed.length === 0 && idle.uploaded === 0 && idle.downloaded === 0,
    )
    check(
      'no file mtimes moved',
      before.size === after.size && [...before].every(([file, mtime]) => after.get(file) === mtime),
    )
    check(
      'no new revisions',
      (await remote.listRevisions()).revisions.length === revisionsAfterConvergence,
    )

    step('marker round-trip: B writes its own block')
    const bNotes = b.read(MARKER_FILE)
    b.write(
      MARKER_FILE,
      bNotes.replace(
        '<!-- laurencio:local -->\n<!-- /laurencio:local -->',
        '<!-- laurencio:local -->\nB local secret\n<!-- /laurencio:local -->',
      ),
    )
    await runSync(b.home, remoteDir, DEVICE_B)
    check(
      'remote never sees the B marker body',
      !readRemoteBytes(remoteDir).includes('B local secret'),
    )
    await runSync(a.home, remoteDir, DEVICE_A)
    check(
      'A keeps only its own block',
      a.read(MARKER_FILE).includes('A local secret') &&
        !a.read(MARKER_FILE).includes('B local secret'),
    )
    check(
      'B keeps only its own block',
      b.read(MARKER_FILE).includes('B local secret') &&
        !b.read(MARKER_FILE).includes('A local secret'),
    )

    step('conflict: both sides rewrite the same line')
    a.write('.claude/CLAUDE.md', '# shared rules\nA rewrote this line\n')
    await runSync(a.home, remoteDir, DEVICE_A)
    b.write('.claude/CLAUDE.md', '# shared rules\nB rewrote this line\n')
    const conflicted = await runSync(b.home, remoteDir, DEVICE_B)
    const copies = fs.readdirSync(b.path('.claude')).filter((name) => name.includes('.conflict-'))
    check('one conflict copy written', conflicted.conflicts.length === 1 && copies.length === 1)
    const copyPath = conflicted.conflicts[0]?.path
    check(
      'copy holds the remote side',
      copyPath !== undefined && fs.readFileSync(copyPath, 'utf8').includes('A rewrote'),
    )
    check('B keeps its local side', b.read('.claude/CLAUDE.md').includes('B rewrote'))
    const copyRun = await runSync(b.home, remoteDir, DEVICE_B)
    check(
      'copy is excluded from the next run',
      copyRun.conflicts.length === 0 && copyRun.changed.length === 0,
    )
    check(
      'copy never enters a manifest',
      !(await decryptHeadManifest(openRemote(remoteDir))).entries.some((entry) =>
        entry.path.includes('.conflict-'),
      ),
    )

    step('secret blocking')
    b.write('.agents/skills/creds.md', 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n')
    const blocked = await runSync(b.home, remoteDir, DEVICE_B)
    check('secret path blocked', blocked.blocked.includes('$HOME/.agents/skills/creds.md'))
    check(
      'secret never reached the store',
      !readRemoteBytes(remoteDir).includes('ghp_abcdefghijklmnopqrstuvwxyz0123456789'),
    )
    check('local file survives', fs.existsSync(b.path('.agents/skills/creds.md')))

    step('tombstones travel')
    fs.rmSync(a.path('.agents/skills/foo/SKILL.md'))
    fs.rmdirSync(a.path('.agents/skills/foo'))
    await runSync(a.home, remoteDir, DEVICE_A)
    const tombstoneManifest = await decryptHeadManifest(openRemote(remoteDir))
    check(
      'remote records a tombstone',
      tombstoneManifest.entries.some(
        (entry) => entry.path.endsWith('foo/SKILL.md') && entry.kind === 'tombstone',
      ),
    )
    await runSync(b.home, remoteDir, DEVICE_B)
    check('B deleted the removed file', !fs.existsSync(b.path('.agents/skills/foo/SKILL.md')))

    step('crash recovery: SIGKILL mid-apply, then rerun')
    a.write('.claude/settings.json', '{\n  "model": "sonnet",\n  "theme": "light"\n}\n')
    await runSync(a.home, remoteDir, DEVICE_A)
    b.write('.claude/settings.json', '{\n  "model": "opus",\n  "theme": "solarized"\n}\n')
    const revisionsBeforeCrash = (await remote.listRevisions()).revisions.length
    const child = spawnSync(process.execPath, [SCRIPT_PATH, '--crash-child', b.home, remoteDir], {
      stdio: 'inherit',
    })
    check('child died by SIGKILL', child.signal === 'SIGKILL', String(child.signal ?? child.status))
    const crashedState = SyncState.open({ path: stateDbPath(b.home) })
    const journalRows = crashedState.listJournal().length
    const lockPath = path.join(b.home, '.laurencio', 'state.lock')
    crashedState.close()
    check('crash left an intent row', journalRows >= 1, String(journalRows))
    check('crash left the pid lock', fs.existsSync(lockPath))
    const leftoverTemps = leftovers(b.path('.claude')).length + leftovers(b.path('.agents')).length
    check('crash left an intent to repair', leftoverTemps >= 1, String(leftoverTemps))

    const recovered = await runSync(b.home, remoteDir, DEVICE_B)
    check('rerun converged the merge', recovered.changed.includes('$HOME/.claude/settings.json'))
    check(
      'b settings merged both edits',
      b.read('.claude/settings.json').includes('"model": "sonnet"') &&
        b.read('.claude/settings.json').includes('"theme": "solarized"'),
    )
    check(
      'exactly one new revision after the crash',
      (await remote.listRevisions()).revisions.length === revisionsBeforeCrash + 1,
    )
    const repairedState = SyncState.open({ path: stateDbPath(b.home) })
    check('journal is empty after rerun', repairedState.listJournal().length === 0)
    repairedState.close()
    check('stale lock was cleared', !fs.existsSync(lockPath))
    check(
      'no temp or duplicate artifacts remain',
      leftovers(b.path('.claude')).length === 0 && leftovers(b.path('.agents')).length === 0,
    )
    const finalIdle = await runSync(b.home, remoteDir, DEVICE_B)
    check('post-crash run is idempotent', finalIdle.changed.length === 0)
    await runSync(a.home, remoteDir, DEVICE_A)
    check(
      'homes converge on the same settings',
      a.read('.claude/settings.json') === b.read('.claude/settings.json'),
    )
  } finally {
    a.cleanup()
    b.cleanup()
    fs.rmSync(remoteDir, { recursive: true, force: true })
  }

  const total = stepNumber
  console.log('')
  console.log(
    failures === 0
      ? `RESULT: all ${total} steps passed`
      : `RESULT: ${failures} failure(s) across ${total} steps`,
  )
  process.exit(failures === 0 ? 0 : 1)
}

async function crashChild(args: CrashChildArgs): Promise<never> {
  await runSync(args.home, args.remoteDir, DEVICE_B, {
    beforeRename: () => {
      process.kill(process.pid, 'SIGKILL')
    },
  })
  // Unreachable: the hook kills the process on the first write.
  throw new Error('crash injection did not fire')
}

const child = crashChildArgs(process.argv.slice(2))
if (child !== null) {
  crashChild(child).catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
} else {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
