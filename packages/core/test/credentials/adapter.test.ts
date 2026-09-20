import { describe, expect, test } from 'bun:test'
import {
  CredentialAdapter,
  type CredentialIo,
  type VaultReference,
  vaultRecordId,
} from '../../src/index'
import { Vault } from '../../src/vault'

class FakeCredentialIo implements CredentialIo {
  readonly files = new Map<string, Uint8Array>()
  readonly fileWrites: { path: string; mode: number }[] = []
  readonly environment = new Map<string, Uint8Array>()

  async readFile(path: string): Promise<Uint8Array | null> {
    return this.files.get(path)?.slice() ?? null
  }

  async writeFileAtomic(path: string, value: Uint8Array, mode: number): Promise<void> {
    this.files.set(path, value.slice())
    this.fileWrites.push({ path, mode })
  }

  async readMcpSecret(_harness: string, server: string, env: string): Promise<Uint8Array | null> {
    return this.environment.get(`${server}\0${env}`)?.slice() ?? null
  }

  async writeMcpSecret(
    _harness: string,
    server: string,
    env: string,
    value: Uint8Array,
  ): Promise<void> {
    this.environment.set(`${server}\0${env}`, value.slice())
  }
}

const tokenEnv = {
  home: '/Users/andy',
  platform: 'darwin' as const,
  env: {
    CLAUDE_CONFIG_DIR: '/private/session/claude',
    CODEX_HOME: '/private/session/codex',
    XDG_CONFIG_HOME: '/private/session/config',
  },
}

const claudeReference: VaultReference = {
  kind: 'agent-auth',
  name: 'claude-login',
  harness: 'claude',
  vault: 'developer',
  item: 'claude',
  field: 'credentials',
  path: `\${CLAUDE_CONFIG_DIR}/.credentials.json`,
}

describe('credential adapter', () => {
  test('captures and materializes an opaque Claude credential file privately', async () => {
    const io = new FakeCredentialIo()
    const vault = Vault.empty()
    const source = new Uint8Array([0, 255, 13, 10, 123, 125])
    io.files.set('/private/session/claude/.credentials.json', source)
    const adapter = new CredentialAdapter(io, tokenEnv, () => '2026-09-20T00:00:00.000Z')

    const captured = await adapter.capture(vault, [claudeReference])

    expect(captured).toEqual([
      {
        name: 'claude-login',
        kind: 'agent-auth',
        harness: 'claude',
        recordId: 'agent-auth:claude:claude-login',
        status: 'captured',
        version: 1,
      },
    ])
    expect(vault.read(vaultRecordId(claudeReference))).toEqual(source)

    const unchanged = await adapter.capture(vault, [claudeReference])
    expect(unchanged[0]).toMatchObject({ status: 'unchanged', version: 1 })

    io.files.delete('/private/session/claude/.credentials.json')
    const materialized = await adapter.materialize(vault, [claudeReference])

    expect(materialized[0]).toMatchObject({ status: 'materialized', version: 1 })
    expect(io.files.get('/private/session/claude/.credentials.json')).toEqual(source)
    expect(io.fileWrites).toEqual([
      { path: '/private/session/claude/.credentials.json', mode: 0o600 },
    ])
  })

  test('refuses a first-seen divergence, then reconciles one-sided rotations', async () => {
    const io = new FakeCredentialIo()
    const vault = Vault.empty()
    const path = '/private/session/claude/.credentials.json'
    vault.put({
      id: vaultRecordId(claudeReference),
      kind: 'agent-auth',
      provider: 'claude',
      value: 'account-v1',
      expectedVersion: null,
      updatedAt: '2026-09-20T00:00:00.000Z',
    })
    io.files.set(path, new TextEncoder().encode('stale-device-value'))
    const adapter = new CredentialAdapter(io, tokenEnv, () => '2026-09-20T00:00:01.000Z')

    const first = await adapter.reconcile(vault, [claudeReference], {})
    expect(first.results[0]).toMatchObject({ status: 'conflict', version: 1 })
    expect(new TextDecoder().decode(io.files.get(path))).toBe('stale-device-value')

    io.files.delete(path)
    const adopted = await adapter.reconcile(vault, [claudeReference], first.baselines)
    expect(adopted.results[0]).toMatchObject({ status: 'materialized', version: 1 })
    expect(new TextDecoder().decode(io.files.get(path))).toBe('account-v1')

    io.files.set(path, new TextEncoder().encode('device-v2'))
    const uploaded = await adapter.reconcile(vault, [claudeReference], adopted.baselines)
    expect(uploaded.results[0]).toMatchObject({ status: 'captured', version: 2 })

    const baseline = await adapter.reconcile(vault, [claudeReference], uploaded.baselines)
    vault.put({
      id: vaultRecordId(claudeReference),
      kind: 'agent-auth',
      provider: 'claude',
      value: 'account-v3',
      expectedVersion: 2,
      updatedAt: '2026-09-20T00:00:02.000Z',
    })
    io.files.set(path, new TextEncoder().encode('device-v3'))

    const conflicted = await adapter.reconcile(vault, [claudeReference], baseline.baselines)
    expect(conflicted.results[0]).toMatchObject({ status: 'conflict', version: 3 })
    expect(new TextDecoder().decode(io.files.get(path))).toBe('device-v3')
    expect(new TextDecoder().decode(vault.read(vaultRecordId(claudeReference)) ?? undefined)).toBe(
      'account-v3',
    )
  })

  test('selectively transfers Codex and OpenCode auth files', async () => {
    const io = new FakeCredentialIo()
    const vault = Vault.empty()
    const references: VaultReference[] = [
      claudeReference,
      {
        kind: 'agent-auth',
        name: 'codex-login',
        harness: 'codex',
        vault: 'developer',
        item: 'codex',
        field: 'auth',
        path: `\${CODEX_HOME}/auth.json`,
      },
      {
        kind: 'agent-auth',
        name: 'opencode-login',
        harness: 'opencode',
        vault: 'developer',
        item: 'opencode',
        field: 'auth',
        path: '$HOME/.local/share/opencode/auth.json',
      },
    ]
    io.files.set('/private/session/claude/.credentials.json', new TextEncoder().encode('claude'))
    io.files.set('/private/session/codex/auth.json', new TextEncoder().encode('codex'))
    io.files.set(
      '/Users/andy/.local/share/opencode/auth.json',
      new TextEncoder().encode('opencode'),
    )
    const adapter = new CredentialAdapter(io, tokenEnv, () => '2026-09-20T00:00:00.000Z')

    const captured = await adapter.capture(vault, references, ['codex-login', 'opencode-login'])

    expect(captured.map((entry) => entry.name)).toEqual(['codex-login', 'opencode-login'])
    expect(vault.read('agent-auth:claude:claude-login')).toBeNull()
    expect(vault.read('agent-auth:codex:codex-login')).toEqual(new TextEncoder().encode('codex'))
    expect(vault.read('agent-auth:opencode:opencode-login')).toEqual(
      new TextEncoder().encode('opencode'),
    )

    io.files.clear()
    const materialized = await adapter.materialize(vault, references, ['opencode-login'])

    expect(materialized.map((entry) => entry.name)).toEqual(['opencode-login'])
    expect(io.files.has('/private/session/codex/auth.json')).toBe(false)
    expect(io.files.get('/Users/andy/.local/share/opencode/auth.json')).toEqual(
      new TextEncoder().encode('opencode'),
    )
  })

  test('captures and materializes only explicitly referenced MCP environment secrets', async () => {
    const io = new FakeCredentialIo()
    const vault = Vault.empty()
    const reference: VaultReference = {
      kind: 'mcp-secret',
      name: 'github-token',
      harness: 'opencode',
      vault: 'developer',
      item: 'github',
      field: 'token',
      server: 'github',
      env: 'GITHUB_TOKEN',
    }
    io.environment.set('github\0GITHUB_TOKEN', new TextEncoder().encode('gh-secret-value'))
    io.environment.set('other\0UNREFERENCED_TOKEN', new TextEncoder().encode('leave-alone'))
    const adapter = new CredentialAdapter(io, tokenEnv, () => '2026-09-20T00:00:00.000Z')

    const captured = await adapter.capture(vault, [reference])

    expect(vaultRecordId(reference)).toBe('mcp-secret:opencode:github:github_token')
    expect(captured).toEqual([
      {
        name: 'github-token',
        kind: 'mcp-secret',
        harness: 'opencode',
        recordId: 'mcp-secret:opencode:github:github_token',
        status: 'captured',
        version: 1,
      },
    ])
    expect(Bun.inspect(captured)).not.toContain('gh-secret-value')
    expect(Bun.inspect(adapter)).toBe('[CredentialAdapter]')

    io.environment.delete('github\0GITHUB_TOKEN')
    const materialized = await adapter.materialize(vault, [reference])

    expect(materialized[0]).toMatchObject({ status: 'materialized', version: 1 })
    expect(io.environment.get('github\0GITHUB_TOKEN')).toEqual(
      new TextEncoder().encode('gh-secret-value'),
    )
    expect(io.environment.get('other\0UNREFERENCED_TOKEN')).toEqual(
      new TextEncoder().encode('leave-alone'),
    )
  })

  test('rejects case-folded record collisions before credential I/O', async () => {
    let reads = 0
    const io: CredentialIo = {
      async readFile() {
        reads += 1
        return new Uint8Array([1])
      },
      async writeFileAtomic() {},
      async readMcpSecret() {
        reads += 1
        return new Uint8Array([1])
      },
      async writeMcpSecret() {},
    }
    const references: VaultReference[] = [
      {
        kind: 'mcp-secret',
        name: 'upper',
        harness: 'claude',
        vault: 'developer',
        item: 'github',
        field: 'token',
        server: 'GitHub',
        env: 'GITHUB_TOKEN',
      },
      {
        kind: 'mcp-secret',
        name: 'lower',
        harness: 'claude',
        vault: 'developer',
        item: 'github',
        field: 'token',
        server: 'github',
        env: 'github_token',
      },
    ]
    const adapter = new CredentialAdapter(io, tokenEnv)

    await expect(adapter.capture(Vault.empty(), references, ['upper'])).rejects.toThrow(
      'resolve to the same vault record',
    )
    expect(reads).toBe(0)
  })

  test('redacts secret-bearing I/O failures', async () => {
    const io: CredentialIo = {
      async readFile() {
        throw new Error('failed around oauth-secret-canary')
      },
      async writeFileAtomic() {},
      async readMcpSecret() {
        throw new Error('failed around oauth-secret-canary')
      },
      async writeMcpSecret() {},
    }
    const adapter = new CredentialAdapter(io, tokenEnv)

    const failure = adapter.capture(Vault.empty(), [claudeReference]).catch((error) => error)

    expect(String(await failure)).toBe('CredentialAdapterError: could not read credential file')
    expect(Bun.inspect(await failure)).not.toContain('oauth-secret-canary')

    const mcpReference: VaultReference = {
      kind: 'mcp-secret',
      name: 'github-token',
      harness: 'opencode',
      vault: 'developer',
      item: 'github',
      field: 'token',
      server: 'github',
      env: 'GITHUB_TOKEN',
    }
    const mcpFailure = adapter.capture(Vault.empty(), [mcpReference]).catch((error) => error)

    expect(String(await mcpFailure)).toBe('CredentialAdapterError: could not read MCP credential')
    expect(Bun.inspect(await mcpFailure)).not.toContain('oauth-secret-canary')
  })
})
