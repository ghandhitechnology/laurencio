import { describe, expect, test } from 'bun:test'
import { StoreId } from '@laurencio/protocol'
import { KeyMaterial } from '../src/crypto/kdf'
import { Vault, VaultConflictError } from '../src/vault'

const context = {
  storeId: StoreId.parse('0123456789ABCDEFGHJKMNPQRS'),
  protocolVersion: 2,
}

function testKey(fill = 7): KeyMaterial {
  return new KeyMaterial(new Uint8Array(32).fill(fill))
}

function decodeSecret(value: Uint8Array | null): string {
  if (value === null) throw new Error('expected a vault value')
  return new TextDecoder().decode(value)
}

describe('encrypted credential vault', () => {
  test('round-trips agent and explicitly referenced MCP secrets', () => {
    const key = testKey()
    const vault = Vault.empty()

    expect(
      vault.put({
        id: 'agent:codex',
        kind: 'agent-auth',
        provider: 'codex',
        value: 'oauth-refresh-token',
        expectedVersion: null,
        updatedAt: '2026-09-20T00:00:00.000Z',
      }),
    ).toMatchObject({ id: 'agent:codex', version: 1 })
    vault.put({
      id: 'mcp:github:token',
      kind: 'mcp-secret',
      provider: 'github',
      value: 'github-token',
      expectedVersion: null,
      updatedAt: '2026-09-20T00:00:01.000Z',
    })

    const sealed = vault.seal(key, context)
    expect(sealed.namespace).toBe('vault')
    expect(sealed.blobType).toBe('vault')

    const reopened = Vault.open(key, sealed.bytes, context)
    const codex = reopened.read('agent:codex')
    const github = reopened.read('mcp:github:token')
    expect(codex).toBeDefined()
    expect(github).toBeDefined()
    expect(decodeSecret(codex)).toBe('oauth-refresh-token')
    expect(decodeSecret(github)).toBe('github-token')
    expect(reopened.list()).toEqual([
      {
        id: 'agent:codex',
        kind: 'agent-auth',
        provider: 'codex',
        version: 1,
        updatedAt: '2026-09-20T00:00:00.000Z',
      },
      {
        id: 'mcp:github:token',
        kind: 'mcp-secret',
        provider: 'github',
        version: 1,
        updatedAt: '2026-09-20T00:00:01.000Z',
      },
    ])
    key.zeroize()
  })

  test('uses a vault-only subkey and authenticated blob context', () => {
    const key = testKey()
    const vault = Vault.empty()
    vault.put({
      id: 'agent:claude',
      kind: 'agent-auth',
      provider: 'claude',
      value: 'secret',
      expectedVersion: null,
      updatedAt: '2026-09-20T00:00:00.000Z',
    })
    const sealed = vault.seal(key, context)

    expect(() =>
      Vault.open(key, sealed.bytes, {
        ...context,
        storeId: StoreId.parse('0123456789ABCDEFGHJKMNPQRT'),
      }),
    ).toThrow('authentication failed')
    key.zeroize()
  })

  test('requires compare-and-swap for rotations', () => {
    const vault = Vault.empty()
    vault.put({
      id: 'agent:opencode',
      kind: 'agent-auth',
      provider: 'opencode',
      value: 'first',
      expectedVersion: null,
      updatedAt: '2026-09-20T00:00:00.000Z',
    })

    expect(() =>
      vault.put({
        id: 'agent:opencode',
        kind: 'agent-auth',
        provider: 'opencode',
        value: 'stale-write',
        expectedVersion: null,
        updatedAt: '2026-09-20T00:00:01.000Z',
      }),
    ).toThrow(VaultConflictError)

    expect(
      vault.put({
        id: 'agent:opencode',
        kind: 'agent-auth',
        provider: 'opencode',
        value: 'rotated',
        expectedVersion: 1,
        updatedAt: '2026-09-20T00:00:02.000Z',
      }),
    ).toMatchObject({ version: 2 })
    const rotated = vault.read('agent:opencode')
    expect(rotated).toBeDefined()
    expect(decodeSecret(rotated)).toBe('rotated')
  })

  test('never serializes or inspects plaintext and zeroizes live values', () => {
    const vault = Vault.empty()
    vault.put({
      id: 'agent:codex',
      kind: 'agent-auth',
      provider: 'codex',
      value: 'never-log-this-value',
      expectedVersion: null,
      updatedAt: '2026-09-20T00:00:00.000Z',
    })

    expect(String(vault)).toBe('[Vault redacted]')
    expect(() => JSON.stringify(vault)).toThrow('not serializable')
    expect(Bun.inspect(vault)).not.toContain('never-log-this-value')

    vault.zeroize()
    expect(() => vault.read('agent:codex')).toThrow('zeroized')
    expect(() => vault.list()).toThrow('zeroized')
  })
})
