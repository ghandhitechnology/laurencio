import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, RevisionId, StoreId } from '@laurencio/protocol'
import { open } from '../src/crypto/aead'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import { type SyncOptions, sync } from '../src/engine'
import type { SyncReport } from '../src/model'
import { createFileRemote, type FileRemote } from '../src/remote/file'
import { SyncState, stateDbPath } from '../src/state'
import type { Surface } from '../src/types'
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

interface Harness {
  remote: FileRemote
  remoteDir: string
  ids: Ids
  run(home: FakeHome, deviceId: DeviceId, hooks?: SyncOptions['hooks']): Promise<SyncReport>
  revisionCount(): Promise<number>
  headManifest(): Promise<import('../src/model').Manifest>
  scanRemoteBytes(): string
}

function harness(): Harness {
  const remoteDir = tempDir()
  const remote = createFileRemote({
    dir: remoteDir,
    storeId,
    kdf: kdfParamsToWire(kdf, createdAt),
    now: () => new Date(createdAt),
  })
  const ids = new Ids()
  const adapters = [testAdapter('claude', surfaces())]
  return {
    remote,
    remoteDir,
    ids,
    async run(home, deviceId, hooks) {
      const state = SyncState.open({ path: stateDbPath(home.home) })
      try {
        return await sync({
          adapters,
          ctx: home.ctx,
          deviceId,
          storeId,
          key,
          state,
          remote,
          quiescence: { windowMs: 0 },
          now: () => new Date(createdAt),
          createRevisionId: () => ids.revision(),
          ...(hooks !== undefined ? { hooks } : {}),
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
    await expect(h.run(a, deviceA, failing)).rejects.toThrow('simulated crash')

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
})
