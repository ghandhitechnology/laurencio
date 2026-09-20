import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import {
  createFileRemote,
  type crypto,
  type DevicePolicy,
  defaultPolicy,
  type VaultReference,
} from '@laurencio/core'
import { agentEnvironment } from '../src/commands/agent'
import { saveCliConfig } from '../src/config'
import { selectedCredentialReferences } from '../src/credential-sync'
import { createSystemCredentialIo, MCP_KEYCHAIN_SERVICE } from '../src/workbench/credentials'
import { makeScratch, runForTest, seedStore, writeHomeFile } from './helpers'

class MemoryCredentialStore implements crypto.CredentialStore {
  readonly backend = 'keychain' as const
  readonly values = new Map<string, Uint8Array>()

  async get(service: string, account: string): Promise<Uint8Array | null> {
    return this.values.get(`${service}\0${account}`)?.slice() ?? null
  }

  async set(service: string, account: string, secret: Uint8Array): Promise<void> {
    this.values.set(`${service}\0${account}`, secret.slice())
  }

  async delete(service: string, account: string): Promise<void> {
    this.values.delete(`${service}\0${account}`)
  }
}

describe('workbench credential IO', () => {
  test('agent launch cannot bootstrap one MCP account from another account or ambient env', async () => {
    const keychain = new MemoryCredentialStore()
    const io = createSystemCredentialIo({}, { durableMcp: { platform: 'darwin', keychain } })
    const references: VaultReference[] = ['one', 'two'].map((server) => ({
      kind: 'mcp-secret',
      name: server,
      harness: 'codex',
      vault: 'laurencio',
      item: server,
      field: 'value',
      server,
      env: 'TOKEN',
    }))
    await io.writeMcpSecret('codex', 'one', 'TOKEN', new TextEncoder().encode('first-value'))
    const before = keychain.values.size
    await expect(
      agentEnvironment({ TOKEN: 'ambient' }, references, { platform: 'darwin', keychain }),
    ).rejects.toThrow('missing from the OS credential store')
    expect(keychain.values.size).toBe(before)
    expect(await keychain.get(MCP_KEYCHAIN_SERVICE, 'codex:two:token')).toBeNull()
    await io.writeMcpSecret('codex', 'two', 'TOKEN', new TextEncoder().encode('second-value'))
    await expect(
      agentEnvironment({}, references, { platform: 'darwin', keychain }),
    ).rejects.toThrow('different values')
    expect(
      new TextDecoder().decode(
        (await keychain.get(MCP_KEYCHAIN_SERVICE, 'codex:two:token')) ?? undefined,
      ),
    ).toBe('second-value')
  })

  test('first-enrollment deferral does not restore credentials from the stale initial policy', async () => {
    const source = makeScratch()
    const target = makeScratch()
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir })
      writeHomeFile(source.home, '.claude/CLAUDE.md', 'remote instructions\n')
      writeHomeFile(source.home, '.claude/.credentials.json', '{"accessToken":"remote-login"}')
      expect(
        (
          await runForTest(['sync', '--yes'], {
            home: source.home,
            remoteDir: source.remoteDir,
            deps: { quiescence: { windowMs: 0 } },
          })
        ).exitCode,
      ).toBe(0)
      await seedStore({ home: target.home, remoteDir: source.remoteDir })
      writeHomeFile(target.home, '.claude/CLAUDE.md', 'local instructions\n')
      const policy = defaultPolicy()
      policy.harnesses.claude = { enabled: true, surfaces: { 'claude.instructions': 'on' } }
      saveCliConfig(target.home, { server: null, policy })
      const result = await runForTest(['init'], {
        home: target.home,
        remoteDir: source.remoteDir,
        answers: ['k', 's'],
        deps: { quiescence: { windowMs: 0 } },
      })
      expect(result.exitCode).toBe(0)
      expect(result.output).toContain('Enrollment: claude.instructions s')
      expect(fs.existsSync(path.join(target.home, '.claude/.credentials.json'))).toBe(false)
    } finally {
      source.cleanup()
      target.cleanup()
    }
  })
  test('a rejected profile publication preserves inline config and retries after vault capture', async () => {
    const scratch = makeScratch()
    const keychain = new MemoryCredentialStore()
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir, keychain })
      const original = JSON.stringify({
        mcpServers: { github: { command: 'github-mcp', env: { TOKEN: secret } } },
      })
      writeHomeFile(scratch.home, '.claude.json', original)
      const remote = createFileRemote({ dir: scratch.remoteDir })
      const publish = remote.putProfileHead.bind(remote)
      remote.putProfileHead = async () => {
        throw new Error('profile generation changed')
      }
      const failed = await runForTest(['sync', '--yes', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        keychain,
        deps: { remote: () => remote },
      })
      expect(failed.exitCode).toBe(1)
      expect(fs.readFileSync(path.join(scratch.home, '.claude.json'), 'utf8')).toBe(original)
      expect(await remote.getVaultHead()).not.toBeNull()
      expect(await remote.getProfileHead()).toBeNull()
      remote.putProfileHead = publish
      const retried = await runForTest(['sync', '--yes', '--json'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        keychain,
        deps: { remote: () => remote, quiescence: { windowMs: 0 } },
      })
      expect(retried.exitCode).toBe(0)
      expect(fs.readFileSync(path.join(scratch.home, '.claude.json'), 'utf8')).not.toContain(secret)
      expect((await remote.getVaultHead())?.generation).toBe(1)
    } finally {
      scratch.cleanup()
    }
  })
  test('imports real MCP configs and restores credentials only to a second device agent', async () => {
    const source = makeScratch()
    const target = makeScratch()
    const sourceKeys = new MemoryCredentialStore()
    const targetKeys = new MemoryCredentialStore()
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'
    try {
      await seedStore({ home: source.home, remoteDir: source.remoteDir, keychain: sourceKeys })
      await seedStore({ home: target.home, remoteDir: source.remoteDir, keychain: targetKeys })
      writeHomeFile(
        source.home,
        '.claude.json',
        JSON.stringify({
          mcpServers: { github: { command: 'github-mcp', env: { TOKEN: secret } } },
        }),
      )
      writeHomeFile(
        source.home,
        '.codex/config.toml',
        `[mcp_servers.github]\ncommand = "github-mcp"\n[mcp_servers.github.env]\nGITHUB_TOKEN = "${secret}"\n`,
      )
      writeHomeFile(
        source.home,
        '.config/opencode/opencode.jsonc',
        `// keep my configuration notes\n${JSON.stringify({ mcp: { github: { type: 'local', command: ['github-mcp'], environment: { TOKEN: secret } }, servers: { github: { type: 'local', command: ['github-mcp'], environment: { TOKEN: secret } } } } }, null, 2)}\n`,
      )
      const refused = await runForTest(['sync', '--json'], {
        home: source.home,
        remoteDir: source.remoteDir,
        keychain: sourceKeys,
      })
      expect(refused.exitCode).toBe(1)
      expect(refused.errorOutput).not.toContain(secret)
      expect(fs.readFileSync(path.join(source.home, '.claude.json'), 'utf8')).toContain(secret)
      const first = await runForTest(['sync', '--yes', '--json'], {
        home: source.home,
        remoteDir: source.remoteDir,
        keychain: sourceKeys,
        deps: { quiescence: { windowMs: 0 } },
      })
      expect(first.exitCode).toBe(0)
      expect(first.combined).not.toContain(secret)
      expect(fs.readFileSync(path.join(source.home, '.claude.json'), 'utf8')).not.toContain(secret)
      expect(fs.readFileSync(path.join(source.home, '.codex/config.toml'), 'utf8')).toContain(
        'env_vars',
      )
      expect(
        fs.readFileSync(path.join(source.home, '.config/opencode/opencode.jsonc'), 'utf8'),
      ).toContain('// keep my configuration notes')
      expect(
        fs.readFileSync(path.join(source.home, '.config/opencode/opencode.jsonc'), 'utf8'),
      ).not.toContain(secret)
      const second = await runForTest(['sync', '--yes', '--json'], {
        home: target.home,
        remoteDir: source.remoteDir,
        keychain: targetKeys,
        deps: { quiescence: { windowMs: 0 } },
      })
      expect(second.exitCode).toBe(0)
      expect(second.combined).not.toContain(secret)
      const rotated = `${secret}ROTATED`
      const sourceIo = createSystemCredentialIo(
        {},
        { durableMcp: { platform: 'darwin', keychain: sourceKeys } },
      )
      for (const harness of ['claude', 'codex', 'opencode'] as const)
        await sourceIo.writeMcpSecret(
          harness,
          'github',
          'GITHUB_TOKEN',
          new TextEncoder().encode(rotated),
        )
      expect(
        (
          await runForTest(['sync', '--json'], {
            home: source.home,
            remoteDir: source.remoteDir,
            keychain: sourceKeys,
            deps: { quiescence: { windowMs: 0 } },
          })
        ).exitCode,
      ).toBe(0)
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          (
            await runForTest(['sync', '--json'], {
              home: target.home,
              remoteDir: source.remoteDir,
              keychain: targetKeys,
              env: { GITHUB_TOKEN: secret },
              deps: { quiescence: { windowMs: 0 } },
            })
          ).exitCode,
        ).toBe(0)
      for (const harness of ['claude', 'codex', 'opencode']) {
        let injected: string | undefined
        const result = await runForTest(['agent', harness], {
          home: target.home,
          remoteDir: source.remoteDir,
          keychain: targetKeys,
          env: { GITHUB_TOKEN: 'old-parent-value' },
          deps: {
            which: () => `/tools/${harness}`,
            launchAgent: async (input) => {
              injected = input.environment.GITHUB_TOKEN
              return 0
            },
          },
        })
        expect(result.exitCode).toBe(0)
        expect(injected).toBe(rotated)
      }
    } finally {
      source.cleanup()
      target.cleanup()
    }
  })

  test('durable values beat stale ambient values on repeated reads', async () => {
    const keychain = new MemoryCredentialStore()
    const durable = { platform: 'darwin' as const, keychain }
    const io = createSystemCredentialIo({}, { durableMcp: durable })
    await io.writeMcpSecret('codex', 'github', 'GITHUB_TOKEN', new TextEncoder().encode('new'))
    for (let attempt = 0; attempt < 2; attempt++) {
      const stale = createSystemCredentialIo({ GITHUB_TOKEN: 'old' }, { durableMcp: durable })
      expect(
        new TextDecoder().decode(
          (await stale.readMcpSecret('codex', 'github', 'GITHUB_TOKEN')) ?? undefined,
        ),
      ).toBe('new')
    }
  })
  test('launches only supported agents and forwards arguments after the separator', async () => {
    const scratch = makeScratch()
    try {
      await seedStore({ home: scratch.home, remoteDir: scratch.remoteDir })
      const calls: string[][] = []
      const result = await runForTest(['agent', 'codex', '--', '--model', 'chosen'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
        deps: {
          which: () => '/tools/codex',
          launchAgent: async (input) => {
            calls.push([input.executable, ...input.args])
            return 0
          },
        },
      })
      expect(result.exitCode).toBe(0)
      expect(calls).toEqual([['/tools/codex', '--model', 'chosen']])
      const rejected = await runForTest(['agent', 'arbitrary-command'], {
        home: scratch.home,
        remoteDir: scratch.remoteDir,
      })
      expect(rejected.exitCode).toBe(1)
      expect(rejected.errorOutput).toContain('choose claude, codex, or opencode')
    } finally {
      scratch.cleanup()
    }
  })
  test('Windows MCP credentials stay in the OS store and enter only the launched child environment', async () => {
    const keychain = new MemoryCredentialStore()
    const source: Record<string, string | undefined> = {}
    const io = createSystemCredentialIo(source, { durableMcp: { platform: 'win32', keychain } })
    await io.writeMcpSecret(
      'codex',
      'github',
      'GITHUB_TOKEN',
      new TextEncoder().encode('stored-secret'),
    )
    const inherited = { PATH: '/tools', GITHUB_TOKEN: 'stale-parent-secret' }
    const child = await agentEnvironment(
      inherited,
      [
        {
          kind: 'mcp-secret',
          name: 'github',
          harness: 'codex',
          vault: 'laurencio',
          item: 'github',
          field: 'token',
          server: 'github',
          env: 'GITHUB_TOKEN',
        },
      ],
      { platform: 'win32', keychain },
    )
    expect(child.GITHUB_TOKEN).toBe('stored-secret')
    expect(child.PATH).toBe('/tools')
    expect(inherited.GITHUB_TOKEN).toBe('stale-parent-secret')
    expect(keychain.values.size).toBe(1)
    expect(keychain.values.get(`${MCP_KEYCHAIN_SERVICE}\0codex:github:github_token`)).toEqual(
      new TextEncoder().encode('stored-secret'),
    )
  })
  test('atomically reads and writes private credential files', async () => {
    const scratch = makeScratch()
    try {
      const environment: Record<string, string | undefined> = {}
      const io = createSystemCredentialIo(environment)
      const target = path.join(scratch.home, '.codex', 'auth.json')

      expect(await io.readFile(target)).toBeNull()
      await io.writeFileAtomic(target, new TextEncoder().encode('{"token":"secret"}'), 0o600)

      const stored = await io.readFile(target)
      expect(stored).not.toBeNull()
      if (stored === null) throw new Error('credential file was not written')
      expect(new TextDecoder().decode(stored)).toBe('{"token":"secret"}')
      expect(fs.statSync(target).mode & 0o777).toBe(0o600)
      expect(fs.readdirSync(path.dirname(target))).toEqual(['auth.json'])
    } finally {
      scratch.cleanup()
    }
  })

  test('routes only requested MCP values through the supplied environment', async () => {
    const environment: Record<string, string | undefined> = { GITHUB_TOKEN: 'source-secret' }
    const io = createSystemCredentialIo(environment)

    const source = await io.readMcpSecret('opencode', 'github', 'GITHUB_TOKEN')
    expect(source).not.toBeNull()
    if (source === null) throw new Error('MCP credential was not read')
    expect(new TextDecoder().decode(source)).toBe('source-secret')
    await io.writeMcpSecret(
      'opencode',
      'github',
      'GITHUB_TOKEN',
      new TextEncoder().encode('rotated-secret'),
    )

    expect(environment.GITHUB_TOKEN).toBe('rotated-secret')
    expect(environment.UNREFERENCED_TOKEN).toBeUndefined()
  })

  test('persists full-mode MCP values without publishing to the user session', async () => {
    const keychain = new MemoryCredentialStore()
    const sourceEnvironment: Record<string, string | undefined> = {
      GITHUB_TOKEN: 'source-secret',
    }
    const source = createSystemCredentialIo(sourceEnvironment, {
      durableMcp: {
        platform: 'darwin',
        keychain,
      },
    })

    const captured = await source.readMcpSecret('opencode', 'github', 'GITHUB_TOKEN')
    captured?.fill(0)
    expect(keychain.values.get(`${MCP_KEYCHAIN_SERVICE}\0opencode:github:github_token`)).toEqual(
      new TextEncoder().encode('source-secret'),
    )

    const targetEnvironment: Record<string, string | undefined> = {}
    const target = createSystemCredentialIo(targetEnvironment, {
      durableMcp: {
        platform: 'darwin',
        keychain,
      },
    })
    const restored = await target.readMcpSecret('opencode', 'github', 'GITHUB_TOKEN')

    expect(new TextDecoder().decode(restored ?? undefined)).toBe('source-secret')
    expect(targetEnvironment.GITHUB_TOKEN).toBe('source-secret')
    restored?.fill(0)
  })

  test('selects credential references through both device policy and command scope', () => {
    const references: VaultReference[] = [
      {
        kind: 'agent-auth',
        name: 'claude-login',
        harness: 'claude',
        vault: 'laurencio',
        item: 'claude-login',
        field: 'value',
        path: `\${CLAUDE_CONFIG_DIR}/.credentials.json`,
      },
      {
        kind: 'agent-auth',
        name: 'codex-login',
        harness: 'codex',
        vault: 'laurencio',
        item: 'codex-login',
        field: 'value',
        path: `\${CODEX_HOME}/auth.json`,
      },
      {
        kind: 'mcp-secret',
        name: 'opencode-github',
        harness: 'opencode',
        vault: 'laurencio',
        item: 'github',
        field: 'token',
        server: 'github',
        env: 'GITHUB_TOKEN',
      },
    ]
    const policy: DevicePolicy = {
      version: 1,
      harnesses: {
        claude: { enabled: false, surfaces: {} },
        codex: { enabled: true, surfaces: { 'codex.skills': 'on' } },
        opencode: { enabled: true, surfaces: { 'opencode.skills': 'off' } },
      },
      ignore: [],
      prune: false,
      cadence: { watch: true, intervalSeconds: 300 },
    }

    expect(selectedCredentialReferences(references, policy).map((entry) => entry.harness)).toEqual([
      'codex',
    ])
    expect(
      selectedCredentialReferences(references, policy, ['claude', 'opencode']).map(
        (entry) => entry.harness,
      ),
    ).toEqual([])
  })
})
