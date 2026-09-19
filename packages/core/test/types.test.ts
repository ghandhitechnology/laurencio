import { describe, expect, test } from 'bun:test'
import { SurfaceId } from '@laurencio/protocol'
import {
  assertNever,
  isSyncable,
  type Surface,
  surfaceLabel,
  type TransformKind,
} from '../src/index'

const base = {
  harness: 'claude' as const,
  policy: 'sync' as const,
  description: 'test surface',
  transforms: [],
  secretRules: [],
}

const surfaces: Surface[] = [
  {
    ...base,
    id: SurfaceId.parse('claude.skills'),
    kind: 'tree',
    path: '$HOME/.claude/skills',
    format: 'mixed',
    merge: 'text3way',
    exclude: ['**/node_modules/**'],
  },
  {
    ...base,
    id: SurfaceId.parse('claude.settings'),
    kind: 'file',
    path: '$HOME/.claude/settings.json',
    format: 'json',
    merge: 'jsonKeyMerge',
  },
  {
    ...base,
    id: SurfaceId.parse('codex.config'),
    kind: 'keyed-file',
    path: '$HOME/.codex/config.toml',
    format: 'toml',
    merge: 'tomlKeyMerge',
    keyPolicy: { sync: ['model'], machine: ['projects'], ignore: ['notify'] },
  },
]

describe('surface helpers', () => {
  test('syncable depends on policy only', () => {
    expect(surfaces.every(isSyncable)).toBe(true)
    const never: Surface = { ...surfaces[1]!, policy: 'never' }
    expect(isSyncable(never)).toBe(false)
  })

  test('labels read as harness.name', () => {
    expect(surfaces.map(surfaceLabel)).toEqual(['claude.skills', 'claude.settings', 'codex.config'])
  })
})

describe('transform exhaustiveness', () => {
  test('every transform kind is handled', () => {
    const kinds: TransformKind[] = [
      'pathTokenize',
      'claudeSlugRekey',
      'claudeMcpExtract',
      'claudePluginRecords',
      'codexTomlSplit',
      'codexAutomationSplit',
      'opencodeSchemaNormalize',
      'markerBlocks',
    ]
    const describeKind = (kind: TransformKind): string => {
      switch (kind) {
        case 'pathTokenize':
          return 'tokenize'
        case 'claudeSlugRekey':
          return 'rekey'
        case 'claudeMcpExtract':
          return 'extract'
        case 'claudePluginRecords':
          return 'records'
        case 'codexTomlSplit':
          return 'split'
        case 'codexAutomationSplit':
          return 'automation'
        case 'opencodeSchemaNormalize':
          return 'normalize'
        case 'markerBlocks':
          return 'markers'
        default:
          return assertNever(kind)
      }
    }
    expect(kinds.map(describeKind)).toHaveLength(kinds.length)
    expect(() => assertNever('nope' as never)).toThrow()
  })
})
