import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BlobId, DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import {
  Applier,
  hashContent,
  NonEmptyDirectoryError,
  NotInPlanError,
  StaleWriteError,
} from '../src/apply'
import { SyncState, stateDbPath } from '../src/state'
import { buildFakeHome } from './helpers/fake-home'

const deviceId = DeviceId.parse('00000000000000000000000001')
const revisionId = RevisionId.parse('00000000000000000000000002')
const surfaceId = SurfaceId.parse('claude.settings')

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-apply-'))
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

function makeApplier(options: {
  home: string
  planPaths: string[]
  hooks?: ConstructorParameters<typeof Applier>[0]['hooks']
}) {
  const home = options.home
  fs.mkdirSync(path.join(home, '.laurencio'), { recursive: true })
  const state = SyncState.open({ path: stateDbPath(home) })
  const applier = new Applier({
    state,
    planPaths: options.planPaths,
    platform: 'darwin',
    ...(options.hooks !== undefined ? { hooks: options.hooks } : {}),
  })
  return { state, applier }
}

describe('Applier', () => {
  test('writes atomically and leaves no journal or temp files behind', () => {
    const home = tempDir()
    const target = path.join(home, '.claude', 'settings.json')
    const { state, applier } = makeApplier({ home, planPaths: [target] })
    const result = applier.write({
      storePath: '$HOME/.claude/settings.json',
      declaredPath: target,
      content: '{"model":"opus"}\n',
      mode: 0o600,
    })
    expect(result.hash).toBe(hashContent('{"model":"opus"}\n'))
    expect(fs.readFileSync(target, 'utf8')).toBe('{"model":"opus"}\n')
    expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    expect(state.listJournal()).toEqual([])
    expect(
      fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.laurencio-')),
    ).toEqual([])
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('compare-and-swap refuses to replace a changed file and does not touch it', () => {
    const home = tempDir()
    const target = path.join(home, 'settings.json')
    fs.writeFileSync(target, 'old')
    const { state, applier } = makeApplier({ home, planPaths: [target] })
    const before = applier.fingerprint(target)
    expect(before).not.toBeNull()
    fs.writeFileSync(target, 'changed by the harness')
    expect(() =>
      applier.write({ storePath: 's', declaredPath: target, content: 'merged', expected: before }),
    ).toThrow(StaleWriteError)
    expect(fs.readFileSync(target, 'utf8')).toBe('changed by the harness')

    expect(() =>
      applier.write({ storePath: 's', declaredPath: target, content: 'new', expected: null }),
    ).toThrow(StaleWriteError)
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('refuses any path the plan did not declare', () => {
    const home = tempDir()
    const allowed = path.join(home, 'allowed.txt')
    const { state, applier } = makeApplier({ home, planPaths: [allowed] })
    expect(() =>
      applier.write({ storePath: 'x', declaredPath: path.join(home, 'other.txt'), content: 'x' }),
    ).toThrow(NotInPlanError)
    expect(applier.isAllowed(path.join(home, 'allowed.txt.conflict-dev-20260101T000000Z'))).toBe(
      true,
    )
    expect(applier.isAllowed(path.join(home, 'other.txt'))).toBe(false)
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('writes through a symlink and never replaces the link', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.agents/skills' },
        { kind: 'dir', path: '.claude' },
        { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
      ],
    })
    const declared = home.path('.claude/skills/SKILL.md')
    const owner = home.path('.agents/skills/SKILL.md')
    const { state, applier } = makeApplier({ home: home.home, planPaths: [declared, owner] })
    applier.write({ storePath: 'skills.SKILL', declaredPath: declared, content: '# skill\n' })
    expect(fs.readFileSync(owner, 'utf8')).toBe('# skill\n')
    expect(fs.lstatSync(home.path('.claude/skills')).isSymbolicLink()).toBe(true)
    state.close()
    home.cleanup()
  })

  test('copy mode keeps both real copies in step', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.agents/skills' },
        { kind: 'file', path: '.agents/skills/SKILL.md', content: 'old' },
        { kind: 'dir', path: '.claude' },
        { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
      ],
      linkMode: 'copy',
    })
    const declared = home.path('.claude/skills/SKILL.md')
    const owner = home.path('.agents/skills/SKILL.md')
    const state = SyncState.open({ path: stateDbPath(home.home) })
    const applier = new Applier({
      state,
      planPaths: [declared, owner],
      platform: 'win32',
      copyMode: true,
      layout: {
        deviceId,
        entries: [
          {
            path: home.path('.claude/skills'),
            mode: 'symlink',
            linkTarget: home.path('.agents/skills'),
          },
        ],
      },
    })
    applier.write({ storePath: 'skills.SKILL', declaredPath: declared, content: 'new' })
    expect(fs.readFileSync(declared, 'utf8')).toBe('new')
    expect(fs.readFileSync(owner, 'utf8')).toBe('new')
    state.close()
    home.cleanup()
  })

  test('compare-and-swap guards every copy-mode mirror, not only the first path', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.agents/skills' },
        { kind: 'file', path: '.agents/skills/SKILL.md', content: 'old' },
        { kind: 'dir', path: '.claude' },
        { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
      ],
      linkMode: 'copy',
    })
    const declared = home.path('.claude/skills/SKILL.md')
    const owner = home.path('.agents/skills/SKILL.md')
    const state = SyncState.open({ path: stateDbPath(home.home) })
    const applier = new Applier({
      state,
      planPaths: [declared, owner],
      platform: 'win32',
      copyMode: true,
      layout: {
        deviceId,
        entries: [
          {
            path: home.path('.claude/skills'),
            mode: 'symlink',
            linkTarget: home.path('.agents/skills'),
          },
        ],
      },
    })
    const before = applier.fingerprint(declared)
    fs.writeFileSync(owner, 'changed by the harness')
    expect(() =>
      applier.write({
        storePath: 'skills.SKILL',
        declaredPath: declared,
        content: 'new',
        expected: before,
      }),
    ).toThrow(StaleWriteError)
    // Validation happens before any write: the first mirror is untouched too.
    expect(fs.readFileSync(declared, 'utf8')).toBe('old')
    expect(fs.readFileSync(owner, 'utf8')).toBe('changed by the harness')
    state.close()
    home.cleanup()
  })

  test('a target swapped between read and rename is refused and left unplanned', () => {
    const home = buildFakeHome({
      entries: [
        { kind: 'dir', path: '.agents/skills' },
        { kind: 'dir', path: '.agents/other' },
        { kind: 'dir', path: '.claude' },
        { kind: 'dir', path: '.claude/skills', link: '$HOME/.agents/skills' },
      ],
    })
    const declared = home.path('.claude/skills/SKILL.md')
    const owner = home.path('.agents/skills/SKILL.md')
    const swapped = home.path('.agents/other/SKILL.md')
    const { state, applier } = makeApplier({
      home: home.home,
      planPaths: [declared, owner, swapped],
      hooks: {
        beforeRename: () => {
          fs.rmSync(home.path('.agents/skills'), { recursive: true, force: true })
          fs.symlinkSync(home.path('.agents/other'), home.path('.agents/skills'), 'dir')
        },
      },
    })
    expect(() =>
      applier.write({ storePath: 'skill', declaredPath: declared, content: '# new\n' }),
    ).toThrow(StaleWriteError)
    expect(fs.existsSync(swapped)).toBe(false)
    expect(fs.lstatSync(home.path('.claude/skills')).isSymbolicLink()).toBe(true)
    expect(state.listJournal()).toEqual([])
    expect(leftoverTemps(home.home)).toEqual([])
    state.close()
    home.cleanup()
  })

  test('deletions remove files, refuse non-empty directories, and leave tombstones', () => {
    const home = tempDir()
    const base = {
      id: revisionId,
      deviceId,
      parents: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      manifest: { id: BlobId.parse('a'.repeat(64)), size: 1 },
      digest: [],
      role: 'base' as const,
    }
    const file = path.join(home, 'settings.json')
    fs.writeFileSync(file, '{}')
    fs.mkdirSync(path.join(home, 'tree'))
    fs.writeFileSync(path.join(home, 'tree', 'kept.txt'), 'kept')
    const { state, applier } = makeApplier({
      home,
      planPaths: [file, path.join(home, 'tree')],
    })
    state.saveManifest(base, [
      {
        surfaceId,
        path: '$HOME/settings.json',
        kind: 'file',
        hash: hashContent('{}'),
        size: 2,
        mode: 0o644,
      },
      {
        surfaceId,
        path: '$HOME/tree/kept.txt',
        kind: 'file',
        hash: hashContent('kept'),
        size: 4,
        mode: 0o644,
      },
    ])

    applier.remove({
      storePath: '$HOME/settings.json',
      surfaceId,
      declaredPath: file,
      baseRevision: revisionId,
    })
    expect(fs.existsSync(file)).toBe(false)
    expect(
      state.getManifest(revisionId)?.entries.find((entry) => entry.kind === 'tombstone')?.path,
    ).toBe('$HOME/settings.json')

    expect(() =>
      applier.remove({
        storePath: '$HOME/tree',
        surfaceId,
        declaredPath: path.join(home, 'tree'),
      }),
    ).toThrow(NonEmptyDirectoryError)
    expect(fs.existsSync(path.join(home, 'tree', 'kept.txt'))).toBe(true)
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a crash between intent and rename is rolled back on reconciliation', () => {
    const home = tempDir()
    const target = path.join(home, 'settings.json')
    fs.writeFileSync(target, 'old')
    let crashed = false
    const { state, applier } = makeApplier({
      home,
      planPaths: [target],
      hooks: {
        beforeRename: () => {
          if (!crashed) {
            crashed = true
            throw new Error('simulated crash')
          }
        },
      },
    })
    expect(() =>
      applier.write({
        storePath: 's',
        declaredPath: target,
        content: 'new',
        expected: applier.fingerprint(target),
      }),
    ).toThrow('simulated crash')
    expect(state.listJournal()).toHaveLength(1)
    const report = state.reconcile()
    expect(report.rolledBack).toHaveLength(1)
    expect(fs.readFileSync(target, 'utf8')).toBe('old')
    expect(fs.readdirSync(home).filter((name) => name.startsWith('.laurencio-'))).toEqual([])
    // The rerun then succeeds and leaves nothing behind.
    applier.write({
      storePath: 's',
      declaredPath: target,
      content: 'new',
      expected: applier.fingerprint(target),
    })
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(state.listJournal()).toEqual([])
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('a crash after the rename is adopted, not rolled back, on reconciliation', () => {
    const home = tempDir()
    const target = path.join(home, 'settings.json')
    fs.writeFileSync(target, 'old')
    const { state, applier } = makeApplier({
      home,
      planPaths: [target],
      hooks: {
        afterRename: () => {
          throw new Error('simulated crash')
        },
      },
    })
    expect(() =>
      applier.write({
        storePath: 's',
        declaredPath: target,
        content: 'new',
        expected: applier.fingerprint(target),
      }),
    ).toThrow('simulated crash')
    // The rename landed before the kill: the target holds the new content and
    // the journal still says intent.
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(state.listJournal()).toHaveLength(1)
    const report = state.reconcile()
    expect(report.adopted).toHaveLength(1)
    expect(report.rolledBack).toEqual([])
    expect(fs.readFileSync(target, 'utf8')).toBe('new')
    expect(state.listJournal()).toEqual([])
    state.close()
    fs.rmSync(home, { recursive: true, force: true })
  })
})
