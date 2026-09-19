import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFLICT_LEDGER_META_KEY,
  ConflictLedger,
  conflictCopyPath,
  createFileRemote,
  crypto,
  parseManifest,
  SyncState,
} from '@laurencio/core'
import { DeviceId, PROTOCOL_VERSION } from '@laurencio/protocol'
import {
  makeScratch,
  memoryKeychain,
  NOW,
  PASSPHRASE,
  readHomeFile,
  runForTest,
  STORE_ID,
  seedStore,
  writeHomeFile,
} from './helpers'

const QUICK = { quiescence: { windowMs: 0 } }

describe('cli parsing', () => {
  test('prints version and help, and rejects unknown commands', async () => {
    const scratch = makeScratch()
    try {
      const version = await runForTest(['--version'], { home: scratch.home })
      expect(version.exitCode).toBe(0)
      expect(version.output).toBe('laurencio 0.1.0\n')

      const help = await runForTest(['--help'], { home: scratch.home })
      expect(help.exitCode).toBe(0)
      expect(help.output).toContain('Usage: laurencio <command> [options]')
      expect(help.output).toContain('resolve')

      const commandHelp = await runForTest(['diff', '--help'], { home: scratch.home })
      expect(commandHelp.exitCode).toBe(0)
      expect(commandHelp.output).toContain('Usage: laurencio diff')

      const unknown = await runForTest(['frobnicate'], { home: scratch.home })
      expect(unknown.exitCode).toBe(1)
      expect(unknown.errorOutput).toContain('unknown command: frobnicate')

      const badFlag = await runForTest(['status', '--nope'], { home: scratch.home })
      expect(badFlag.exitCode).toBe(1)
      expect(badFlag.errorOutput).toContain("Unknown option '--nope'")
    } finally {
      scratch.cleanup()
    }
  })

  test('init without a server exits clean on the offline path', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['init', '--server', 'http://127.0.0.1:1', '--yes'], {
        home: scratch.home,
      })
      expect(out.exitCode).toBe(0)
      expect(out.output).toContain('skipped, the server is not reachable')
      const config = readHomeFile(scratch.home, '.laurencio/config.toml')
      expect(config).toContain('server = "http://127.0.0.1:1"')
    } finally {
      scratch.cleanup()
    }
  })

  test('status on a device with no identity exits 1 with next steps', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['status'], { home: scratch.home })
      expect(out.exitCode).toBe(1)
      expect(out.errorOutput).toContain('not signed in')
    } finally {
      scratch.cleanup()
    }
  })
})

describe('init and sync', () => {
  test('init pushes local config and sync uploads later edits', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n')
      const init = await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(init.exitCode).toBe(0)
      expect(init.output).toContain('Sync synced')

      const remote = createFileRemote({ dir: scratch.remoteDir })
      const first = await remote.listRevisions()
      expect(first.head).not.toBeNull()
      expect(first.revisions.length).toBe(1)

      writeHomeFile(scratch.home, '.claude/CLAUDE.md', '# Instructions\n\nMore.\n')
      const dry = await runForTest(['sync', '--dry-run', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(dry.exitCode).toBe(0)
      const plan = JSON.parse(dry.output) as {
        plan: { files: { storePath: string; resolution: string }[] }
      }
      const upload = plan.plan.files.find((file) => file.storePath.endsWith('CLAUDE.md'))
      expect(upload?.resolution).toBe('upload')

      const sync = await runForTest(['sync'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(sync.exitCode).toBe(0)
      expect(sync.output).toContain('Sync synced')
      const second = await remote.listRevisions()
      expect(second.revisions.length).toBe(2)
    } finally {
      scratch.cleanup()
    }
  })

  test('sync --harness scopes the run', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'claude\n')
      writeHomeFile(scratch.home, '.codex/AGENTS.md', 'codex\n')
      const out = await runForTest(['sync', '--dry-run', '--harness', 'codex', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(out.exitCode).toBe(0)
      const plan = JSON.parse(out.output) as {
        plan: { files: { storePath: string; surfaceId: string }[] }
      }
      expect(plan.plan.files.length).toBeGreaterThan(0)
      expect(plan.plan.files.every((file) => file.surfaceId.startsWith('codex.'))).toBe(true)

      const bad = await runForTest(['sync', '--harness', 'nope'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(bad.exitCode).toBe(1)
      expect(bad.errorOutput).toContain('unknown harness')
    } finally {
      scratch.cleanup()
    }
  })

  test('status reports drift, conflicts, and the pause flag', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'one\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const clean = await runForTest(['status', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(clean.exitCode).toBe(0)
      const cleanData = JSON.parse(clean.output) as { drift: unknown[] }
      expect(cleanData.drift).toEqual([])

      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'two\n')
      const drifted = await runForTest(['status', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(drifted.exitCode).toBe(0)
      const driftedData = JSON.parse(drifted.output) as {
        drift: { status: string; storePath: string }[]
      }
      expect(driftedData.drift.some((entry) => entry.status === 'changed')).toBe(true)

      const pause = await runForTest(['pause'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(pause.exitCode).toBe(0)
      const paused = await runForTest(['status', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect((JSON.parse(paused.output) as { daemon: { paused: boolean } }).daemon.paused).toBe(
        true,
      )
      await runForTest(['resume'], { home: scratch.home, remoteDir: scratch.remoteDir })

      const state = SyncState.open({ home: scratch.home })
      const source = path.join(scratch.home, '.claude/CLAUDE.md')
      const copy = conflictCopyPath(source, 'other-device', NOW)
      fs.writeFileSync(copy, 'remote\n')
      const ledger = new ConflictLedger([
        { path: copy, sourcePath: source, device: 'other-device', createdAt: NOW },
      ])
      state.setMeta(CONFLICT_LEDGER_META_KEY, ledger.toJSON())
      state.close()
      const conflicted = await runForTest(['status'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(conflicted.exitCode).toBe(2)
      expect(conflicted.errorOutput).toContain('Conflicts: 1')
    } finally {
      scratch.cleanup()
    }
  })

  test('init enrollment replaces this device after a backup', async () => {
    const scratch = makeScratch()
    const other = makeScratch()
    try {
      // Device B publishes the remote content.
      await seedStore({ home: other.home, remoteDir: scratch.remoteDir, deviceName: 'other' })
      writeHomeFile(other.home, '.claude/CLAUDE.md', 'remote version\n')
      await runForTest(['init', '--yes'], {
        home: other.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      // Device A has a divergent local file and chooses replace.
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local version\n')
      const out = await runForTest(['init'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        answers: ['n', 'r'],
        deps: QUICK,
      })
      expect(out.exitCode).toBe(0)
      expect(out.output).toContain('Enrollment: claude.instructions r')
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('remote version\n')
      const backups = fs.readdirSync(path.join(scratch.home, '.laurencio/backups'))
      expect(backups.length).toBe(1)
      const firstBackup = backups[0]
      expect(firstBackup).toBeDefined()
      const backedUp = fs.readFileSync(
        path.join(scratch.home, '.laurencio/backups', firstBackup ?? '', '01-claude.instructions'),
        'utf8',
      )
      expect(backedUp).toBe('local version\n')
    } finally {
      scratch.cleanup()
      other.cleanup()
    }
  })

  test('init manual enrollment leaves the local file alone', async () => {
    const scratch = makeScratch()
    const other = makeScratch()
    try {
      await seedStore({ home: other.home, remoteDir: scratch.remoteDir, deviceName: 'other' })
      writeHomeFile(other.home, '.claude/CLAUDE.md', 'remote version\n')
      await runForTest(['init', '--yes'], {
        home: other.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local version\n')
      const out = await runForTest(['init'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        answers: ['n', 's'],
        deps: QUICK,
      })
      expect(out.exitCode).toBe(0)
      expect(out.output).toContain('Enrollment: claude.instructions s')
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('local version\n')
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const page = await remote.listRevisions()
      expect(page.revisions.length).toBe(2)
    } finally {
      scratch.cleanup()
      other.cleanup()
    }
  })

  test('the secret scan blocks an upload', async () => {
    const scratch = makeScratch()
    try {
      const seeded = await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(
        scratch.home,
        '.claude/CLAUDE.md',
        'key = sk-abcdefghijklmnopqrstuvwxyz012345\n',
      )
      const out = await runForTest(['sync', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as { blocked: string[] }
      expect(data.blocked.length).toBeGreaterThan(0)
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const page = await remote.listRevisions()
      expect(page.head).not.toBeNull()
      const head = page.head
      if (head === null) throw new Error('missing head')
      const bytes = await remote.getManifest(head)
      const manifest = parseManifest(
        JSON.parse(
          crypto.openText(seeded.key, 'manifest', bytes, {
            storeId: STORE_ID,
            blobType: 'manifest',
            protocolVersion: PROTOCOL_VERSION,
          }),
        ),
      )
      expect(manifest.entries.length).toBe(0)
    } finally {
      scratch.cleanup()
    }
  })
})

describe('diff, log, restore, export', () => {
  test('diff renders local against remote', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'base\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'changed\n')
      const out = await runForTest(['diff', 'claude.instructions'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(out.exitCode).toBe(0)
      expect(out.output).toContain('local-changed')
      expect(out.output).toContain('--- base')
      expect(out.output).toContain('+changed')

      const json = await runForTest(['diff', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const data = JSON.parse(json.output) as { entries: { status: string }[] }
      expect(data.entries.some((entry) => entry.status === 'local-changed')).toBe(true)
    } finally {
      scratch.cleanup()
    }
  })

  test('diff exits 2 when local and remote both diverged', async () => {
    const scratch = makeScratch()
    const other = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'base\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      // A second device pushes a remote edit.
      await seedStore({ home: other.home, remoteDir: scratch.remoteDir, deviceName: 'other' })
      await runForTest(['sync'], { home: other.home, remoteDir: scratch.remoteDir, deps: QUICK })
      writeHomeFile(other.home, '.claude/CLAUDE.md', 'remote\n')
      await runForTest(['sync'], { home: other.home, remoteDir: scratch.remoteDir, deps: QUICK })
      // The first device edits the same file without syncing.
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local\n')
      const out = await runForTest(['diff', 'claude.instructions'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(out.exitCode).toBe(2)
      expect(out.errorOutput).toContain('conflict')
    } finally {
      scratch.cleanup()
      other.cleanup()
    }
  })

  test('log lists revisions and restore brings a file back', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'first\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'second\n')
      await runForTest(['sync'], { home: scratch.home, remoteDir: scratch.remoteDir, deps: QUICK })

      const log = await runForTest(['log', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(log.exitCode).toBe(0)
      const history = JSON.parse(log.output) as { revisions: { id: string }[] }
      expect(history.revisions.length).toBe(2)
      const first: string | undefined = history.revisions[0]?.id
      expect(first).toBeDefined()

      const human = await runForTest(['log'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(human.output).toContain('REVISION')

      const restore = await runForTest(
        ['restore', first as string, 'claude.instructions', '--yes', '--json'],
        { home: scratch.home, remoteDir: scratch.remoteDir, deps: QUICK },
      )
      expect(restore.exitCode).toBe(0)
      const restored = JSON.parse(restore.output) as { restored: unknown[]; backup: string }
      expect(restored.restored.length).toBe(1)
      expect(restored.backup).not.toBeNull()
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('first\n')

      const denied = await runForTest(['restore', first as string, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(denied.exitCode).toBe(1)
      expect(denied.errorOutput).toContain('confirmation-required')

      const unknown = await runForTest(['restore', 'zzzzzzzz', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(unknown.exitCode).toBe(1)
      expect(unknown.errorOutput).toContain('no revision matches')
    } finally {
      scratch.cleanup()
    }
  })

  test('export writes an encrypted bundle and plaintext on request', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'export me\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const encryptedPath = path.join(scratch.home, 'bundle.json')
      const encrypted = await runForTest(['export', '--out', encryptedPath, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(encrypted.exitCode).toBe(0)
      const bundle = JSON.parse(fs.readFileSync(encryptedPath, 'utf8')) as {
        mode: string
        kdf: unknown
        files: { blob?: string; content?: string }[]
      }
      expect(bundle.mode).toBe('encrypted')
      expect(bundle.kdf).not.toBeNull()
      expect(bundle.files[0]?.blob).toBeDefined()
      expect(bundle.files[0]?.content).toBeUndefined()

      const plainPath = path.join(scratch.home, 'bundle-plain.json')
      const plain = await runForTest(['export', '--out', plainPath, '--plaintext'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(plain.exitCode).toBe(0)
      expect(plain.output).toContain('Plaintext bundle')
      const plainBundle = JSON.parse(fs.readFileSync(plainPath, 'utf8')) as {
        files: { content?: string }[]
      }
      expect(plainBundle.files.some((file) => file.content === 'export me\n')).toBe(true)

      const missingOut = await runForTest(['export'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      expect(missingOut.exitCode).toBe(1)
      expect(missingOut.errorOutput).toContain('export needs --out')
    } finally {
      scratch.cleanup()
    }
  })
})

describe('devices and resolve', () => {
  test('devices lists, renames, and revokes', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const remote = createFileRemote({ dir: scratch.remoteDir })
      remote.upsertDevice({
        id: DeviceId.parse('00000000000000000000000003'),
        name: 'old-laptop',
        platform: 'darwin',
        createdAt: NOW,
      })
      const list = await runForTest(['devices', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(list.exitCode).toBe(0)
      const devices = JSON.parse(list.output) as { devices: { name: string; current: boolean }[] }
      expect(devices.devices.length).toBe(2)
      expect(devices.devices.some((device) => device.current)).toBe(true)

      const rename = await runForTest(['devices', 'rename', 'self', '--name', 'new-name'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(rename.exitCode).toBe(0)
      expect(rename.output).toContain('new-name')

      const revoke = await runForTest(['devices', 'revoke', 'old-laptop', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(revoke.exitCode).toBe(0)
      expect(revoke.output).toContain('Revoked')

      const revokeSelf = await runForTest(['devices', 'revoke', 'self', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(revokeSelf.exitCode).toBe(0)
      expect(revokeSelf.output).toContain('signed out')
      expect(fs.existsSync(path.join(scratch.home, '.laurencio/device.json'))).toBe(false)

      const after = await runForTest(['status'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(after.exitCode).toBe(1)
      expect(after.errorOutput).toContain('not signed in')
    } finally {
      scratch.cleanup()
    }
  })

  test('resolve keeps local or remote content', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local-one\n')
      const source = path.join(scratch.home, '.claude/CLAUDE.md')

      const plant = (device: string): string => {
        const copy = conflictCopyPath(source, device, NOW)
        fs.writeFileSync(copy, 'remote\n')
        const state = SyncState.open({ home: scratch.home })
        state.setMeta(
          CONFLICT_LEDGER_META_KEY,
          new ConflictLedger([{ path: copy, sourcePath: source, device, createdAt: NOW }]).toJSON(),
        )
        state.close()
        return copy
      }

      const firstCopy = plant('other-device')
      const keepRemote = await runForTest(['resolve', '--keep-remote', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(keepRemote.exitCode).toBe(0)
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('remote\n')
      expect(fs.existsSync(firstCopy)).toBe(false)

      const secondCopy = plant('other-device')
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'local-two\n')
      const keepLocal = await runForTest(['resolve', '--keep-local'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(keepLocal.exitCode).toBe(0)
      expect(readHomeFile(scratch.home, '.claude/CLAUDE.md')).toBe('local-two\n')
      expect(fs.existsSync(secondCopy)).toBe(false)

      const none = await runForTest(['resolve'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(none.exitCode).toBe(0)
      expect(none.output).toContain('No conflicts')
    } finally {
      scratch.cleanup()
    }
  })
})

describe('surfaces and doctor', () => {
  test('surfaces lists the inventory with policies in both modes', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['surfaces', '--json'], { home: scratch.home })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as {
        surfaces: { id: string; policy: string; enabled: boolean }[]
        harnesses: { id: string }[]
      }
      expect(data.harnesses.length).toBe(3)
      expect(data.surfaces.some((surface) => surface.policy === 'opt-in' && !surface.enabled)).toBe(
        true,
      )
      const human = await runForTest(['surfaces'], { home: scratch.home })
      expect(human.output).toContain('SURFACE')
      expect(human.output).toContain('sync')
    } finally {
      scratch.cleanup()
    }
  })

  test('doctor reports links, secrets, and keychain state', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'safe content\n')
      const out = await runForTest(['doctor', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as {
        protocolVersion: number
        keychain: string
        keyCached: boolean
        secrets: { findings: unknown[] }
      }
      expect(data.protocolVersion).toBe(1)
      expect(data.keyCached).toBe(true)
      expect(data.secrets.findings).toEqual([])

      writeHomeFile(
        scratch.home,
        '.claude/CLAUDE.md',
        'token sk-abcdefghijklmnopqrstuvwxyz012345\n',
      )
      const dirty = await runForTest(['doctor', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      const dirtyData = JSON.parse(dirty.output) as { secrets: { findings: { rule: string }[] } }
      expect(dirtyData.secrets.findings.length).toBeGreaterThan(0)
      const human = await runForTest(['doctor'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(human.output).toContain('Secrets')
    } finally {
      scratch.cleanup()
    }
  })
})

describe('login and unlock helpers', () => {
  test('login needs a reachable server', async () => {
    const scratch = makeScratch()
    try {
      const out = await runForTest(['login', '--server', 'http://127.0.0.1:1'], {
        home: scratch.home,
      })
      expect(out.exitCode).toBe(1)
      expect(out.errorOutput).toContain('not reachable')
    } finally {
      scratch.cleanup()
    }
  })

  test('unlock caches the key from the passphrase file', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      writeHomeFile(scratch.home, '.claude/CLAUDE.md', 'unlock me\n')
      await runForTest(['init', '--yes'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: QUICK,
      })
      const cache = await crypto.openKeyCache({ home: scratch.home, keychain: null })
      await cache.forget(STORE_ID)

      const wrong = path.join(scratch.home, 'wrong.txt')
      fs.writeFileSync(wrong, 'not-the-passphrase\n')
      const failed = await runForTest(['unlock', '--passphrase-file', wrong], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(failed.exitCode).toBe(1)
      expect(failed.errorOutput).toContain('does not open this store')

      const passFile = path.join(scratch.home, 'pass.txt')
      fs.writeFileSync(passFile, `${PASSPHRASE}\n`)
      const out = await runForTest(['unlock', '--passphrase-file', passFile, '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as { backend: string }
      expect(data.backend).toBe('file')
      const key = await cache.load(STORE_ID)
      expect(key).not.toBeNull()
      key?.zeroize()
    } finally {
      scratch.cleanup()
    }
  })

  test('an injected keychain surfaces in doctor', async () => {
    const scratch = makeScratch()
    try {
      const keychain = memoryKeychain()
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir, keychain })
      const out = await runForTest(['doctor', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        keychain,
      })
      expect(out.exitCode).toBe(0)
      const data = JSON.parse(out.output) as { keychain: string; keyCached: boolean }
      expect(data.keychain).toBe('keychain')
      expect(data.keyCached).toBe(true)
    } finally {
      scratch.cleanup()
    }
  })
})
