import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  looksLikeHighEntropySecret,
  type SecretRuleId,
  shannonEntropy,
} from '../../src/secrets/patterns'
import {
  assertClean,
  formatOverrideRecord,
  overrideLogPath,
  readOverrideLog,
  recordOverrides,
  type ScanFile,
  SecretBlockedError,
  scanFiles,
  scanText,
} from '../../src/secrets/scan'

interface CorpusEntry {
  id: string
  path: string
  content: string
  rules?: string[]
}

interface Corpus {
  secret: CorpusEntry[]
  clean: CorpusEntry[]
}

const corpus: Corpus = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'secrets', 'corpus.json'), 'utf8'),
)

describe('secret corpus: planted secrets are blocked', () => {
  for (const entry of corpus.secret) {
    test(`${entry.id} is blocked`, () => {
      const findings = scanText(entry.path, entry.content)
      expect(findings.length).toBeGreaterThan(0)
      const rules = new Set(findings.map((finding) => finding.rule))
      for (const expected of entry.rules ?? []) expect(rules).toContain(expected as SecretRuleId)
      const report = scanFiles([{ path: entry.path, content: entry.content }])
      expect(report.clean).toBe(false)
      expect(report.blocked).toContain(entry.path)
      expect(() => assertClean(report)).toThrow(SecretBlockedError)
    })
  }

  test('every planted file is blocked in one pass', () => {
    const files: ScanFile[] = corpus.secret.map((entry) => ({
      path: entry.path,
      content: entry.content,
    }))
    const report = scanFiles(files)
    expect(report.clean).toBe(false)
    expect(report.findings.length).toBeGreaterThanOrEqual(corpus.secret.length)
  })

  test('a single finding blocks the whole surface, not just the line', () => {
    const files: ScanFile[] = [
      { path: 'codex/config.toml', content: '[mcp_servers.x]\nmodel = "gpt-5"\n' },
      { path: 'codex/mcp.toml', content: 'token = "ghp_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"\n' },
    ]
    const report = scanFiles(files)
    expect(report.blocked).toEqual(['codex/mcp.toml'])
  })
})

describe('secret corpus: clean values are not blocked', () => {
  for (const entry of corpus.clean) {
    test(`${entry.id} passes`, () => {
      expect(scanText(entry.path, entry.content)).toEqual([])
    })
  }
})

describe('findings are redacted', () => {
  test('raw secret text never appears in a finding', () => {
    const secret = 'ghp_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789'
    const findings = scanText('claude.json', `token = "${secret}"`)
    expect(findings).toHaveLength(1)
    const finding = findings[0]
    expect(finding?.match).not.toContain(secret)
    expect(finding?.match.length).toBeLessThan(secret.length)
    expect(JSON.stringify(findings)).not.toContain(secret)
  })

  test('PEM findings report only the header', () => {
    const body =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmU\n-----END OPENSSH PRIVATE KEY-----'
    const findings = scanText('key.txt', body)
    expect(findings).toHaveLength(1)
    expect(findings[0]?.match).toBe('-----BEGIN OPENSSH PRIVATE KEY----- ...')
  })
})

describe('entropy heuristic', () => {
  test('a random-looking value is flagged, prose is not', () => {
    expect(looksLikeHighEntropySecret('Qw9Er2Ty5Ui8Op1As4Df7Gh3Jk6Lz0Xc2Vb5Nm9Qw4E')).toBe(true)
    expect(looksLikeHighEntropySecret('the quick brown fox jumps over the lazy dog')).toBe(false)
    expect(looksLikeHighEntropySecret('claude-sonnet-4-5-20250929')).toBe(false)
    expect(shannonEntropy('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(0)
  })

  test('entropy is only applied to structured config values', () => {
    const value = 'Qw9Er2Ty5Ui8Op1As4Df7Gh3Jk6Lz0Xc2Vb5Nm9Qw4E'
    expect(scanText('notes.md', value)).toEqual([])
    expect(scanText('opencode/opencode.json', `{"key":"${value}"}`)).toHaveLength(1)
  })

  test('JSON and JSONC property names are not treated as values', () => {
    const packagePath = 'node_modules/@msgpackr-extract/msgpackr-extract-darwin-arm64'
    const configId = 'cursor-grok-4.6-high-fast'
    expect(
      scanText(
        'opencode/package-lock.json',
        JSON.stringify({ packages: { [packagePath]: { version: '3.0.4' } } }),
      ),
    ).toEqual([])
    expect(
      scanText(
        'opencode/opencode.jsonc',
        `{
          // Model identifiers are object keys, not credential values.
          "models": { "${configId}": { "name": "Grok 4.6" }, },
        }`,
      ),
    ).toEqual([])
  })

  test('JSON string values still receive entropy checks', () => {
    const value = 'Qw9Er2Ty5Ui8Op1As4Df7Gh3Jk6Lz0Xc2Vb5Nm9Qw4E'
    expect(
      scanText(
        'opencode/opencode.jsonc',
        `{
          // Comments and trailing commas are valid in this config.
          "apiKey": "${value}",
        }`,
      ).map((finding) => finding.rule),
    ).toEqual(['entropy-string'])
  })

  test('automation recurrence rules and public hash lists pass', () => {
    const hashA = '6d25a30a8e6145352d0a785fabf826e1490c5a30518524d737ac23334fff3121'
    const hashB = 'ac5078ff779ba21df9f662222a432e7ba7266eda06d9018d690435af976f48ee'
    expect(
      scanText(
        'codex/automation.toml',
        [
          'rrule = "RRULE:FREQ=WEEKLY;BYHOUR=3;BYMINUTE=0;BYDAY=SU,MO,TU,WE,TH,FR,SA"',
          'once = "DTSTART;TZID=Asia/Seoul:20260815T065000\\nRRULE:FREQ=DAILY;COUNT=1"',
          `trusted_hashes = "${hashA},${hashB}"`,
          `trusted_hash = "sha256:${hashA}"`,
        ].join('\n'),
      ),
    ).toEqual([])
  })
})

describe('override log', () => {
  test('records what was overridden and where', () => {
    const home = mkdtempSync(join(tmpdir(), 'laurencio-override-'))
    const findings = scanText(
      'claude/settings.json',
      '{"env":{"OPENAI_API_KEY":"sk-proj-4eC39HqLyjWDarjtT1zdp7dcOY2S6wqPf0RkM9TfXbLz"}}',
    )
    expect(findings).toHaveLength(1)
    const path = recordOverrides(
      home,
      findings.map((finding) => ({
        at: '2026-09-19T00:00:00.000Z',
        path: finding.path,
        rule: finding.rule,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        reason: 'test override',
      })),
    )
    expect(path).toBe(overrideLogPath(home))
    const records = readOverrideLog(home)
    expect(records.length).toBeGreaterThanOrEqual(findings.length)
    expect(records[0]?.path).toBe('claude/settings.json')
    expect(records[0]?.reason).toBe('test override')
  })

  test('overridden paths are reported but do not block', () => {
    const files: ScanFile[] = [
      {
        path: 'claude/settings.json',
        content: '{"env":{"X":"ghp_9aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789"}}',
      },
    ]
    const report = scanFiles(files, { overrides: ['claude/settings.json'] })
    expect(report.findings).toHaveLength(1)
    expect(report.clean).toBe(true)
    expect(() => assertClean(report)).not.toThrow()
  })

  test('log lines are tab-separated and single-line', () => {
    const line = formatOverrideRecord({
      at: '2026-09-19T00:00:00.000Z',
      path: 'a/b.json',
      rule: 'openai-key',
      line: 3,
      reason: 'reason\twith tab',
    })
    expect(line.split('\t')).toHaveLength(5)
    expect(line).not.toContain('\n')
  })
})
