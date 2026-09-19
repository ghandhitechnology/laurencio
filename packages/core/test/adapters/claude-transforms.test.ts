import { describe, expect, test } from 'bun:test'
import {
  claudeMcpExtract,
  claudePathRewrite,
  claudePluginRecords,
  claudeSlugRekey,
  expandPathsInText,
  type JsonObject,
  memoryIdentityKey,
  tokenizePathsInText,
} from '../../src/adapters/claude/transforms'
import type { TokenEnv } from '../../src/paths'

const tokenEnv: TokenEnv = { home: '/Users/pyu', platform: 'darwin', env: {} }
const hashPattern = /^[0-9a-f]{64}$/
const braced = (name: string): string => `\${${name}}`
const CONFIG_ROOT = braced('CLAUDE_CONFIG_DIR')

describe('claudeMcpExtract', () => {
  const config = {
    oauthAccount: { emailAddress: 'person@example.com' },
    machineID: 'machine-1',
    projects: { '/Users/pyu/projects/demo': { hasTrustDialogAccepted: true } },
    mcpServers: {
      'my-tools': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'my-tools@latest'],
        env: { API_KEY: 'sk-live-secret', EMPTY: '', ALREADY: braced('EXISTING') },
      },
      remote: {
        type: 'http',
        url: 'https://example.test/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
      malformed: 'not-an-object',
    },
  }

  test('extracts only mcpServers and indirects env values', () => {
    const result = claudeMcpExtract(config)
    expect(Object.keys(result.value)).toEqual(['mcpServers'])
    const servers = result.value.mcpServers as JsonObject
    expect(servers['my-tools']).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'my-tools@latest'],
      env: { API_KEY: braced('API_KEY'), EMPTY: '', ALREADY: braced('EXISTING') },
    })
    expect(servers.remote).toMatchObject({
      type: 'http',
      headers: { Authorization: 'Bearer secret' },
    })
    expect(servers.malformed).toBe('not-an-object')
    expect(result.indirectEnv).toEqual([{ server: 'my-tools', key: 'API_KEY' }])
    expect(result.ignoredKeys).toContain('oauthAccount')
    expect(result.ignoredKeys).toContain('machineID')
    expect(result.ignoredKeys).toContain('projects')
    expect(result.ignoredKeys).not.toContain('mcpServers')
  })

  test('never mutates the source document', () => {
    claudeMcpExtract(config)
    expect(config.mcpServers['my-tools'].env.API_KEY).toBe('sk-live-secret')
  })

  test('tolerates a missing or malformed mcpServers table', () => {
    expect(claudeMcpExtract({ other: true })).toEqual({
      value: { mcpServers: {} },
      indirectEnv: [],
      ignoredKeys: ['other'],
    })
    expect(claudeMcpExtract('not json').value).toEqual({ mcpServers: {} })
    expect(claudeMcpExtract({ mcpServers: 'nope' }).value).toEqual({ mcpServers: {} })
  })
})

describe('claudePluginRecords', () => {
  test('strips install paths and timestamps from plugin records', () => {
    const records = {
      version: 2,
      plugins: {
        'tool@marketplace': [
          {
            scope: 'user',
            installPath: '/Users/pyu/.claude/plugins/cache/marketplace/tool/1.0.0',
            version: '1.0.0',
            installedAt: '2026-08-14T16:47:32.991Z',
            lastUpdated: '2026-08-14T16:47:32.991Z',
          },
        ],
      },
    }
    const result = claudePluginRecords(records)
    expect(result.value).toEqual({
      version: 2,
      plugins: {
        'tool@marketplace': [{ scope: 'user', version: '1.0.0' }],
      },
    })
    expect(result.stripped).toEqual([
      'plugins.tool@marketplace.0.installPath',
      'plugins.tool@marketplace.0.installedAt',
      'plugins.tool@marketplace.0.lastUpdated',
    ])
    expect(records.plugins['tool@marketplace'][0]?.installPath).toBeDefined()
  })

  test('strips installLocation from marketplace records', () => {
    const records = {
      marketplace: {
        source: { source: 'github', repo: 'example/marketplace' },
        installLocation: '/Users/pyu/.claude/plugins/marketplaces/marketplace',
        lastUpdated: '2026-09-18T16:30:23.432Z',
      },
    }
    const result = claudePluginRecords(records)
    expect(result.value).toEqual({
      marketplace: { source: { source: 'github', repo: 'example/marketplace' } },
    })
    expect(result.stripped).toEqual(['marketplace.installLocation', 'marketplace.lastUpdated'])
  })

  test('passes non-object input through as null', () => {
    expect(claudePluginRecords('nope').value).toBeNull()
  })
})

describe('claudeSlugRekey', () => {
  const project = {
    slug: '-Users-pyu-projects-Laurencio',
    projectPath: '/Users/pyu/projects/Laurencio',
    repoRoot: '/Users/pyu/projects/Laurencio',
    repoRemote: 'git@github.com:pyu/Laurencio.git',
  }

  test('keys a repository by remote and never stores the slug', () => {
    const rekey = claudeSlugRekey(project)
    expect(rekey.slug).toBe(project.slug)
    expect(rekey.identity.repoRelativePath).toBe('')
    expect(rekey.identity.fallbackHash).toMatch(hashPattern)
    expect(rekey.storePrefix.startsWith('memory/repo-')).toBe(true)
    expect(rekey.storePrefix).not.toContain('Users')
    expect(rekey.storePrefix).not.toContain(project.slug)
  })

  test('is stable for the same repository and different across remotes', () => {
    expect(memoryIdentityKey(claudeSlugRekey(project).identity)).toBe(
      memoryIdentityKey(claudeSlugRekey(project).identity),
    )
    const other = claudeSlugRekey({ ...project, repoRemote: 'git@github.com:pyu/Other.git' })
    expect(memoryIdentityKey(other.identity)).not.toBe(
      memoryIdentityKey(claudeSlugRekey(project).identity),
    )
  })

  test('falls back to a hash of the repo path without a remote', () => {
    const noRemote = {
      slug: project.slug,
      projectPath: project.projectPath,
      repoRoot: project.repoRoot,
    }
    const rekey = claudeSlugRekey(noRemote)
    expect(rekey.identity.repoRemote).toBeUndefined()
    expect(rekey.storePrefix.startsWith('memory/path-')).toBe(true)
    const elsewhere = claudeSlugRekey({
      ...noRemote,
      projectPath: '/Users/pyu/other',
      repoRoot: '/Users/pyu/other',
    })
    expect(memoryIdentityKey(elsewhere.identity)).not.toBe(memoryIdentityKey(rekey.identity))
  })

  test('records the repository relative path for projects in a subdirectory', () => {
    const nested = claudeSlugRekey({
      ...project,
      projectPath: '/Users/pyu/projects/Laurencio/packages/core',
    })
    expect(nested.identity.repoRelativePath).toBe('packages/core')
    expect(nested.storePrefix.endsWith('packages_core')).toBe(true)
    const outside = claudeSlugRekey({ ...project, projectPath: '/Users/pyu/elsewhere' })
    expect(outside.identity.repoRelativePath).toBe('')
  })
})

describe('claudePathRewrite', () => {
  test('tokenizes quoted and unquoted absolute paths in command text', () => {
    const script = '/Users/pyu/.claude/hooks/herdr-agent-state.sh'
    const result = tokenizePathsInText(`bash '${script}' session`, tokenEnv)
    expect(result).toEqual({
      text: `bash '${CONFIG_ROOT}/hooks/herdr-agent-state.sh' session`,
      count: 1,
    })

    const multi = tokenizePathsInText(
      `'/Users/pyu/my dir/x.sh' && /Users/pyu/bin/b.sh --flag && PATH=/Users/pyu/bin:$PATH`,
      tokenEnv,
    )
    expect(multi.text).toBe("'$HOME/my dir/x.sh' && $HOME/bin/b.sh --flag && PATH=$HOME/bin:$PATH")
    expect(multi.count).toBe(3)
  })

  test('leaves paths no token covers alone and does not split sibling names', () => {
    const text = '/usr/local/bin/node /Users/pyu2/x.sh /Users/pyu3'
    expect(tokenizePathsInText(text, tokenEnv)).toEqual({ text, count: 0 })
    expect(tokenizePathsInText('echo /usr/bin/env', tokenEnv).text).toBe('echo /usr/bin/env')
  })

  test('respects an explicit CLAUDE_CONFIG_DIR and round-trips through expand', () => {
    const override: TokenEnv = {
      home: '/Users/pyu',
      platform: 'darwin',
      env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
    }
    const tokenized = tokenizePathsInText(
      "bash '/custom/claude/hooks/x.sh' /Users/pyu/.claude/y.sh",
      override,
    )
    expect(tokenized.text).toBe(`bash '${CONFIG_ROOT}/hooks/x.sh' $HOME/.claude/y.sh`)
    expect(expandPathsInText(tokenized.text, override)).toEqual({
      text: "bash '/custom/claude/hooks/x.sh' /Users/pyu/.claude/y.sh",
      count: 2,
    })
  })

  test('rewrites settings hooks and statusLine without touching other keys', () => {
    const settings: JsonObject = {
      model: 'opus',
      hooks: {
        SessionStart: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: "bash '/Users/pyu/.claude/hooks/session.sh'",
                timeout: 10,
              },
            ],
          },
        ],
      },
      statusLine: { type: 'command', command: '/Users/pyu/.claude/statusline.sh' },
    }
    const result = claudePathRewrite(settings, tokenEnv)
    expect(result.rewritten).toEqual([
      'hooks.SessionStart[0].hooks[0].command',
      'statusLine.command',
    ])
    expect(result.value).toMatchObject({
      model: 'opus',
      statusLine: { type: 'command', command: `${CONFIG_ROOT}/statusline.sh` },
    })
    expect(JSON.stringify(result.value)).toContain(`${CONFIG_ROOT}/hooks/session.sh`)
    expect(JSON.stringify(settings)).toContain('/Users/pyu/.claude/hooks/session.sh')
  })

  test('reports nothing rewritten when settings carry no absolute paths', () => {
    const settings: JsonObject = {
      model: 'opus',
      statusLine: { type: 'command', command: 'echo hi' },
    }
    const result = claudePathRewrite(settings, tokenEnv)
    expect(result.rewritten).toEqual([])
    expect(result.value).toEqual(settings)
  })
})
