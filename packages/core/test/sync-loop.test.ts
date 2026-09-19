import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DeviceId, type RevisionId, StoreId } from '@laurencio/protocol'
import { deriveMasterKey, type KdfParams, kdfParamsToWire } from '../src/crypto/kdf'
import type { DevicePolicy } from '../src/model'
import { createFileRemote } from '../src/remote/file'
import { DeviceAuthError, HttpRemoteError } from '../src/remote/http'
import type { Remote } from '../src/remote/types'
import { SyncState } from '../src/state'
import { LAST_SYNC_META_KEY, readLastSync, SyncLoop } from '../src/sync/loop'
import { parsePolicyToml } from '../src/sync/policy'
import { file, testAdapter } from './helpers/adapter-fixtures'
import { buildFakeHome, type FakeHome } from './helpers/fake-home'

const storeId = StoreId.parse('00000000000000000000000001')
const deviceId = DeviceId.parse('00000000000000000000000002')
const kdf: KdfParams = {
  algo: 'argon2id',
  salt: '00000000000000000000000000000000',
  m: 8,
  t: 1,
  p: 1,
  version: 0x13,
}
const key = deriveMasterKey('passphrase', kdf)

function tempDir(): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'laurencio-loop-'))
}

function makeRemote(dir: string) {
  return createFileRemote({
    dir,
    storeId,
    kdf: kdfParamsToWire(kdf, '2026-09-19T00:00:00.000Z'),
  })
}

interface FlakyRemote extends Remote {
  setOffline(value: boolean): void
}

function flaky(inner: Remote): FlakyRemote {
  let offline = false
  const guard = <T>(run: () => Promise<T>): Promise<T> => {
    if (offline) throw new HttpRemoteError('network', 'server unreachable')
    return run()
  }
  return {
    setOffline(value) {
      offline = value
    },
    getKdfParams: () => guard(() => inner.getKdfParams()),
    listRevisions: (options) => guard(() => inner.listRevisions(options)),
    getManifest: (revisionId) => guard(() => inner.getManifest(revisionId)),
    putBlob: (upload) => guard(() => inner.putBlob(upload)),
    getBlob: (blobId) => guard(() => inner.getBlob(blobId)),
    commit: (commit) => guard(() => inner.commit(commit)),
    listDevices: () => guard(() => inner.listDevices()),
  }
}

function surfaces() {
  return [
    file({ id: 'claude.instructions', path: '$HOME/.claude/CLAUDE.md', format: 'markdown' }),
    file({
      id: 'claude.settings',
      path: '$HOME/.claude/settings.json',
      format: 'jsonc',
      merge: 'jsonKeyMerge',
    }),
  ]
}

function buildHome(): FakeHome {
  return buildFakeHome({ entries: [{ kind: 'dir', path: '.claude' }] })
}

interface Sandbox {
  home: FakeHome
  remoteDir: string
  state: SyncState
  remote: FlakyRemote
  loop: SyncLoop
  close(): void
}

function sandbox(
  options: { policy?: DevicePolicy; remote?: Remote; key?: typeof key } = {},
): Sandbox {
  const home = buildHome()
  const remoteDir = tempDir()
  const inner = options.remote ?? makeRemote(remoteDir)
  const remote = flaky(inner)
  const state = SyncState.open({ path: path.join(home.home, '.laurencio', 'state.db') })
  const loop = new SyncLoop({
    adapters: [testAdapter('claude', surfaces())],
    ctx: home.ctx,
    deviceId,
    storeId,
    key: options.key ?? key,
    state,
    remote,
    quiescence: { windowMs: 0 },
    ...(options.policy !== undefined ? { policy: options.policy } : {}),
  })
  return {
    home,
    remoteDir,
    state,
    remote,
    loop,
    close() {
      state.close()
      home.cleanup()
      fs.rmSync(remoteDir, { recursive: true, force: true })
    },
  }
}

describe('SyncLoop', () => {
  test('runs, records, and goes idle without new writes', async () => {
    const box = sandbox()
    try {
      box.home.write('.claude/CLAUDE.md', '# rules\n')
      const first = await box.loop.runOnce()
      expect(first.status).toBe('synced')
      expect(first.report?.uploaded).toBe(1)
      const record = readLastSync(box.state)
      expect(record?.status).toBe('synced')
      expect(record?.uploaded).toBe(1)
      expect(box.state.getMeta(LAST_SYNC_META_KEY)).not.toBeNull()

      const second = await box.loop.runOnce()
      expect(second.status).toBe('idle')
      expect(second.report?.changed).toEqual([])
    } finally {
      box.close()
    }
  })

  test('queues an offline run and replays it after reconnect', async () => {
    const box = sandbox()
    try {
      box.home.write('.claude/CLAUDE.md', '# before offline\n')
      expect((await box.loop.runOnce()).status).toBe('synced')

      box.remote.setOffline(true)
      box.home.write('.claude/CLAUDE.md', '# written while offline\n')
      const offline = await box.loop.runOnce()
      expect(offline.status).toBe('offline')
      expect(offline.error?.name).toBe('HttpRemoteError')
      expect(box.state.listPendingOps().map((op) => op.kind)).toContain('sync')
      expect(readLastSync(box.state)?.status).toBe('offline')

      // A second offline run must not grow the queue with more markers.
      await box.loop.runOnce()
      expect(box.state.listPendingOps().filter((op) => op.kind === 'sync')).toHaveLength(1)

      box.remote.setOffline(false)
      const replayed = await box.loop.runOnce()
      expect(replayed.status).toBe('synced')
      expect(replayed.queue.pending).toBe(0)
      expect(box.state.listPendingOps()).toHaveLength(0)
      expect((await makeRemote(box.remoteDir).listRevisions()).head).not.toBeNull()
    } finally {
      box.close()
    }
  })

  test('honors harness surface toggles from the device policy', async () => {
    const policy = parsePolicyToml(`
[harnesses.claude.surfaces]
"claude.settings" = "off"
`)
    const box = sandbox({ policy })
    try {
      box.home.write('.claude/CLAUDE.md', '# instructions\n')
      box.home.write('.claude/settings.json', '{\n  "model": "opus"\n}\n')
      const result = await box.loop.runOnce()
      expect(result.status).toBe('synced')
      expect(result.report?.changed).toEqual(['$HOME/.claude/CLAUDE.md'])
      const revisionId = result.report?.revisionId ?? null
      expect(revisionId).not.toBeNull()
      const manifest = revisionId === null ? null : box.state.getManifest(revisionId as RevisionId)
      expect(manifest?.entries.map((entry) => entry.path)).toEqual(['$HOME/.claude/CLAUDE.md'])
      expect(fs.existsSync(box.home.path('.claude/settings.json'))).toBe(true)
    } finally {
      box.close()
    }
  })

  test('reports a revoked device as failed without queueing a retry', async () => {
    const deadDir = tempDir()
    const remote: Remote = {
      ...makeRemote(deadDir),
      listRevisions: async () => {
        throw new DeviceAuthError('the server rejected this device token (revoked).')
      },
    }
    const box = sandbox({ remote })
    try {
      const result = await box.loop.runOnce()
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('unauthenticated')
      expect(result.error?.message).toContain('laurencio login')
      expect(box.state.listPendingOps()).toHaveLength(0)
    } finally {
      box.close()
      fs.rmSync(deadDir, { recursive: true, force: true })
    }
  })

  test('reports a wrong passphrase as failed instead of throwing', async () => {
    const seeded = sandbox()
    const reader = sandbox({ remote: makeRemote(seeded.remoteDir) })
    try {
      seeded.home.write('.claude/CLAUDE.md', '# secret rules\n')
      expect((await seeded.loop.runOnce()).status).toBe('synced')

      // The second home has no base yet, so the engine decrypts the remote
      // manifest on its first run and fails authentication.
      const wrongKey = deriveMasterKey('not-the-passphrase', kdf)
      const readerLoop = new SyncLoop({ ...reader.loop.options, key: wrongKey })
      const result = await readerLoop.runOnce()
      expect(result.status).toBe('failed')
      expect(result.error?.code).toBe('auth-failed')
      expect(result.error?.message).toContain('authentication failed')
    } finally {
      seeded.close()
      reader.close()
    }
  })
})
