import { expect, test } from 'bun:test'
import { parse as parseToml } from 'smol-toml'
import { discoverMcpSecrets } from '../../src/secrets/mcp'
import { scanText } from '../../src/secrets/scan'

const token = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij'

test('sensitive MCP field names capture short secrets and scanners block them before import', () => {
  const cases = [
    {
      harness: 'claude' as const,
      path: 'claude.json',
      content:
        '{"mcpServers":{"local":{"env":{"API_KEY":"secret123","LOG_LEVEL":"debug"},"headers":{"Authorization":"abc123"}}}}',
    },
    {
      harness: 'opencode' as const,
      path: 'opencode.jsonc',
      content:
        '{"mcp":{"local":{"environment":{"API_KEY":"secret123","LOG_LEVEL":"debug"},"headers":{"Authorization":"abc123"}}}}',
    },
    {
      harness: 'codex' as const,
      path: 'config.toml',
      content:
        '[mcp_servers.local]\nenv = { API_KEY = "secret123", LOG_LEVEL = "debug" }\nhttp_headers = { Authorization = "abc123" }\n',
    },
  ]
  for (const fixture of cases) {
    const discovered = discoverMcpSecrets(fixture.harness, fixture.content)
    expect(discovered.secrets.map((entry) => entry.value)).toEqual(['secret123', 'abc123'])
    expect(discovered.content).toContain('debug')
    const findings = scanText(fixture.path, fixture.content)
    expect(findings.some((finding) => finding.rule === 'sensitive-field')).toBe(true)
    expect(JSON.stringify(findings)).not.toContain('secret123')
    expect(JSON.stringify(findings)).not.toContain('abc123')
    expect(scanText(fixture.path, discovered.content)).toEqual([])
  }
  expect(scanText('public.json', '{"env":{"LOG_LEVEL":"debug","REGION":"us-east-1"}}')).toEqual([])
  for (const key of ['API_KEY', 'Authorization']) {
    expect(
      scanText('short.json', JSON.stringify({ [key]: 'abc123' })).map((finding) => finding.rule),
    ).toEqual(['sensitive-field'])
  }
})

test('Codex HTTP header credentials use native env_http_headers and keep public settings', () => {
  const original = `[mcp_servers.github]\nurl = "https://example.com/mcp"\n[mcp_servers.github.http_headers]\nAuthorization = "Bearer ${token}"\n[mcp_servers.github.env]\nNODE_OPTIONS = "--max-old-space-size=4096"\n`
  const result = discoverMcpSecrets('codex', original)
  expect(result.secrets).toHaveLength(1)
  expect(result.secrets[0]?.value).toBe(`Bearer ${token}`)
  expect(result.content).not.toContain(token)
  const parsed = parseToml(result.content)
  expect(parsed).toMatchObject({
    mcp_servers: {
      github: {
        env_http_headers: { Authorization: 'GITHUB_HEADER_AUTHORIZATION' },
        env: { NODE_OPTIONS: '--max-old-space-size=4096' },
      },
    },
  })
})

test('native references discover only their named environment values and preserve JSONC', () => {
  const original =
    '// retain this comment\n{ "mcp": { "github": { "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" }, "environment": { "CACHE": "/a/public/cache/directory/for/tools" } } } }\n'
  const result = discoverMcpSecrets('opencode', original)
  expect(result.content).toBe(original)
  expect(result.secrets).toHaveLength(1)
  expect(result.secrets[0]?.reference.env).toBe('GITHUB_TOKEN')
  expect(result.secrets[0]?.value).toBeNull()
})
