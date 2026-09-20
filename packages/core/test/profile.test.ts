import { describe, expect, test } from 'bun:test'
import { DeviceId, RevisionId, SurfaceId } from '@laurencio/protocol'
import {
  DEFAULT_PROFILE_ID,
  type Manifest,
  migrateManifestToProfile,
  type PortableProfile,
  parsePortableProfile,
  projectProfile,
} from '../src/index'

const manifest = (): Manifest => ({
  revisionId: RevisionId.parse('00000000000000000000000001'),
  deviceId: DeviceId.parse('00000000000000000000000002'),
  createdAt: '2026-09-20T00:00:00.000Z',
  entries: [
    {
      surfaceId: SurfaceId.parse('codex.config'),
      path: 'config.toml',
      kind: 'file',
      policy: 'sync',
      hash: 'a'.repeat(64),
      size: 12,
      mode: 0o644,
    },
  ],
})

describe('portable profile', () => {
  test('migrates a v1 manifest into the reserved default v2 profile without changing it', () => {
    const source = manifest()

    const profile = migrateManifestToProfile(source)

    expect(profile.schemaVersion).toBe(2)
    expect(profile.id).toBe(DEFAULT_PROFILE_ID)
    expect(profile.manifest).toBe(source)
    expect(profile.manifest.entries).toEqual(source.entries)
    expect(profile.shared).toEqual({ keybindings: {}, layout: {} })
    expect(profile.platforms).toEqual({})
    expect(profile.tools).toEqual([])
    expect(profile.vault).toEqual([
      expect.objectContaining({
        kind: 'agent-auth',
        name: 'claude-login',
        harness: 'claude',
        path: `\${CLAUDE_CONFIG_DIR}/.credentials.json`,
      }),
      expect.objectContaining({
        kind: 'agent-auth',
        name: 'codex-login',
        harness: 'codex',
        path: `\${CODEX_HOME}/auth.json`,
      }),
      expect.objectContaining({
        kind: 'agent-auth',
        name: 'opencode-login',
        harness: 'opencode',
        path: '$HOME/.local/share/opencode/auth.json',
      }),
    ])
  })

  test('projects shared semantic settings with deterministic platform overrides', () => {
    const profile: PortableProfile = {
      ...migrateManifestToProfile(manifest()),
      shared: {
        keybindings: { palette: 'mod+k', accept: 'enter' },
        layout: { columns: '120', rows: '40' },
      },
      platforms: {
        darwin: {
          keybindings: { palette: 'ctrl+shift+k' },
          layout: { columns: '140' },
        },
        win32: {
          keybindings: { palette: 'ctrl+k' },
        },
      },
    }

    const projected = projectProfile(profile, 'darwin')

    expect(projected.profileId).toBe(DEFAULT_PROFILE_ID)
    expect(projected.platform).toBe('darwin')
    expect(projected.manifest).toBe(profile.manifest)
    expect(projected.keybindings).toEqual({ accept: 'enter', palette: 'ctrl+shift+k' })
    expect(Object.keys(projected.keybindings)).toEqual(['accept', 'palette'])
    expect(projected.layout).toEqual({ columns: '140', rows: '40' })
    expect(Object.keys(projected.layout)).toEqual(['columns', 'rows'])
  })

  test('rejects semantic settings that the terminal renderer cannot apply', () => {
    const withShared = (shared: PortableProfile['shared']): PortableProfile => ({
      ...migrateManifestToProfile(manifest()),
      shared,
    })

    expect(() =>
      projectProfile(withShared({ keybindings: { launch: 'ctrl+l' }, layout: {} }), 'darwin'),
    ).toThrow('unsupported terminal action')
    expect(() =>
      projectProfile(withShared({ keybindings: { palette: 'cmd+k' }, layout: {} }), 'darwin'),
    ).toThrow('unsupported terminal modifier')
    expect(() =>
      projectProfile(withShared({ keybindings: {}, layout: { sidebar: 'left' } }), 'darwin'),
    ).toThrow('unsupported terminal layout setting')
    expect(() =>
      projectProfile(withShared({ keybindings: {}, layout: { columns: '0' } }), 'darwin'),
    ).toThrow('unsupported terminal layout value')
    expect(() =>
      parsePortableProfile(withShared({ keybindings: { palette: 'cmd+k' }, layout: {} })),
    ).toThrow('unsupported terminal modifier')
  })

  test('rejects platforms outside the v2 projection contract', () => {
    const profile = migrateManifestToProfile(manifest())

    expect(() => projectProfile(profile, 'linux' as 'darwin')).toThrow(
      'unsupported profile platform: linux',
    )
  })

  test('projects pinned tool locks for the selected platform in stable order', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      tools: [
        {
          name: 'ripgrep',
          platform: 'win32',
          arch: 'x64',
          version: '14.1.1',
          url: 'https://tools.example/ripgrep-win32-x64.zip',
          sha256: '1'.repeat(64),
        },
        {
          name: 'zoxide',
          platform: 'darwin',
          arch: 'arm64',
          version: '0.9.8',
          url: 'https://tools.example/zoxide-darwin-arm64.tar.gz',
          sha256: '2'.repeat(64),
        },
        {
          name: 'ripgrep',
          platform: 'darwin',
          arch: 'arm64',
          version: '14.1.1',
          url: 'https://tools.example/ripgrep-darwin-arm64.tar.gz',
          sha256: '3'.repeat(64),
        },
      ],
    } as unknown as PortableProfile

    const projected = projectProfile(profile, 'darwin')

    expect(projected.tools.map((tool) => tool.name)).toEqual(['ripgrep', 'zoxide'])
    expect(projected.tools.every((tool) => tool.platform === 'darwin')).toBe(true)
  })

  test('rejects tool locks that are not pinned to a sha256 digest', () => {
    const profile: PortableProfile = {
      ...migrateManifestToProfile(manifest()),
      tools: [
        {
          name: 'ripgrep',
          platform: 'darwin',
          arch: 'arm64',
          version: '14.1.1',
          url: 'https://tools.example/ripgrep.tar.gz',
          sha256: 'latest',
        },
      ],
    }

    expect(() => projectProfile(profile, 'darwin')).toThrow(
      'tool ripgrep has an invalid sha256 pin',
    )
  })

  test('requires each tool lock to pin a supported target and artifact', () => {
    const lockedTool = {
      name: 'ripgrep',
      platform: 'darwin' as const,
      arch: 'arm64',
      version: '14.1.1',
      url: 'https://tools.example/ripgrep.tar.gz',
      sha256: '4'.repeat(64),
    }
    const withTool = (tool: typeof lockedTool): PortableProfile => ({
      ...migrateManifestToProfile(manifest()),
      tools: [tool],
    })

    expect(() => projectProfile(withTool({ ...lockedTool, arch: '' }), 'darwin')).toThrow(
      'tool ripgrep has an invalid arch',
    )
    expect(() => projectProfile(withTool({ ...lockedTool, version: '' }), 'darwin')).toThrow(
      'tool ripgrep has an unpinned version',
    )
    expect(() =>
      projectProfile(withTool({ ...lockedTool, url: 'ripgrep.tar.gz' }), 'darwin'),
    ).toThrow('tool ripgrep has an invalid url')
    expect(() =>
      projectProfile(withTool({ ...lockedTool, platform: 'linux' as 'darwin' }), 'darwin'),
    ).toThrow('tool ripgrep has an unsupported platform: linux')
  })

  test('projects sorted vault references without resolving secret values', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      vault: [
        {
          kind: 'mcp-secret',
          name: 'npm-token',
          harness: 'opencode',
          server: 'npm',
          env: 'NPM_TOKEN',
          vault: 'developer',
          item: 'npm',
          field: 'token',
        },
        {
          kind: 'agent-auth',
          name: 'github-token',
          harness: 'codex',
          path: `\${CODEX_HOME}/auth.json`,
          vault: 'developer',
          item: 'github',
          field: 'token',
        },
      ],
    } as unknown as PortableProfile

    const projected = projectProfile(profile, 'win32')

    expect(projected.vault.map((reference) => reference.name)).toEqual([
      'github-token',
      'npm-token',
    ])
    expect(projected.vault.map((reference) => reference.kind)).toEqual(['agent-auth', 'mcp-secret'])
  })

  test('rejects secret payloads attached to vault references', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      vault: [
        {
          kind: 'mcp-secret',
          name: 'github-token',
          harness: 'claude',
          server: 'github',
          env: 'GITHUB_TOKEN',
          vault: 'developer',
          item: 'github',
          field: 'token',
          value: 'ghp_secret',
        },
      ],
    } as unknown as PortableProfile

    expect(() => projectProfile(profile, 'darwin')).toThrow(
      'vault reference github-token contains secret payload field: value',
    )
  })

  test('rejects credential paths outside portable roots', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      vault: [
        {
          kind: 'agent-auth',
          name: 'codex-login',
          harness: 'codex',
          path: '/Users/andy/.codex/auth.json',
          vault: 'developer',
          item: 'codex',
          field: 'auth',
        },
      ],
    } as unknown as PortableProfile

    expect(() => projectProfile(profile, 'darwin')).toThrow('non-portable credential path')
    expect(() =>
      projectProfile(
        {
          ...profile,
          vault: [{ ...profile.vault[0], path: '$HOME/../.ssh/id_ed25519' }],
        } as PortableProfile,
        'darwin',
      ),
    ).toThrow('non-portable credential path')
  })

  test('rejects unknown vault reference kinds', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      vault: [
        {
          kind: 'inline-secret',
          name: 'github-token',
          harness: 'codex',
          server: 'github',
          env: 'GITHUB_TOKEN',
          vault: 'developer',
          item: 'github',
          field: 'token',
        },
      ],
    } as unknown as PortableProfile

    expect(() => projectProfile(profile, 'darwin')).toThrow(
      'unsupported vault reference kind: inline-secret',
    )
  })

  test('rejects profile ids outside the reserved default profile', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      id: 'personal',
    } as unknown as PortableProfile

    expect(() => projectProfile(profile, 'darwin')).toThrow('unsupported profile id: personal')
  })

  test('rejects profiles outside schema v2', () => {
    const profile = {
      ...migrateManifestToProfile(manifest()),
      schemaVersion: 1,
    } as unknown as PortableProfile

    expect(() => projectProfile(profile, 'darwin')).toThrow('unsupported profile schema: 1')
  })
})
