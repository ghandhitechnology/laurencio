import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, RevisionId, StoreId, SurfaceId } from '@laurencio/protocol'
import { hashContent } from '../src/apply'
import { open, sealText } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import {
  CONFLICT_LEDGER_META_KEY,
  MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_UPLOADS,
  RemoteRollbackError,
  type SyncOptions,
  sync,
} from '../src/engine'
import { ConflictLedger } from '../src/merge/conflict'
import type { DevicePolicy, Manifest, SyncReport } from '../src/model'
import { createFileRemote, type FileRemote } from '../src/remote/file'
import type { Remote, RemoteCommit, RemoteCommitResult } from '../src/remote/types'
import { ManifestError } from '../src/remote/types'
import { SyncState, stateDbPath } from '../src/state'
import { activeAdapters } from '../src/sync/policy'
import type { HarnessAdapter, Surface } from '../src/types'
import { file, testAdapter, tree } from './helpers/adapter-fixtures'
import { buildFakeHome, type FakeHome, type FakeHomeOptions } from './helpers/fake-home'

const storeId = StoreId.parse('00000000000000000000000100')
const deviceA = DeviceId.parse('00000000000000000000000101')
const deviceB = DeviceId.parse('00000000000000000000000102')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const key = deriveMasterKey('correct horse', kdf)
const createdAt = '2026-01-01T00:00:00.000Z'

function surfaces(): Surface[] {
  return [
    file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' }),
    file({
      id: 'claude.settings',
      path: '$HOME/.claude/settings.json',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
    }),
    tree({
      id: 'claude.skills',
      path: '$HOME/.claude/skills',
      transforms: [{ kind: 'markerBlocks' }],
    }),
    tree({ id: 'claude.shared-skills', path: '$HOME/.agents/skills' }),
  ]
}

class Ids {
  #next = 10
  revision(): RevisionId {
    const value = String(this.#next++)
    return RevisionId.parse(value.padStart(26, '0'))
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-engine-'))
}

function engineHome(entries: FakeHomeOptions['entries'], linkMode?: 'symlink' | 'copy'): FakeHome {
  return buildFakeHome({ entries, ...(linkMode !== undefined ? { linkMode } : {}) })
}

function policyWith(surfaces: Record<string, 'on' | 'off'>, harnessEnabled = true): DevicePolicy {
  return {
    version: 1,
    harnesses: { claude: { enabled: harnessEnabled, surfaces } },
    ignore: [],
    prune: false,
    cadence: { watch: false, intervalSeconds: 300 },
  }
}

interface RunOptions {
  onProgress?: SyncOptions['onProgress']
  hooks?: SyncOptions['hooks']
  now?: () => Date
  remote?: Remote
  quiescence?: SyncOptions['quiescence']
  policy?: DevicePolicy
  adapters?: readonly HarnessAdapter[]
}

interface Harness {
  remote: FileRemote
  remoteDir: string
  ids: Ids
  adapters: readonly HarnessAdapter[]
  run(home: FakeHome, deviceId: DeviceId, options?: RunOptions): Promise<SyncReport>
  revisionCount(): Promise<number>
  headManifest(): Promise<import('../src/model').Manifest>
  scanRemoteBytes(): string
}

function harness(surfaceList: Surface[] = surfaces()): Harness {
  const remoteDir = tempDir()
  const remote = createFileRemote({
    dir: remoteDir,
    storeId,
    kdf: kdfParamsToWire(kdf, createdAt),
    now: () => new Date(createdAt),
  })
  const ids = new Ids()
  const adapters = [testAdapter('claude', surfaceList)]
  return {
    remote,
    remoteDir,
    ids,
    adapters,
    async run(home, deviceId, options = {}) {
      const state = SyncState.open({ path: stateDbPath(home.home) })
      try {
        return await sync({
          adapters: options.adapters ?? adapters,
          ctx: home.ctx,
          deviceId,
          storeId,
          key,
          state,
          remote: options.remote ?? remote,
          quiescence: options.quiescence ?? { windowMs: 0 },
          now: options.now ?? (() => new Date(createdAt)),
          createRevisionId: () => ids.revision(),
          ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
          ...(options.policy !== undefined ? { policy: options.policy } : {}),
          ...(options.onProgress !== undefined ? { onProgress: options.onProgress } : {}),
        })
      } finally {
        state.close()
      }
    },
    async revisionCount() {
      return (await remote.listRevisions()).revisions.length
    },
    async headManifest() {
      const list = await remote.listRevisions()
      if (list.head === null) throw new Error('no head revision')
      const bytes = await remote.getManifest(list.head)
      const parsed: unknown = JSON.parse(
        new TextDecoder().decode(
          open(key, 'manifest', bytes, { storeId, blobType: 'manifest', protocolVersion: 1 }),
        ),
      )
      return parsed as import('../src/model').Manifest
    },
    scanRemoteBytes() {
      const chunks: string[] = []
      const walk = (dir: string): void => {
        for (const name of fs.readdirSync(dir)) {
          const full = path.join(dir, name)
          const stat = fs.statSync(full)
          if (stat.isDirectory()) walk(full)
          else chunks.push(fs.readFileSync(full, 'latin1'))
        }
      }
      walk(remoteDir)
      return chunks.join('\n')
    },
  }
}

const baseEntries: FakeHomeOptions['entries'] = [
  { kind: 'dir', path: '.claude' },
  { kind: 'file', path: '.claude/CLAUDE.md', content: '# shared rules\n' },
  {
    kind: 'file',
    path: '.claude/settings.json',
    content: '{\n  "model": "opus",\n  "theme": "dark"\n}\n',
  },
]

describe('engine sync', () => {
  test('progress counts deduplicated transfers and completes candidate work on both devices', async () => {
    const h = harness()
    const a = engineHome([
      { kind: 'file', path: '.agents/skills/one/SKILL.md', content: '# repeated skill\n' },
      { kind: 'file', path: '.agents/skills/two/SKILL.md', content: '# repeated skill\n' },
    ])
    const b = engineHome([{ kind: 'dir', path: '.agents/skills' }])
    const events: import('../src/engine').SyncProgress[] = []
    try {
      const uploaded = await h.run(a, deviceA, { onProgress: (event) => events.push(event) })
      expect(uploaded.uploaded).toBe(1)
      expect(events[0]?.phase).toBe('scanning')
      expect(events.at(-1)).toMatchObject({
        phase: 'saving',
        completed: 2,
        planned: 2,
        uploaded: 1,
      })
      expect(events.at(-1)?.uploadedBytes).toBeGreaterThan(0)
      events.length = 0
      const downloaded = await h.run(b, deviceB, { onProgress: (event) => events.push(event) })
      expect(downloaded.downloaded).toBe(2)
      expect(events.at(-1)).toMatchObject({
        phase: 'saving',
        completed: 2,
        planned: 2,
        downloaded: 1,
      })
      expect(events.at(-1)?.downloadedBytes).toBeGreaterThan(0)
      // Observers are presentation only; a failing display cannot cancel a sync.
      expect(
        (
          await h.run(a, deviceA, {
            onProgress() {
              throw new Error('display failed')
            },
          })
        ).changed,
      ).toEqual([])
    } finally {
      a.cleanup()
      b.cleanup()
    }
  })

  test('two homes converge through a file remote and a second run writes nothing', async () => {
    const h = harness()
    const a = engineHome([
      ...baseEntries,
      { kind: 'file', path: '.agents/skills/from-a/SKILL.md', content: '# from A\n' },
    ])
    const b = engineHome([
      ...baseEntries,
      { kind: 'file', path: '.agents/skills/from-b/SKILL.md', content: '# from B\n' },
    ])
    const first = await h.run(a, deviceA)
    expect(first.revisionId).not.toBeNull()
    expect(first.uploaded).toBeGreaterThan(0)
    await h.run(b, deviceB)
    await h.run(a, deviceA)
    expect(await h.revisionCount()).toBe(2)

    expect(a.read('.agents/skills/from-b/SKILL.md')).toBe('# from B\n')
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')
    expect(a.read('.claude/CLAUDE.md')).toBe(b.read('.claude/CLAUDE.md'))

    const before = {
      revision: (await h.remote.listRevisions()).head,
      count: await h.revisionCount(),
      claude: fs.statSync(a.path('.claude/CLAUDE.md')).mtimeMs,
      skill: fs.statSync(a.path('.agents/skills/from-a/SKILL.md')).mtimeMs,
    }
    const idle = await h.run(a, deviceA)
    expect(idle.changed).toEqual([])
    expect(idle.uploaded).toBe(0)
    expect(idle.downloaded).toBe(0)
    expect(await h.revisionCount()).toBe(before.count)
    expect((await h.remote.listRevisions()).head).toBe(before.revision)
    expect(fs.statSync(a.path('.claude/CLAUDE.md')).mtimeMs).toBe(before.claude)
    expect(fs.statSync(a.path('.agents/skills/from-a/SKILL.md')).mtimeMs).toBe(before.skill)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('uploads independent new files with bounded concurrency', async () => {
    const h = harness()
    const skills = Array.from({ length: MAX_CONCURRENT_UPLOADS * 3 }, (_, index) => ({
      kind: 'file' as const,
      path: `.claude/skills/skill-${String(index).padStart(2, '0')}.md`,
      content: `# skill ${index}\n`,
    }))
    const a = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }, ...skills])
    let active = 0
    let peak = 0
    const delayed: Remote = {
      ...h.remote,
      async putBlob(upload) {
        active += 1
        peak = Math.max(peak, active)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return await h.remote.putBlob(upload)
        } finally {
          active -= 1
        }
      },
    }

    const report = await h.run(a, deviceA, { remote: delayed })

    expect(peak).toBe(MAX_CONCURRENT_UPLOADS)
    expect(active).toBe(0)
    expect(report.uploaded).toBe(
      baseEntries.filter((entry) => entry.kind === 'file').length + skills.length,
    )
    const manifest = await h.headManifest()
    expect(manifest.entries.map((entry) => entry.path)).toEqual(
      manifest.entries.map((entry) => entry.path).sort(),
    )
    a.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('uploads identical file contents once within a sync run', async () => {
    const h = harness()
    const a = engineHome([
      ...baseEntries,
      { kind: 'dir', path: '.claude/skills' },
      { kind: 'file', path: '.claude/skills/one.md', content: '# same skill\n' },
      { kind: 'file', path: '.claude/skills/two.md', content: '# same skill\n' },
    ])

    const report = await h.run(a, deviceA)
    const manifest = await h.headManifest()
    const skillBlobs = manifest.entries
      .filter((entry) => entry.path.startsWith('$HOME/.claude/skills/'))
      .map((entry) => entry.blob?.id)

    expect(report.uploaded).toBe(3)
    expect(new Set(skillBlobs).size).toBe(1)
    a.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('waits for concurrent uploads to settle before returning the first upload error', async () => {
    const h = harness()
    const skills = Array.from({ length: MAX_CONCURRENT_UPLOADS * 2 }, (_, index) => ({
      kind: 'file' as const,
      path: `.claude/skills/failure-${String(index).padStart(2, '0')}.md`,
      content: `# failure ${index}\n`,
    }))
    const a = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }, ...skills])
    const failure = new Error('storage rejected this blob')
    let calls = 0
    let active = 0
    const failing: Remote = {
      ...h.remote,
      async putBlob(upload) {
        calls += 1
        const call = calls
        active += 1
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (call === 2) throw failure
          return await h.remote.putBlob(upload)
        } finally {
          active -= 1
        }
      },
    }

    let caught: unknown
    try {
      await h.run(a, deviceA, { remote: failing })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(failure)
    expect(active).toBe(0)
    expect(await h.revisionCount()).toBe(0)
    a.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('prefetches remote blobs concurrently and applies files after the batch settles', async () => {
    const h = harness()
    const skills = Array.from({ length: MAX_CONCURRENT_DOWNLOADS * 3 }, (_, index) => ({
      kind: 'file' as const,
      path: `.claude/skills/download-${String(index).padStart(2, '0')}.md`,
      content: `# download ${index}\n`,
    }))
    const a = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }, ...skills])
    const b = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }])
    await h.run(a, deviceA)
    let active = 0
    let peak = 0
    let writesDuringDownload = 0
    const delayed: Remote = {
      ...h.remote,
      async getBlob(blobId) {
        active += 1
        peak = Math.max(peak, active)
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return await h.remote.getBlob(blobId)
        } finally {
          active -= 1
        }
      },
    }

    const report = await h.run(b, deviceB, {
      remote: delayed,
      hooks: {
        beforeRename: () => {
          if (active > 0) writesDuringDownload += 1
        },
      },
    })

    expect(peak).toBe(MAX_CONCURRENT_DOWNLOADS)
    expect(active).toBe(0)
    expect(writesDuringDownload).toBe(0)
    expect(report.downloaded).toBe(skills.length)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('downloads one copy of a blob shared by files in the same batch', async () => {
    const h = harness()
    const a = engineHome([
      ...baseEntries,
      { kind: 'dir', path: '.claude/skills' },
      { kind: 'file', path: '.claude/skills/one.md', content: '# shared download\n' },
      { kind: 'file', path: '.claude/skills/two.md', content: '# shared download\n' },
    ])
    const b = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }])
    await h.run(a, deviceA)
    let downloads = 0
    const counting: Remote = {
      ...h.remote,
      async getBlob(blobId) {
        downloads += 1
        return h.remote.getBlob(blobId)
      },
    }

    const report = await h.run(b, deviceB, { remote: counting })

    expect(downloads).toBe(1)
    expect(report.downloaded).toBe(2)
    expect(b.read('.claude/skills/one.md')).toBe('# shared download\n')
    expect(b.read('.claude/skills/two.md')).toBe('# shared download\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('does not apply a download batch when one prefetch fails', async () => {
    const h = harness()
    const skills = Array.from({ length: MAX_CONCURRENT_DOWNLOADS }, (_, index) => ({
      kind: 'file' as const,
      path: `.claude/skills/rejected-${String(index).padStart(2, '0')}.md`,
      content: `# rejected ${index}\n`,
    }))
    const a = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }, ...skills])
    const b = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }])
    await h.run(a, deviceA)
    const failure = new Error('storage rejected this download')
    let calls = 0
    let active = 0
    let writes = 0
    const failing: Remote = {
      ...h.remote,
      async getBlob(blobId) {
        calls += 1
        const call = calls
        active += 1
        try {
          await new Promise((resolve) => setTimeout(resolve, 5))
          if (call === 2) throw failure
          return await h.remote.getBlob(blobId)
        } finally {
          active -= 1
        }
      },
    }

    let caught: unknown
    try {
      await h.run(b, deviceB, {
        remote: failing,
        hooks: { beforeRename: () => (writes += 1) },
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBe(failure)
    expect(active).toBe(0)
    expect(writes).toBe(0)
    for (const skill of skills) expect(fs.existsSync(b.path(skill.path))).toBe(false)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('concurrent edits to different keys merge cleanly in both directions', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.claude/settings.json', '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n')
    await h.run(a, deviceA)
    b.write('.claude/settings.json', '{\n  "model": "opus",\n  "theme": "light"\n}\n')
    const merged = await h.run(b, deviceB)
    expect(merged.conflicts).toEqual([])
    expect(b.read('.claude/settings.json')).toContain('"model": "sonnet"')
    expect(b.read('.claude/settings.json')).toContain('"theme": "light"')

    await h.run(a, deviceA)
    expect(a.read('.claude/settings.json')).toBe(b.read('.claude/settings.json'))
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('marker blocks round-trip and never leave the device', async () => {
    const h = harness()
    const a = engineHome([
      { kind: 'dir', path: '.claude/skills' },
      {
        kind: 'file',
        path: '.claude/skills/notes.md',
        content:
          '# Notes\n<!-- laurencio:local -->\nA device secret\n<!-- /laurencio:local -->\nshared line\n',
      },
    ])
    const b = engineHome([{ kind: 'dir', path: '.claude/skills' }])
    await h.run(a, deviceA)
    expect(h.scanRemoteBytes()).not.toContain('A device secret')

    await h.run(b, deviceB)
    const downloaded = b.read('.claude/skills/notes.md')
    expect(downloaded).toContain('<!-- laurencio:local -->')
    expect(downloaded).not.toContain('A device secret')
    b.write(
      '.claude/skills/notes.md',
      downloaded.replace(
        '<!-- laurencio:local -->\n<!-- /laurencio:local -->',
        '<!-- laurencio:local -->\nB device secret\n<!-- /laurencio:local -->',
      ),
    )
    await h.run(b, deviceB)
    expect(h.scanRemoteBytes()).not.toContain('B device secret')

    await h.run(a, deviceA)
    expect(a.read('.claude/skills/notes.md')).toContain('A device secret')
    expect(a.read('.claude/skills/notes.md')).not.toContain('B device secret')
    expect(b.read('.claude/skills/notes.md')).toContain('B device secret')
    expect(b.read('.claude/skills/notes.md')).not.toContain('A device secret')

    const idle = await h.run(a, deviceA)
    expect(idle.changed).toEqual([])
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a true conflict writes one conflict copy, keeps local, and excludes the copy', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.claude/CLAUDE.md', '# shared rules\nA rewrote this line\n')
    await h.run(a, deviceA)
    b.write('.claude/CLAUDE.md', '# shared rules\nB rewrote this line\n')
    const conflicted = await h.run(b, deviceB)
    expect(conflicted.conflicts).toHaveLength(1)
    const copyPath = conflicted.conflicts[0]?.path ?? ''
    expect(copyPath).toContain('.conflict-')
    expect(fs.readFileSync(copyPath, 'utf8')).toContain('A rewrote this line')
    expect(b.read('.claude/CLAUDE.md')).toContain('B rewrote this line')
    expect(
      fs.readdirSync(b.path('.claude')).filter((name) => name.includes('.conflict-')),
    ).toHaveLength(1)

    const before = await h.revisionCount()
    const again = await h.run(b, deviceB)
    expect(again.conflicts).toEqual([])
    expect(again.changed).toEqual([])
    expect(await h.revisionCount()).toBe(before)
    expect(
      fs.readdirSync(b.path('.claude')).filter((name) => name.includes('.conflict-')),
    ).toHaveLength(1)
    const manifest = await h.headManifest()
    expect(manifest.entries.some((entry) => entry.path.includes('.conflict-'))).toBe(false)

    const ledgerState = SyncState.open({ path: stateDbPath(b.home) })
    const ledger = ConflictLedger.fromJSON(ledgerState.getMeta(CONFLICT_LEDGER_META_KEY) ?? '')
    ledgerState.close()
    const record = ledger.records()[0]
    expect(record?.sourcePath).toBe('$HOME/.claude/CLAUDE.md')
    expect(record?.path.startsWith('$HOME/.claude/CLAUDE.md.conflict-')).toBe(true)
    expect(record?.path.includes(b.home)).toBe(false)
    expect(ledger.isExcluded(record?.path ?? '')).toBe(true)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('secret findings block the upload without blocking the rest of the run', async () => {
    const h = harness()
    const a = engineHome([
      ...baseEntries,
      { kind: 'dir', path: '.claude/skills' },
      {
        kind: 'file',
        path: '.claude/skills/creds.md',
        content: 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"\n',
      },
    ])
    const report = await h.run(a, deviceA)
    expect(report.blocked).toContain('$HOME/.claude/skills/creds.md')
    expect(h.scanRemoteBytes()).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
    expect(fs.existsSync(a.path('.claude/skills/creds.md'))).toBe(true)
    const manifest = await h.headManifest()
    expect(manifest.entries.some((entry) => entry.path.endsWith('creds.md'))).toBe(false)
    a.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('deletions travel as tombstones and remove the file on the other home', async () => {
    const h = harness()
    const a = engineHome([
      ...baseEntries,
      { kind: 'dir', path: '.claude/skills' },
      { kind: 'file', path: '.claude/skills/old.md', content: 'old\n' },
    ])
    const b = engineHome([...baseEntries, { kind: 'dir', path: '.claude/skills' }])
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    expect(b.read('.claude/skills/old.md')).toBe('old\n')

    fs.rmSync(a.path('.claude/skills/old.md'))
    const removal = await h.run(a, deviceA)
    expect(removal.changed).toContain('$HOME/.claude/skills/old.md')
    const manifest = await h.headManifest()
    expect(
      manifest.entries.find((entry) => entry.path === '$HOME/.claude/skills/old.md')?.kind,
    ).toBe('tombstone')
    await h.run(b, deviceB)
    expect(fs.existsSync(b.path('.claude/skills/old.md'))).toBe(false)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a device that disables a surface carries its entries forward instead of deleting them elsewhere', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      ...baseEntries,
      { kind: 'dir', path: '.agents/skills' },
      { kind: 'file', path: '.agents/skills/from-a/SKILL.md', content: '# from A\n' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')

    const skillPath = '$HOME/.agents/skills/from-a/SKILL.md'
    const revisions = await h.revisionCount()
    const switchedOff = policyWith({ 'claude.shared-skills': 'off' })
    const disabled = await h.run(a, deviceA, {
      adapters: activeAdapters(h.adapters, switchedOff),
      policy: switchedOff,
    })
    expect(disabled.changed).toEqual([])
    expect(await h.revisionCount()).toBe(revisions)
    expect((await h.headManifest()).entries.find((entry) => entry.path === skillPath)?.kind).toBe(
      'file',
    )

    await h.run(b, deviceB)
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')

    // Harness-level disable with the surfaces still declared: the engine must surrender them itself.
    const harnessOff = policyWith({}, false)
    const whole = await h.run(a, deviceA, { policy: harnessOff })
    expect(whole.changed).toEqual([])
    expect(await h.revisionCount()).toBe(revisions)
    expect((await h.headManifest()).entries.map((entry) => entry.path)).toContain(skillPath)

    await h.run(b, deviceB)
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')

    // Re-enabled, a real local deletion still travels as a tombstone.
    fs.rmSync(a.path('.agents/skills/from-a/SKILL.md'))
    const removal = await h.run(a, deviceA)
    expect(removal.changed).toContain(skillPath)
    const manifest = await h.headManifest()
    expect(manifest.entries.find((entry) => entry.path === skillPath)?.kind).toBe('tombstone')
    await h.run(b, deviceB)
    expect(fs.existsSync(b.path('.agents/skills/from-a/SKILL.md'))).toBe(false)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a device that ignores a path carries it forward instead of deleting it elsewhere', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      ...baseEntries,
      { kind: 'dir', path: '.agents/skills' },
      { kind: 'file', path: '.agents/skills/from-a/SKILL.md', content: '# from A\n' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)

    const skillPath = '$HOME/.agents/skills/from-a/SKILL.md'
    const ignoring = { ...policyWith({}), ignore: [skillPath] }
    const revisions = await h.revisionCount()
    const ignored = await h.run(a, deviceA, { policy: ignoring })
    expect(ignored.changed).toEqual([])
    expect(await h.revisionCount()).toBe(revisions)
    expect((await h.headManifest()).entries.find((entry) => entry.path === skillPath)?.kind).toBe(
      'file',
    )

    await h.run(b, deviceB)
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')

    // Pruning lifts the protection from an ignored path that is gone from this device.
    fs.rmSync(a.path('.agents/skills/from-a/SKILL.md'))
    const removal = await h.run(a, deviceA, { policy: { ...ignoring, prune: true } })
    expect(removal.changed).toContain(skillPath)
    expect((await h.headManifest()).entries.find((entry) => entry.path === skillPath)?.kind).toBe(
      'tombstone',
    )
    await h.run(b, deviceB)
    expect(fs.existsSync(b.path('.agents/skills/from-a/SKILL.md'))).toBe(false)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('ignore globs protect dotfiles', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      ...baseEntries,
      { kind: 'dir', path: '.agents/skills/.system' },
      { kind: 'file', path: '.agents/skills/.system/.marker', content: 'one\n' },
    ]
    const a = engineHome(entries)
    await h.run(a, deviceA)
    const revisions = await h.revisionCount()

    a.write('.agents/skills/.system/.marker', 'two\n')
    const policy = {
      ...policyWith({}),
      ignore: ['$HOME/.agents/skills/.system/**'],
    }
    const ignored = await h.run(a, deviceA, { policy })
    expect(ignored.changed).toEqual([])
    expect(await h.revisionCount()).toBe(revisions)

    a.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a device whose surface root is missing carries its entries forward instead of deleting them', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      ...baseEntries,
      { kind: 'dir', path: '.agents/skills' },
      { kind: 'file', path: '.agents/skills/from-a/SKILL.md', content: '# from A\n' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)

    const skillPath = '$HOME/.agents/skills/from-a/SKILL.md'
    fs.rmSync(a.path('.agents/skills'), { recursive: true, force: true })
    const revisions = await h.revisionCount()
    const missing = await h.run(a, deviceA)
    expect(missing.changed).toEqual([])
    expect(await h.revisionCount()).toBe(revisions)
    expect((await h.headManifest()).entries.find((entry) => entry.path === skillPath)?.kind).toBe(
      'file',
    )

    await h.run(b, deviceB)
    expect(b.read('.agents/skills/from-a/SKILL.md')).toBe('# from A\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a run with pruning propagates a deleted surface root to the other device', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      ...baseEntries,
      { kind: 'dir', path: '.agents/skills' },
      { kind: 'file', path: '.agents/skills/from-a/SKILL.md', content: '# from A\n' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)

    const skillPath = '$HOME/.agents/skills/from-a/SKILL.md'
    fs.rmSync(a.path('.agents/skills'), { recursive: true, force: true })
    const removal = await h.run(a, deviceA, { policy: { ...policyWith({}), prune: true } })
    expect(removal.changed).toContain(skillPath)
    expect((await h.headManifest()).entries.find((entry) => entry.path === skillPath)?.kind).toBe(
      'tombstone',
    )

    await h.run(b, deviceB)
    expect(fs.existsSync(b.path('.agents/skills/from-a/SKILL.md'))).toBe(false)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('symlinked surfaces are preserved while content flows through them', async () => {
    const h = harness()
    const entries: FakeHomeOptions['entries'] = [
      { kind: 'dir', path: '.agents/skills/foo' },
      { kind: 'file', path: '.agents/skills/foo/SKILL.md', content: '# foo v1\n' },
      { kind: 'dir', path: '.claude' },
      { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.agents/skills/foo/SKILL.md', '# foo v2\n')
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    expect(b.read('.agents/skills/foo/SKILL.md')).toBe('# foo v2\n')
    expect(fs.lstatSync(b.path('.claude/skills')).isSymbolicLink()).toBe(true)
    expect(fs.existsSync(b.path('.claude/skills/foo/SKILL.md'))).toBe(true)
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('downloads a new file through a symlinked surface root', async () => {
    const h = harness([
      tree({ id: 'claude.skills', path: '$HOME/.codex/skills' }),
      tree({
        id: 'claude.agents-skills',
        path: '$HOME/.agents/skills',
        shared: true,
      }),
    ])
    const a = engineHome([
      {
        kind: 'file',
        path: '.agents/skills/ask-matt/PHASE-BOUNDARIES.md',
        content: '# Phase boundaries\n',
      },
      { kind: 'dir', path: '.codex/skills', link: '$HOME/.agents/skills' },
    ])
    const b = engineHome([
      { kind: 'dir', path: '.agents/skills' },
      { kind: 'dir', path: '.codex/skills', link: '$HOME/.agents/skills' },
    ])
    try {
      await h.run(a, deviceA)
      await h.run(b, deviceB)

      expect(b.read('.agents/skills/ask-matt/PHASE-BOUNDARIES.md')).toBe('# Phase boundaries\n')
    } finally {
      a.cleanup()
      b.cleanup()
      fs.rmSync(h.remoteDir, { recursive: true, force: true })
    }
  })

  test('a crash mid-apply rolls back on rerun without duplicated artifacts', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    b.write('.claude/settings.json', '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n')
    await h.run(b, deviceB)
    a.write('.claude/settings.json', '{\n  "model": "opus",\n  "theme": "light"\n}\n')
    const revisions = await h.revisionCount()

    let crashed = false
    const failing = {
      beforeRename: () => {
        if (!crashed) {
          crashed = true
          throw new Error('simulated crash')
        }
      },
    }
    await expect(h.run(a, deviceA, { hooks: failing })).rejects.toThrow('simulated crash')

    const recovered = await h.run(a, deviceA)
    expect(recovered.changed).toContain('$HOME/.claude/settings.json')
    expect(await h.revisionCount()).toBe(revisions + 1)
    const merged = a.read('.claude/settings.json')
    expect(merged).toContain('"model": "sonnet"')
    expect(merged).toContain('"theme": "light"')
    const leftovers = fs
      .readdirSync(a.path('.claude'))
      .filter((name) => name.startsWith('.laurencio-'))
    expect(leftovers).toEqual([])
    const idle = await h.run(a, deviceA)
    expect(idle.changed).toEqual([])
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a slow-clock push is still detected as the head and converges', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    const clockA = () => new Date('2026-05-01T00:00:00.000Z')
    const clockB = () => new Date('2026-01-01T00:00:00.000Z')

    await h.run(a, deviceA, { now: clockA })
    await h.run(b, deviceB, { now: clockB })
    b.write('.claude/CLAUDE.md', '# shared rules\nB late but ahead\n')
    await h.run(b, deviceB, { now: clockB })

    const list = await h.remote.listRevisions()
    expect(list.heads).toHaveLength(1)
    const headMeta = list.revisions.find((revision) => revision.id === list.heads[0])
    // The head is B's revision even though it claims an older wall clock.
    expect(headMeta?.createdAt).toBe(clockB().toISOString())

    const report = await h.run(a, deviceA, { now: clockA })
    expect(a.read('.claude/CLAUDE.md')).toBe('# shared rules\nB late but ahead\n')
    expect(report.changed).toContain('$HOME/.claude/CLAUDE.md')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a stale-parent commit is rejected, re-pulled, re-merged, and retried', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.claude/CLAUDE.md', '# shared rules\nA edited the rules\n')
    b.write('.claude/settings.json', '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n')

    let injected = false
    let rejections = 0
    const racing: Remote = {
      ...h.remote,
      async commit(commit: RemoteCommit): Promise<RemoteCommitResult> {
        if (!injected) {
          injected = true
          await h.run(b, deviceB)
        }
        const result = await h.remote.commit(commit)
        if (!result.accepted && result.reason === 'stale-parents') rejections += 1
        return result
      },
    }
    const report = await h.run(a, deviceA, { remote: racing })
    expect(injected).toBe(true)
    expect(rejections).toBe(1)
    expect(report.revisionId).not.toBeNull()
    const manifest = await h.headManifest()
    const paths = manifest.entries.map((entry) => entry.path)
    expect(paths).toContain('$HOME/.claude/CLAUDE.md')
    expect(paths).toContain('$HOME/.claude/settings.json')

    await h.run(b, deviceB)
    expect(b.read('.claude/CLAUDE.md')).toBe('# shared rules\nA edited the rules\n')
    expect(a.read('.claude/settings.json')).toContain('"sonnet"')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('two devices committing concurrently converge with no lost edit', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.claude/CLAUDE.md', '# shared rules\nA wrote this first\n')
    b.write('.claude/settings.json', '{\n  "model": "sonnet",\n  "theme": "dark"\n}\n')
    const [aReport, bReport] = await Promise.all([h.run(a, deviceA), h.run(b, deviceB)])
    expect(aReport.revisionId).not.toBeNull()
    expect(bReport.revisionId).not.toBeNull()

    await h.run(a, deviceA)
    await h.run(b, deviceB)
    expect(a.read('.claude/CLAUDE.md')).toBe('# shared rules\nA wrote this first\n')
    expect(b.read('.claude/CLAUDE.md')).toBe('# shared rules\nA wrote this first\n')
    expect(a.read('.claude/settings.json')).toContain('"theme": "dark"')
    expect(b.read('.claude/settings.json')).toContain('"theme": "dark"')
    expect(a.read('.claude/settings.json')).toBe(b.read('.claude/settings.json'))
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('binaryNewestWins reaches the merge dispatch with real mtimes', async () => {
    const h = harness([
      file({ id: 'claude.rules', path: '$HOME/.claude/rules.txt', merge: 'binaryNewestWins' }),
    ])
    const entries: FakeHomeOptions['entries'] = [
      { kind: 'dir', path: '.claude' },
      { kind: 'file', path: '.claude/rules.txt', content: 'base\n' },
    ]
    const a = engineHome(entries)
    const b = engineHome(entries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    await h.run(a, deviceA)

    a.write('.claude/rules.txt', 'from-a\n')
    await h.run(a, deviceA)
    b.write('.claude/rules.txt', 'from-b\n')
    const old = new Date('2020-01-01T00:00:00.000Z')
    fs.utimesSync(b.path('.claude/rules.txt'), old, old)
    const remoteWins = await h.run(b, deviceB)
    expect(remoteWins.conflicts).toEqual([])
    expect(b.read('.claude/rules.txt')).toBe('from-a\n')

    b.write('.claude/rules.txt', 'from-b-new\n')
    const future = new Date('2030-01-01T00:00:00.000Z')
    fs.utimesSync(b.path('.claude/rules.txt'), future, future)
    a.write('.claude/rules.txt', 'from-a-new\n')
    await h.run(a, deviceA)
    const localWins = await h.run(b, deviceB)
    expect(localWins.conflicts).toEqual([])
    expect(b.read('.claude/rules.txt')).toBe('from-b-new\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a file with a future mtime still settles instead of deferring forever', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    a.write('.claude/CLAUDE.md', '# shared rules\nA pushes an update\n')
    await h.run(a, deviceA)

    const future = new Date(Date.now() + 86_400_000)
    fs.utimesSync(b.path('.claude/CLAUDE.md'), future, future)
    const report = await h.run(b, deviceB, { quiescence: { windowMs: 1500 } })
    expect(report.deferred).toEqual([])
    expect(report.downloaded).toBe(1)
    expect(b.read('.claude/CLAUDE.md')).toBe('# shared rules\nA pushes an update\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('deferred paths drain their pending rows instead of piling up', async () => {
    const baseText = 'line one\nline two\nline three\n'
    const h = harness()
    const a = engineHome([
      { kind: 'dir', path: '.claude' },
      { kind: 'file', path: '.claude/CLAUDE.md', content: baseText },
    ])
    const b = engineHome([
      { kind: 'dir', path: '.claude' },
      { kind: 'file', path: '.claude/CLAUDE.md', content: baseText },
    ])
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    // B edits the first line; A keeps editing the third, far enough apart to merge.
    b.write('.claude/CLAUDE.md', 'B local line\nline two\nline three\n')

    const path = '.claude/CLAUDE.md'
    const storePath = '$HOME/.claude/CLAUDE.md'
    const touch = (): void => {
      const now = new Date()
      fs.utimesSync(b.path(path), now, now)
    }
    const bigWindow = { quiescence: { windowMs: 3_600_000 } }

    a.write(path, 'line one\nline two\nA round one\n')
    await h.run(a, deviceA)
    touch()
    const first = await h.run(b, deviceB, bigWindow)
    expect(first.deferred).toEqual([storePath])
    const firstState = SyncState.open({ path: stateDbPath(b.home) })
    expect(firstState.listPendingOps().length).toBe(1)
    firstState.close()

    a.write(path, 'line one\nline two\nA round two\n')
    await h.run(a, deviceA)
    touch()
    const second = await h.run(b, deviceB, bigWindow)
    expect(second.deferred).toEqual([storePath])
    // The previous row was drained; only this run's fresh one is queued.
    const secondState = SyncState.open({ path: stateDbPath(b.home) })
    expect(secondState.listPendingOps().length).toBe(1)
    secondState.close()
    // The deferred run must not revert A's head in the manifest.
    const deferredHead = await h.headManifest()
    expect(deferredHead.entries.find((entry) => entry.path === storePath)?.hash).toBe(
      hashContent('line one\nline two\nA round two\n'),
    )

    const settled = await h.run(b, deviceB, { quiescence: { windowMs: 0 } })
    expect(settled.deferred).toEqual([])
    const thirdState = SyncState.open({ path: stateDbPath(b.home) })
    expect(thirdState.listPendingOps()).toEqual([])
    thirdState.close()
    expect(b.read(path)).toBe('B local line\nline two\nA round two\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a forked store folds both heads and commits a multi-parent merge', async () => {
    const seedText = 'one\ntwo\nthree\nfour\nfive\n'
    const seedEntries: FakeHomeOptions['entries'] = [
      { kind: 'dir', path: '.claude' },
      { kind: 'file', path: '.claude/CLAUDE.md', content: seedText },
      {
        kind: 'file',
        path: '.claude/settings.json',
        content: '{\n  "model": "opus",\n  "theme": "dark"\n}\n',
      },
    ]
    const h = harness()
    const a = engineHome(seedEntries)
    const b = engineHome(seedEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    const baseList = await h.remote.listRevisions()
    const baseId = baseList.heads[0]
    if (baseId === undefined) throw new Error('missing base revision')
    const baseManifest = await h.headManifest()

    async function forkRevision(id: RevisionId, content: string): Promise<void> {
      const fileContext = { storeId, blobType: 'file' as const, protocolVersion: 1 }
      const sealed = sealText(key, 'content', content, fileContext)
      await h.remote.putBlob({ blobId: sealed.blobId, bytes: sealed.bytes })
      const entries = baseManifest.entries.map((entry) =>
        entry.path === '$HOME/.claude/CLAUDE.md'
          ? {
              ...entry,
              hash: hashContent(content),
              size: Buffer.byteLength(content),
              blob: { id: sealed.blobId, size: sealed.bytes.length },
            }
          : entry,
      )
      const manifest: Manifest = {
        revisionId: id,
        deviceId: deviceA,
        createdAt: '2026-01-02T00:00:00.000Z',
        entries,
      }
      const manifestContext = { storeId, blobType: 'manifest' as const, protocolVersion: 1 }
      const sealedManifest = sealText(key, 'manifest', JSON.stringify(manifest), manifestContext)
      await h.remote.putBlob({ blobId: sealedManifest.blobId, bytes: sealedManifest.bytes })
      fs.writeFileSync(
        path.join(h.remoteDir, 'revisions', `${id}.json`),
        JSON.stringify({
          id,
          parents: [baseId],
          deviceId: deviceA,
          createdAt: '2026-01-02T00:00:00.000Z',
          manifest: { id: sealedManifest.blobId, size: sealedManifest.bytes.length },
          digest: [],
        }),
      )
    }
    const forkA = RevisionId.parse('00000000000000000000000051')
    const forkB = RevisionId.parse('00000000000000000000000052')
    await forkRevision(forkA, 'one\ntwo\nthree\nfour\nA fork\n')
    await forkRevision(forkB, 'B fork\ntwo\nthree\nfour\nfive\n')
    expect((await h.remote.listRevisions()).heads).toHaveLength(2)

    const report = await h.run(b, deviceB)
    expect(report.revisionId).not.toBeNull()
    expect(b.read('.claude/CLAUDE.md')).toBe('B fork\ntwo\nthree\nfour\nA fork\n')
    const joined = await h.remote.listRevisions()
    expect(joined.heads).toHaveLength(1)
    const merged = joined.revisions.find((revision) => revision.id === joined.heads[0])
    expect([...(merged?.parents ?? [])].sort()).toEqual([forkA, forkB, baseId].sort())
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a hostile manifest path is refused and nothing outside the surface is written', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const escapeDir = tempDir()
    const hostileId = RevisionId.parse('00000000000000000000000061')
    const content = 'pwned\n'
    const storePath = `$HOME/.claude/../../${path.basename(escapeDir)}/owned.txt`

    const fileContext = { storeId, blobType: 'file' as const, protocolVersion: 1 }
    const sealedContent = sealText(key, 'content', content, fileContext)
    await h.remote.putBlob({ blobId: sealedContent.blobId, bytes: sealedContent.bytes })
    const hostile: Manifest = {
      revisionId: hostileId,
      deviceId: deviceA,
      createdAt: '2026-01-02T00:00:00.000Z',
      entries: [
        {
          surfaceId: SurfaceId.parse('claude.instructions'),
          path: storePath,
          kind: 'file',
          policy: 'sync',
          hash: hashContent(content),
          size: Buffer.byteLength(content),
          mode: 0o644,
          blob: { id: sealedContent.blobId, size: sealedContent.bytes.length },
        },
      ],
    }
    const manifestContext = { storeId, blobType: 'manifest' as const, protocolVersion: 1 }
    const sealedManifest = sealText(key, 'manifest', JSON.stringify(hostile), manifestContext)
    await h.remote.putBlob({ blobId: sealedManifest.blobId, bytes: sealedManifest.bytes })
    fs.writeFileSync(
      path.join(h.remoteDir, 'revisions', `${hostileId}.json`),
      JSON.stringify({
        id: hostileId,
        parents: [],
        deviceId: deviceA,
        createdAt: '2026-01-02T00:00:00.000Z',
        manifest: { id: sealedManifest.blobId, size: sealedManifest.bytes.length },
        digest: [],
      }),
    )

    const before = a.read('.claude/CLAUDE.md')
    await expect(h.run(a, deviceA)).rejects.toBeInstanceOf(ManifestError)
    expect(fs.existsSync(path.join(escapeDir, 'owned.txt'))).toBe(false)
    expect(a.read('.claude/CLAUDE.md')).toBe(before)
    a.cleanup()
    fs.rmSync(escapeDir, { recursive: true, force: true })
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('a remote that hides the newest revision is refused as a rollback', async () => {
    const h = harness()
    const a = engineHome(baseEntries)
    const b = engineHome(baseEntries)
    await h.run(a, deviceA)
    await h.run(b, deviceB)
    a.write('.claude/CLAUDE.md', '# shared rules\nA made the newest revision\n')
    await h.run(a, deviceA)
    const newest = (await h.remote.listRevisions()).heads[0]
    if (newest === undefined) throw new Error('missing head revision')

    const hiding: Remote = {
      ...h.remote,
      async listRevisions(options = {}) {
        const list = await h.remote.listRevisions(options)
        const revisions = list.revisions.filter((revision) => revision.id !== newest)
        const referenced = new Set<string>()
        for (const revision of revisions) {
          for (const parent of revision.parents) referenced.add(parent)
        }
        const heads = revisions
          .filter((revision) => !referenced.has(revision.id))
          .map((revision) => revision.id)
        return { revisions, head: heads.length === 1 ? (heads[0] ?? null) : null, heads }
      },
    }

    try {
      await h.run(a, deviceA, { remote: hiding })
      throw new Error('expected a rollback refusal')
    } catch (error) {
      expect(error).toBeInstanceOf(RemoteRollbackError)
      expect((error as RemoteRollbackError).lastKnown).toEqual([newest])
    }
    expect(a.read('.claude/CLAUDE.md')).toBe('# shared rules\nA made the newest revision\n')

    const recovered = await h.run(a, deviceA)
    expect(recovered.revisionId).not.toBeNull()
    await h.run(b, deviceB)
    expect(b.read('.claude/CLAUDE.md')).toBe('# shared rules\nA made the newest revision\n')
    a.cleanup()
    b.cleanup()
    fs.rmSync(h.remoteDir, { recursive: true, force: true })
  })

  test('two declared paths sharing one physical file download once and never defer', async () => {
    const linked = [...surfaces(), tree({ id: 'codex.skills', path: '$HOME/.codex/skills' })]
    const adapters = [testAdapter('claude', linked)]
    const h = harness()
    const a = engineHome([
      { kind: 'file', path: '.claude/skills/x/SKILL.md', content: '# v1\n' },
      { kind: 'file', path: '.codex/skills/x/SKILL.md', content: '# v1\n' },
    ])
    const b = engineHome([
      { kind: 'file', path: '.claude/skills/x/SKILL.md', content: '# v1\n' },
      { kind: 'dir', path: '.codex/skills' },
    ])
    fs.symlinkSync('../../.claude/skills/x', b.path('.codex/skills/x'), 'dir')
    try {
      await h.run(a, deviceA, { adapters })
      await h.run(b, deviceB, { adapters })
      a.write('.claude/skills/x/SKILL.md', '# v2\n')
      a.write('.codex/skills/x/SKILL.md', '# v2\n')
      await h.run(a, deviceA, { adapters })

      const report = await h.run(b, deviceB, { adapters })

      expect(report.deferred).toEqual([])
      expect(report.downloaded).toBe(1)
      expect(b.read('.claude/skills/x/SKILL.md')).toBe('# v2\n')
      expect(b.read('.codex/skills/x/SKILL.md')).toBe('# v2\n')
      expect(fs.lstatSync(b.path('.codex/skills/x')).isSymbolicLink()).toBe(true)
    } finally {
      a.cleanup()
      b.cleanup()
      fs.rmSync(h.remoteDir, { recursive: true, force: true })
    }
  })

  test('a remote entry under a surface exclude glob is neither downloaded nor tombstoned', async () => {
    const h = harness()
    const aSurfaces = [...surfaces(), tree({ id: 'codex.skills', path: '$HOME/.codex/skills' })]
    const bSurfaces = [
      ...surfaces(),
      tree({
        id: 'codex.skills',
        path: '$HOME/.codex/skills',
        exclude: ['.system', '.system/**'],
      }),
    ]
    const a = engineHome([
      { kind: 'file', path: '.codex/skills/.system/foo/SKILL.md', content: '# stale\n' },
    ])
    const b = engineHome([{ kind: 'dir', path: '.codex/skills' }])
    try {
      await h.run(a, deviceA, { adapters: [testAdapter('claude', aSurfaces)] })

      const report = await h.run(b, deviceB, { adapters: [testAdapter('claude', bSurfaces)] })

      expect(report.downloaded).toBe(0)
      expect(report.changed).toEqual([])
      expect(fs.existsSync(b.path('.codex/skills/.system/foo/SKILL.md'))).toBe(false)
      const manifest = await h.headManifest()
      const stale = manifest.entries.find(
        (entry) => entry.path === '$HOME/.codex/skills/.system/foo/SKILL.md',
      )
      expect(stale?.kind === 'tombstone').toBe(false)
    } finally {
      a.cleanup()
      b.cleanup()
      fs.rmSync(h.remoteDir, { recursive: true, force: true })
    }
  })
})
