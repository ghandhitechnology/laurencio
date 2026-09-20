import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createFileRemote, crypto, type Remote, supportsVault } from '@laurencio/core'
import { DeviceId, WorkbenchSessionId } from '@laurencio/protocol'
import { parseCliArgs } from '../src/args'
import { createContext } from '../src/context'
import type { WorkbenchMaterializeInput } from '../src/workbench/controller'
import { captureWorkbenchSnapshot, materializeWorkbench } from '../src/workbench/materialize'
import { saveWorkbenchChanges } from '../src/workbench/save'
import {
  KDF,
  makeScratch,
  PASSPHRASE,
  runForTest,
  STORE_ID,
  seedStore,
  writeHomeFile,
} from './helpers'

describe('temporary workbench materialization', () => {
  test('materializes skills when macOS aliases the temporary root through /private', async () => {
    const source = makeScratch()
    const host = makeScratch()
    try {
      const seeded = await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(
        source.home,
        '.agents/skills/ask-matt/PHASE-BOUNDARIES.md',
        '# Phase boundaries\n',
      )
      const enrolled = await runForTest(['init', '--yes'], {
        home: source.home,
        remoteDir: source.remoteDir,
      })
      expect(enrolled.exitCode).toBe(0)
      const remote = createFileRemote({ dir: source.remoteDir })
      const head = (await remote.listRevisions()).head
      if (head === null) throw new Error('expected enrolled revision')
      const manifest = JSON.parse(
        crypto.openText(seeded.key, 'manifest', await remote.getManifest(head), {
          storeId: STORE_ID,
          blobType: 'manifest',
          protocolVersion: 1,
        }),
      ) as { entries: { path: string; surfaceId: string }[] }
      expect(
        manifest.entries.some(
          (entry) =>
            entry.path === '$HOME/.agents/skills/ask-matt/PHASE-BOUNDARIES.md' &&
            entry.surfaceId === 'codex.agents-skills',
        ),
      ).toBe(true)

      const aliasedHost = host.home.replace(/^\/private(?=\/var\/)/, '')
      const privateHome = path.join(aliasedHost, 'runtime', 'home')
      fs.mkdirSync(privateHome, { recursive: true })
      const ctx = createContext('open', null, [], parseCliArgs(['open', '--yes']).flags, {
        home: host.home,
        cwd: host.home,
        platform: 'darwin',
        env: { HOME: host.home },
        probes: {},
        quiescence: { windowMs: 0 },
        curatedTools: [],
        remote: () => createFileRemote({ dir: source.remoteDir }),
        fetch: (async () =>
          Response.json({
            protocolVersion: 1,
            userId: '00000000000000000000000009',
            storeId: STORE_ID,
            devices: [],
            kdf: null,
            quotas: { blobs: 0, bytes: 0, maxBytes: 100_000 },
          })) as unknown as typeof fetch,
      })
      const remoteSession = {
        id: WorkbenchSessionId.parse('00000000000000000000000007'),
        deviceId: DeviceId.parse('00000000000000000000000008'),
        name: 'temporary',
        platform: 'darwin',
        createdAt: '2026-09-20T00:00:00.000Z',
        expiresAt: '2026-09-21T00:00:00.000Z',
      } as const

      await materializeWorkbench(
        ctx,
        {
          server: 'https://laurencio.test',
          token: 'lrn_temporary-token',
          root: path.dirname(privateHome),
          home: privateHome,
          environment: {},
          executables: { tmux: '/bin/tmux', shell: '/bin/zsh' },
          remote: remoteSession,
        },
        PASSPHRASE,
      )

      expect(
        fs.readFileSync(
          path.join(privateHome, '.agents/skills/ask-matt/PHASE-BOUNDARIES.md'),
          'utf8',
        ),
      ).toBe('# Phase boundaries\n')
    } finally {
      source.cleanup()
      host.cleanup()
    }
  })

  test('retries vault rotation and rejects heads that never stabilize without publishing', async () => {
    const source = makeScratch()
    const key = crypto.deriveMasterKey(PASSPHRASE, KDF)
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.codex/config.toml', 'model = "stable"\n')
      writeHomeFile(source.home, '.codex/auth.json', '{"token":"credential"}\n')
      expect(
        (await runForTest(['init', '--yes'], { home: source.home, remoteDir: source.remoteDir }))
          .exitCode,
      ).toBe(0)
      const remote = createFileRemote({ dir: source.remoteDir })
      const vault = await remote.getVaultHead()
      if (vault === null) throw new Error('expected vault fixture')
      let reads = 0
      const racing = {
        ...remote,
        getVaultHead: async () => ({ ...vault, generation: ++reads === 1 ? 1 : 2 }),
      }
      const snapshot = await captureWorkbenchSnapshot(racing, STORE_ID, key)
      expect(reads).toBe(4)
      if (!supportsVault(snapshot.remote)) throw new Error('expected pinned vault')
      expect((await snapshot.remote.getVaultHead())?.generation).toBe(2)
      await expect(
        snapshot.remote.putVaultHead({ blob: vault.blob, expectedGeneration: 2 }),
      ).rejects.toThrow('cannot publish')
      const unstable = { ...remote, getVaultHead: async () => ({ ...vault, generation: ++reads }) }
      await expect(captureWorkbenchSnapshot(unstable, STORE_ID, key)).rejects.toThrow(
        'being updated',
      )
    } finally {
      key.zeroize()
      source.cleanup()
    }
  })
  test('retries concurrent publication and freezes a consistent revision and profile', async () => {
    const source = makeScratch()
    const host = makeScratch()
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.codex/config.toml', 'model = "captured"\n')
      const enrolled = await runForTest(['init', '--yes'], {
        home: source.home,
        remoteDir: source.remoteDir,
      })
      expect(enrolled.exitCode).toBe(0)
      const toolLock = path.join(source.home, 'tools.json')
      const selectedTools = [
        {
          name: 'powershell',
          platform: 'win32' as const,
          arch: 'x64',
          version: '7.6.6',
          url: 'https://tools.test/powershell.zip',
          sha256: '0'.repeat(64),
        },
      ]
      fs.writeFileSync(toolLock, JSON.stringify(selectedTools))
      const tools = await runForTest(['tools', 'update', toolLock, '--yes'], {
        home: source.home,
        remoteDir: source.remoteDir,
        deps: { curatedTools: selectedTools },
      })
      expect(tools.exitCode).toBe(0)

      const realRemote = createFileRemote({ dir: source.remoteDir })
      const capturedRevision = (await realRemote.listRevisions()).head
      if (capturedRevision === null) throw new Error('expected an enrolled revision')
      let advanced = false
      let temporaryCommits = 0
      const racingRemote: Remote = {
        ...realRemote,
        async listRevisions(options) {
          const snapshot = await realRemote.listRevisions(options)
          if (!advanced) {
            advanced = true
            writeHomeFile(source.home, '.codex/config.toml', 'model = "advanced"\n')
            const synced = await runForTest(['sync'], {
              home: source.home,
              remoteDir: source.remoteDir,
            })
            expect(synced.exitCode).toBe(0)
          }
          return snapshot
        },
        async commit(input) {
          temporaryCommits += 1
          return realRemote.commit(input)
        },
      }

      const privateHome = path.join(host.home, 'runtime', 'home')
      fs.mkdirSync(privateHome, { recursive: true })
      const ctx = createContext('open', null, [], parseCliArgs(['open', '--yes']).flags, {
        home: host.home,
        cwd: host.home,
        platform: 'darwin',
        env: { HOME: host.home },
        probes: {},
        quiescence: { windowMs: 0 },
        curatedTools: selectedTools,
        remote: () => racingRemote,
        fetch: (async (_input: string | URL | Request) =>
          Response.json({
            protocolVersion: 1,
            userId: '00000000000000000000000009',
            storeId: STORE_ID,
            devices: [],
            kdf: null,
            quotas: { blobs: 0, bytes: 0, maxBytes: 100_000 },
          })) as typeof fetch,
      })
      const remoteSession = {
        id: WorkbenchSessionId.parse('00000000000000000000000007'),
        deviceId: DeviceId.parse('00000000000000000000000008'),
        name: 'temporary',
        platform: 'darwin',
        createdAt: '2026-09-20T00:00:00.000Z',
        expiresAt: '2026-09-21T00:00:00.000Z',
      } as const

      const revisionId = await materializeWorkbench(
        ctx,
        {
          server: 'https://laurencio.test',
          token: 'lrn_temporary-token',
          root: path.dirname(privateHome),
          home: privateHome,
          environment: {},
          executables: { tmux: '/bin/tmux', shell: '/bin/zsh' },
          remote: remoteSession,
        },
        PASSPHRASE,
      )

      expect((await realRemote.listRevisions()).head).toBe(revisionId)
      expect(fs.readFileSync(path.join(privateHome, '.codex/config.toml'), 'utf8')).toContain(
        'advanced',
      )
      expect((await realRemote.listRevisions()).head).not.toBe(capturedRevision)
      expect(temporaryCommits).toBe(0)
    } finally {
      source.cleanup()
      host.cleanup()
    }
  })

  test('reuses verified public-tool cache entries across temporary launches', async () => {
    const source = makeScratch()
    const host = makeScratch()
    const toolBytes = new TextEncoder().encode('cached-ripgrep')
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.codex/config.toml', 'model = "portable"\n')
      expect(
        (
          await runForTest(['init', '--yes'], {
            home: source.home,
            remoteDir: source.remoteDir,
          })
        ).exitCode,
      ).toBe(0)
      const toolLock = path.join(source.home, 'tools.json')
      const selectedTools = [
        {
          name: 'ripgrep',
          platform: 'darwin' as const,
          arch: 'arm64',
          version: '14.1.1',
          url: 'https://tools.test/rg',
          sha256: createHash('sha256').update(toolBytes).digest('hex'),
        },
      ]
      fs.writeFileSync(toolLock, JSON.stringify(selectedTools))
      expect(
        (
          await runForTest(['tools', 'update', toolLock, '--yes'], {
            home: source.home,
            remoteDir: source.remoteDir,
            deps: {
              architecture: 'arm64',
              curatedTools: selectedTools,
              fetch: (async () => new Response(toolBytes)) as unknown as typeof fetch,
            },
          })
        ).exitCode,
      ).toBe(0)

      let toolDownloads = 0
      const ctx = createContext('open', null, [], parseCliArgs(['open', '--yes']).flags, {
        home: host.home,
        cwd: host.home,
        platform: 'darwin',
        env: { HOME: host.home },
        probes: {},
        quiescence: { windowMs: 0 },
        remote: () => createFileRemote({ dir: source.remoteDir }),
        architecture: 'arm64',
        curatedTools: selectedTools,
        fetch: (async (input: string | URL | Request) => {
          if (String(input) === 'https://tools.test/rg') {
            toolDownloads += 1
            return new Response(toolBytes)
          }
          return Response.json({
            protocolVersion: 1,
            userId: '00000000000000000000000009',
            storeId: STORE_ID,
            devices: [],
            kdf: null,
            quotas: { blobs: 0, bytes: 0, maxBytes: 100_000 },
          })
        }) as typeof fetch,
      })
      const remoteSession = {
        id: WorkbenchSessionId.parse('00000000000000000000000007'),
        deviceId: DeviceId.parse('00000000000000000000000008'),
        name: 'temporary',
        platform: 'darwin',
        createdAt: '2026-09-20T00:00:00.000Z',
        expiresAt: '2026-09-21T00:00:00.000Z',
      } as const

      for (const name of ['first', 'second']) {
        const root = path.join(host.home, name)
        const home = path.join(root, 'home')
        fs.mkdirSync(home, { recursive: true })
        await materializeWorkbench(
          ctx,
          {
            server: 'https://laurencio.test',
            token: `lrn_${name}-temporary-token`,
            root,
            home,
            environment: {},
            executables: { tmux: '/bin/tmux', shell: '/bin/zsh' },
            remote: {
              ...remoteSession,
              ...(name === 'second'
                ? { id: WorkbenchSessionId.parse('00000000000000000000000006') }
                : {}),
            },
          },
          PASSPHRASE,
          { persistentCache: true },
        )
      }

      expect(toolDownloads).toBe(1)
      expect(
        fs.readFileSync(
          path.join(host.home, '.laurencio/tools/ripgrep/14.1.1/darwin-arm64/rg'),
          'utf8',
        ),
      ).toBe('cached-ripgrep')
    } finally {
      source.cleanup()
      host.cleanup()
    }
  })

  test('skips a pinned tool the host already provides', async () => {
    const source = makeScratch()
    const host = makeScratch()
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.codex/config.toml', 'model = "portable"\n')
      expect(
        (
          await runForTest(['init', '--yes'], {
            home: source.home,
            remoteDir: source.remoteDir,
          })
        ).exitCode,
      ).toBe(0)
      const selectedTools = [
        {
          name: 'tmux',
          platform: 'darwin' as const,
          arch: 'arm64',
          version: '3.5.0',
          url: 'https://tools.test/tmux',
          sha256: '0'.repeat(64),
        },
      ]
      let toolDownloads = 0
      const ctx = createContext('open', null, [], parseCliArgs(['open', '--yes']).flags, {
        home: host.home,
        cwd: host.home,
        platform: 'darwin',
        env: { HOME: host.home },
        probes: {},
        quiescence: { windowMs: 0 },
        remote: () => createFileRemote({ dir: source.remoteDir }),
        architecture: 'arm64',
        curatedTools: selectedTools,
        fetch: (async (input: string | URL | Request) => {
          if (String(input) === 'https://tools.test/tmux') {
            toolDownloads += 1
            return new Response('tmux')
          }
          return Response.json({
            protocolVersion: 1,
            userId: '00000000000000000000000009',
            storeId: STORE_ID,
            devices: [],
            kdf: null,
            quotas: { blobs: 0, bytes: 0, maxBytes: 100_000 },
          })
        }) as typeof fetch,
      })
      const privateHome = path.join(host.home, 'runtime', 'home')
      fs.mkdirSync(privateHome, { recursive: true })
      const executables: WorkbenchMaterializeInput['executables'] = {
        tmux: '/usr/bin/tmux',
        shell: '/bin/zsh',
      }
      await materializeWorkbench(
        ctx,
        {
          server: 'https://laurencio.test',
          token: 'lrn_temporary-token',
          root: path.dirname(privateHome),
          home: privateHome,
          environment: {},
          executables,
          remote: {
            id: WorkbenchSessionId.parse('00000000000000000000000007'),
            deviceId: DeviceId.parse('00000000000000000000000008'),
            name: 'temporary',
            platform: 'darwin',
            createdAt: '2026-09-20T00:00:00.000Z',
            expiresAt: '2026-09-21T00:00:00.000Z',
          },
        },
        PASSPHRASE,
      )
      expect(toolDownloads).toBe(0)
      expect(executables.tmux).toBe('/usr/bin/tmux')
      expect(fs.existsSync(path.join(path.dirname(privateHome), 'tools'))).toBe(false)
    } finally {
      source.cleanup()
      host.cleanup()
    }
  })

  test('writes only the private home and leaves host configuration and project files unchanged', async () => {
    const source = makeScratch()
    const host = makeScratch()
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.codex/config.toml', 'model = "portable"\n')
      writeHomeFile(source.home, '.codex/auth.json', '{"token":"portable-login"}\n')
      writeHomeFile(source.home, '.claude/CLAUDE.md', 'portable instructions\n')
      const pushed = await runForTest(['init', '--yes'], {
        home: source.home,
        remoteDir: source.remoteDir,
      })
      expect(pushed.exitCode).toBe(0)
      const toolBytes = new TextEncoder().encode('portable-ripgrep')
      const toolHash = createHash('sha256').update(toolBytes).digest('hex')
      const tmuxBytes = new TextEncoder().encode('portable-tmux')
      const tmuxHash = createHash('sha256').update(tmuxBytes).digest('hex')
      const toolLock = path.join(source.home, 'tools.json')
      const selectedTools = [
        {
          name: 'ripgrep',
          platform: 'darwin' as const,
          arch: 'arm64',
          version: '14.1.1',
          url: 'https://tools.test/rg',
          sha256: toolHash,
        },
        {
          name: 'tmux',
          platform: 'darwin' as const,
          arch: 'arm64',
          version: '3.5.0',
          url: 'https://tools.test/tmux',
          sha256: tmuxHash,
        },
      ]
      fs.writeFileSync(toolLock, JSON.stringify(selectedTools))
      const tools = await runForTest(['tools', 'update', toolLock, '--yes'], {
        home: source.home,
        remoteDir: source.remoteDir,
        deps: {
          architecture: 'arm64',
          curatedTools: selectedTools,
          fetch: (async (input: string | URL | Request) => {
            if (String(input) === 'https://tools.test/rg') return new Response(toolBytes)
            if (String(input) === 'https://tools.test/tmux') return new Response(tmuxBytes)
            throw new Error(`unexpected tool URL: ${String(input)}`)
          }) as typeof fetch,
        },
      })
      expect(tools.exitCode).toBe(0)

      writeHomeFile(host.home, '.codex/config.toml', 'model = "host"\n')
      const project = path.join(host.home, 'project')
      fs.mkdirSync(project)
      fs.writeFileSync(path.join(project, 'notes.txt'), 'host project edit\n')
      const privateHome = path.join(host.home, 'private-runtime', 'home')
      fs.mkdirSync(privateHome, { recursive: true })
      const parsed = parseCliArgs(['open', '--yes'])
      const ctx = createContext('open', null, [], parsed.flags, {
        home: host.home,
        cwd: project,
        platform: 'darwin',
        env: { HOME: host.home },
        probes: {},
        quiescence: { windowMs: 0 },
        remote: () => createFileRemote({ dir: source.remoteDir }),
        architecture: 'arm64',
        curatedTools: selectedTools,
        fetch: (async (input: string | URL | Request) => {
          if (String(input) === 'https://tools.test/rg') return new Response(toolBytes)
          if (String(input) === 'https://tools.test/tmux') return new Response(tmuxBytes)
          return Response.json({
            protocolVersion: 1,
            userId: '00000000000000000000000009',
            storeId: STORE_ID,
            devices: [],
            kdf: null,
            quotas: { blobs: 0, bytes: 0, maxBytes: 100_000 },
          })
        }) as typeof fetch,
      })

      const remoteSession = {
        id: WorkbenchSessionId.parse('00000000000000000000000007'),
        deviceId: DeviceId.parse('00000000000000000000000008'),
        name: 'temporary',
        platform: 'darwin',
        createdAt: '2026-09-20T00:00:00.000Z',
        expiresAt: '2026-09-21T00:00:00.000Z',
      } as const
      const launchEnvironment: NodeJS.ProcessEnv = {}
      const inputExecutables: WorkbenchMaterializeInput['executables'] = { shell: '/bin/zsh' }
      const revisionId = await materializeWorkbench(
        ctx,
        {
          server: 'https://laurencio.test',
          token: 'lrn_temporary-token',
          root: path.dirname(privateHome),
          home: privateHome,
          environment: launchEnvironment,
          executables: inputExecutables,
          remote: remoteSession,
        },
        PASSPHRASE,
      )

      expect(fs.readFileSync(path.join(privateHome, '.codex/config.toml'), 'utf8')).toContain(
        'portable',
      )
      expect(fs.readFileSync(path.join(privateHome, '.codex/auth.json'), 'utf8')).toContain(
        'portable-login',
      )
      expect(fs.readFileSync(path.join(host.home, '.codex/config.toml'), 'utf8')).toContain('host')
      expect(fs.readFileSync(path.join(project, 'notes.txt'), 'utf8')).toBe('host project edit\n')
      const installedTool = path.join(
        path.dirname(privateHome),
        'tools/ripgrep/14.1.1/darwin-arm64/rg',
      )
      expect(fs.readFileSync(installedTool, 'utf8')).toBe('portable-ripgrep')
      expect(launchEnvironment.PATH).toContain(path.dirname(installedTool))
      expect(inputExecutables.tmux).toContain('/tools/tmux/3.5.0/darwin-arm64/tmux')

      fs.writeFileSync(path.join(privateHome, '.codex/config.toml'), 'model = "saved"\n')
      fs.writeFileSync(path.join(privateHome, '.codex/auth.json'), '{"token":"saved-login"}\n')
      fs.writeFileSync(path.join(privateHome, '.claude/CLAUDE.md'), 'unsaved instructions\n')
      const saved = await saveWorkbenchChanges(ctx, {
        record: {
          remote: remoteSession,
          server: 'https://laurencio.test',
          revisionId,
          runtime: {
            id: remoteSession.id,
            root: path.dirname(privateHome),
            home: privateHome,
            cwd: project,
            platform: 'darwin',
            executable: '/bin/tmux',
            configPath: path.join(path.dirname(privateHome), 'tmux.conf'),
            socketPath: path.join(path.dirname(privateHome), 'tmux.sock'),
          },
        },
        token: 'lrn_temporary-token',
        passphrase: PASSPHRASE,
        harnesses: ['codex'],
        surface: null,
      })
      expect(saved.status).toBe('synced')

      const secondHome = path.join(host.home, 'second-runtime', 'home')
      fs.mkdirSync(secondHome, { recursive: true })
      await materializeWorkbench(
        ctx,
        {
          server: 'https://laurencio.test',
          token: 'lrn_second-temporary-token',
          root: path.dirname(secondHome),
          home: secondHome,
          environment: {},
          executables: { tmux: '/bin/tmux', shell: '/bin/zsh' },
          remote: {
            ...remoteSession,
            id: WorkbenchSessionId.parse('00000000000000000000000006'),
          },
        },
        PASSPHRASE,
      )
      expect(fs.readFileSync(path.join(secondHome, '.codex/config.toml'), 'utf8')).toContain(
        'saved',
      )
      expect(fs.readFileSync(path.join(secondHome, '.codex/auth.json'), 'utf8')).toContain(
        'saved-login',
      )
      expect(fs.readFileSync(path.join(secondHome, '.claude/CLAUDE.md'), 'utf8')).toBe(
        'portable instructions\n',
      )
    } finally {
      source.cleanup()
      host.cleanup()
    }
  })

  test('rejects every unknown save harness before contacting the server', async () => {
    const scratch = makeScratch()
    try {
      const parsed = parseCliArgs(['save', '--harness', 'codex', '--harness', 'unknown'])
      const ctx = createContext('save', null, [], parsed.flags, {
        home: scratch.home,
        cwd: scratch.home,
        platform: 'darwin',
        env: { HOME: scratch.home },
        fetch: (() => {
          throw new Error('server should not be contacted')
        }) as unknown as typeof fetch,
      })
      const id = WorkbenchSessionId.parse('00000000000000000000000007')
      const root = path.join(scratch.home, 'runtime')

      await expect(
        saveWorkbenchChanges(ctx, {
          record: {
            remote: {
              id,
              deviceId: DeviceId.parse('00000000000000000000000008'),
              name: 'temporary',
              platform: 'darwin',
              createdAt: '2026-09-20T00:00:00.000Z',
              expiresAt: '2026-09-21T00:00:00.000Z',
            },
            server: 'https://laurencio.test',
            revisionId: null,
            runtime: {
              id,
              root,
              home: path.join(root, 'home'),
              cwd: scratch.home,
              platform: 'darwin',
              executable: '/bin/tmux',
              configPath: path.join(root, 'tmux.conf'),
              socketPath: path.join(root, 'tmux.sock'),
            },
          },
          token: 'lrn_temporary-token',
          passphrase: PASSPHRASE,
          harnesses: ['codex', 'unknown'],
          surface: null,
        }),
      ).rejects.toMatchObject({ code: 'unknown-harness' })
    } finally {
      scratch.cleanup()
    }
  })
})
