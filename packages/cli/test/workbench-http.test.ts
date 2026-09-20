import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  builtinAdapters,
  createHttpRemote,
  crypto,
  migrateManifestToProfile,
  parseManifest,
  SyncLoop,
  SyncState,
} from '@laurencio/core'
import { DeviceId, StoreId } from '@laurencio/protocol'
import { createTestServer, createUser, type TestServer } from '../../server/test/helpers'
import { parseCliArgs } from '../src/args'
import { createContext } from '../src/context'
import { createWorkbenchClient } from '../src/workbench/client'
import type { WorkbenchMaterializeInput } from '../src/workbench/controller'
import { materializeWorkbench } from '../src/workbench/materialize'
import { loadPortableProfile, savePortableProfile } from '../src/workbench/profile'
import { saveWorkbenchChanges } from '../src/workbench/save'
import { KDF, makeScratch, PASSPHRASE, readHomeFile, writeHomeFile } from './helpers'

test('HTTP temporary save advances files without profile privileges and can be materialized again', async () => {
  const source = makeScratch()
  const host = makeScratch()
  const key = crypto.deriveMasterKey(PASSPHRASE, { ...KDF, m: 19_456, t: 2 })
  let server: TestServer | undefined
  let temporaryToken = ''
  let temporaryProfileWrites = 0
  const listener = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (
        request.method === 'PUT' &&
        new URL(request.url).pathname.endsWith('/profile') &&
        request.headers.get('authorization') === `Bearer ${temporaryToken}`
      ) {
        temporaryProfileWrites += 1
      }
      if (server === undefined) throw new Error('test server is not ready')
      return server.app.fetch(request)
    },
  })
  const baseUrl = listener.url.toString()
  try {
    server = await createTestServer({ FS_STORAGE_BASE_URL: baseUrl })
    const user = await createUser(server, 'temporary-http-save@example.com')
    const storeId = StoreId.parse(user.storeId)
    const fullRemote = createHttpRemote({ baseUrl, storeId, token: user.token })
    await fullRemote.putKdfParams({ params: { ...KDF, m: 19_456, t: 2 } })
    await fullRemote.migrateProfileVersion()
    writeHomeFile(source.home, '.codex/AGENTS.md', 'original codex instructions\n')
    writeHomeFile(source.home, '.claude/CLAUDE.md', 'original claude instructions\n')
    const state = SyncState.open({ home: source.home })
    try {
      const seeded = await new SyncLoop({
        adapters: builtinAdapters,
        ctx: { home: source.home, platform: 'darwin', env: { HOME: source.home }, probes: {} },
        deviceId: DeviceId.parse(user.deviceId),
        storeId,
        key,
        state,
        remote: fullRemote,
        quiescence: { windowMs: 0 },
      }).runOnce()
      expect(seeded.status).toBe('synced')
    } finally {
      state.close()
    }
    const originalRevision = (await fullRemote.listRevisions()).head
    if (originalRevision === null) throw new Error('expected seeded revision')
    const ciphertext = await fullRemote.getManifest(originalRevision)
    const manifest = parseManifest(
      JSON.parse(
        crypto.openText(key, 'manifest', ciphertext, {
          storeId,
          blobType: 'manifest',
          protocolVersion: 1,
        }),
      ),
    )
    ciphertext.fill(0)
    const profileHead = await savePortableProfile({
      remote: fullRemote,
      storeId,
      key,
      profile: {
        ...migrateManifestToProfile(manifest),
        shared: { keybindings: {}, layout: { columns: '132' } },
        vault: [],
      },
      expectedGeneration: null,
    })
    const client = createWorkbenchClient({ baseUrl, bearer: user.token })
    const first = await client.create({ name: 'first temporary session', platform: 'darwin' })
    temporaryToken = first.token
    const ctx = createContext('open', null, [], parseCliArgs(['open', '--yes']).flags, {
      home: host.home,
      cwd: host.home,
      platform: 'darwin',
      env: { HOME: host.home },
      probes: {},
      quiescence: { windowMs: 0 },
      curatedTools: [],
    })
    const firstRoot = path.join(host.home, 'first')
    const firstHome = path.join(firstRoot, 'home')
    fs.mkdirSync(firstHome, { recursive: true })
    const input: WorkbenchMaterializeInput = {
      server: baseUrl,
      token: first.token,
      root: firstRoot,
      home: firstHome,
      environment: {},
      executables: { tmux: '/bin/tmux', shell: '/bin/zsh' },
      remote: first.session,
    }
    expect(await materializeWorkbench(ctx, input, PASSPHRASE)).toBe(originalRevision)
    writeHomeFile(firstHome, '.codex/AGENTS.md', 'saved codex instructions\n')
    writeHomeFile(firstHome, '.claude/CLAUDE.md', 'unselected claude edit\n')
    const saved = await saveWorkbenchChanges(ctx, {
      record: {
        remote: first.session,
        server: baseUrl,
        revisionId: originalRevision,
        runtime: {
          id: first.session.id,
          root: firstRoot,
          home: firstHome,
          cwd: host.home,
          platform: 'darwin',
          executable: '/bin/tmux',
          configPath: path.join(firstRoot, 'tmux.conf'),
          socketPath: path.join(firstRoot, 'tmux.sock'),
        },
      },
      token: first.token,
      passphrase: PASSPHRASE,
      harnesses: [],
      surface: 'codex.instructions',
    })
    expect(saved.status).toBe('synced')
    expect(temporaryProfileWrites).toBe(0)
    const savedRevision = (await fullRemote.listRevisions()).head
    expect(savedRevision).not.toBe(originalRevision)
    if (savedRevision === null) throw new Error('expected saved revision')
    expect(await fullRemote.getProfileHead()).toEqual(profileHead)
    const profile = await loadPortableProfile({ remote: fullRemote, storeId, key })
    expect(profile?.profile.manifest.revisionId).toBe(originalRevision)

    const temporaryRemote = createHttpRemote({ baseUrl, storeId, token: first.token })
    await expect(
      temporaryRemote.putProfileHead({
        blob: profileHead.blob,
        expectedGeneration: profileHead.generation,
      }),
    ).rejects.toMatchObject({ status: 403, code: 'forbidden' })
    expect(temporaryProfileWrites).toBe(1)
    expect(await fullRemote.getProfileHead()).toEqual(profileHead)

    const second = await client.create({ name: 'second temporary session', platform: 'darwin' })
    const secondRoot = path.join(host.home, 'second')
    const secondHome = path.join(secondRoot, 'home')
    fs.mkdirSync(secondHome, { recursive: true })
    expect(
      await materializeWorkbench(
        ctx,
        {
          ...input,
          token: second.token,
          root: secondRoot,
          home: secondHome,
          remote: second.session,
        },
        PASSPHRASE,
      ),
    ).toBe(savedRevision)
    expect(readHomeFile(secondHome, '.codex/AGENTS.md')).toBe('saved codex instructions\n')
    expect(readHomeFile(secondHome, '.claude/CLAUDE.md')).toBe('original claude instructions\n')
    expect(JSON.parse(readHomeFile(secondRoot, 'terminal-settings.json'))).toEqual({
      keybindings: {},
      layout: { columns: '132' },
    })
    expect(await fullRemote.getProfileHead()).toEqual(profileHead)
    expect((await fullRemote.listRevisions()).head).toBe(savedRevision)
  } finally {
    listener.stop(true)
    await server?.close()
    key.zeroize()
    source.cleanup()
    host.cleanup()
  }
}, 30_000)
