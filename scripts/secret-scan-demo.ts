/**
 * Secret scan demo.
 *
 * Seeds a scratch HOME with fake credentials in the three places they actually
 * hide (an MCP env block, a settings `env` block, and a credentials file), runs
 * the scanner over them, and prints the fail-closed block plus the override log
 * path. Exits non-zero if any planted secret slips through.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewriteEnv } from '../packages/core/src/secrets/placeholders'
import {
  assertClean,
  overrideLogPath,
  readOverrideLog,
  recordOverrides,
  type ScanFile,
  SecretBlockedError,
  scanFiles,
} from '../packages/core/src/secrets/scan'

const planted: ScanFile[] = [
  {
    path: 'claude.json',
    content: `${JSON.stringify(
      {
        mcpServers: {
          github: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: {
              GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
            },
          },
        },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: 'claude/settings.json',
    content: `${JSON.stringify(
      {
        theme: 'dark',
        env: {
          ANTHROPIC_API_KEY: 'sk-ant-api03-7Rk2mQp9vXw4bNc6dGh1jLf5sZa8yE3tU',
          OPENAI_API_KEY: 'sk-proj-4eC39HqLyjWDarjtT1zdp7dcOY2S6wqPf0RkM9TfXbLz',
        },
      },
      null,
      2,
    )}\n`,
  },
  {
    path: 'claude/.credentials.json',
    content: `${JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-9Qw2ErTy4UiOp5AsDf6GhJk7LzXc8VbNm3Qw',
          refreshToken: 'sk-ant-ort01-2Wq4ErTy6UiOp8AsDf0GhJk2LzXc5VbNm',
        },
      },
      null,
      2,
    )}\n`,
  },
]

function main(): number {
  const home = mkdtempSync(join(tmpdir(), 'laurencio-secret-demo-'))
  mkdirSync(join(home, '.claude'), { recursive: true })
  for (const file of planted) {
    const target = join(home, file.path)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, file.content, { mode: 0o600 })
  }

  console.log(`scratch HOME: ${home}`)
  console.log(`planted ${planted.length} files, scanning before upload\n`)

  const report = scanFiles(planted)
  for (const finding of report.findings) {
    console.log(
      `  blocked ${finding.path}:${finding.line ?? 0}  ${finding.rule}  [${finding.severity}]  ${finding.match}`,
    )
  }

  try {
    assertClean(report)
    console.log('\nFAIL: scan passed, planted secrets were not blocked')
    return 1
  } catch (error) {
    if (!(error instanceof SecretBlockedError)) throw error
    console.log(`\n${error.message}`)
    console.log(`blocked surfaces: ${error.blocked.join(', ')}`)
  }

  const logPath = recordOverrides(
    home,
    report.findings.map((finding) => ({
      at: new Date().toISOString(),
      path: finding.path,
      rule: finding.rule,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      reason: 'demo override after manual review',
    })),
  )
  console.log(`\noverride log: ${logPath} (expected at ${overrideLogPath(home)})`)
  console.log(`override records: ${readOverrideLog(home).length}`)

  const rewritten = rewriteEnv(
    'codex',
    { path: 'codex/config.toml', scope: 'mcp_internal' },
    {
      INTERNAL_SHARED_SECRET: 'mF7bQ2xZ9pL4vN6cR1tY8uI3oP5aS0dG7hJ2kM4nB6vC9xZ',
    },
  )
  const movedCount = rewritten.moved.length
  console.log(
    `\ncodex value moved to the device-local store: ${movedCount} secret${movedCount === 1 ? '' : 's'}`,
  )
  console.log(`placeholder left behind: ${rewritten.values.INTERNAL_SHARED_SECRET}`)
  return 0
}

process.exitCode = main()
