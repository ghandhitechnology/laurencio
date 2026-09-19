import { describe, expect, test } from 'bun:test'
import { merge, mergeAppendUnion } from '../src/merge'

describe('merge dispatch', () => {
  test('routes text3way and passes marker options', () => {
    const base = 'a\nbottom\n'
    const local = 'a\n<!-- laurencio:local -->\nsecret\n<!-- /laurencio:local -->\nbottom\n'
    const remote = 'A\nbottom\n'
    const plain = merge({ strategy: 'text3way', base, local, remote })
    expect(plain.status).toBe('conflicted')
    expect(plain.content).toContain('secret')
    const withMarkers = merge({ strategy: 'text3way', base, local, remote }, { markerBlocks: true })
    expect(withMarkers.status).toBe('conflicted')
    expect(withMarkers.content).toContain('secret')
    expect(withMarkers.format.preserved).toBe(true)
  })

  test('routes jsonKeyMerge', () => {
    const result = merge(
      {
        strategy: 'jsonKeyMerge',
        base: '{\n  "model": "a"\n}\n',
        local: '{\n  "model": "a"\n}\n',
        remote: '{\n  "model": "b"\n}\n',
      },
      { unionArrays: [] },
    )
    expect(result.status).toBe('clean')
    expect(result.content).toContain('"model": "b"')
  })

  test('routes tomlKeyMerge', () => {
    const result = merge({
      strategy: 'tomlKeyMerge',
      base: 'model = "a"\n',
      local: 'model = "a"\n',
      remote: 'model = "b"\n',
    })
    expect(result.status).toBe('clean')
    expect(result.content).toBe('model = "b"\n')
  })

  test('binaryNewestWins picks the newer side', () => {
    const result = merge({
      strategy: 'binaryNewestWins',
      base: 'old',
      local: 'local',
      remote: 'remote',
      localTimestamp: '2026-09-19T10:00:00.000Z',
      remoteTimestamp: '2026-09-19T11:00:00.000Z',
    })
    expect(result.status).toBe('clean')
    expect(result.content).toBe('remote')
  })

  test('binaryNewestWins with equal timestamps reports a conflict', () => {
    const result = merge({
      strategy: 'binaryNewestWins',
      base: 'old',
      local: 'local',
      remote: 'remote',
      localTimestamp: '2026-09-19T10:00:00.000Z',
      remoteTimestamp: '2026-09-19T10:00:00.000Z',
    })
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe('local')
  })

  test('none leaves the local content alone', () => {
    const result = merge({ strategy: 'none', base: 'a', local: 'b', remote: 'c' })
    expect(result.content).toBe('b')
    expect(result.conflicts).toEqual([])
  })

  test('every strategy returns a format report', () => {
    const strategies = [
      'text3way',
      'jsonKeyMerge',
      'tomlKeyMerge',
      'appendUnion',
      'binaryNewestWins',
      'none',
    ] as const
    const inputs: Record<
      (typeof strategies)[number],
      { base: string; local: string; remote: string }
    > = {
      text3way: { base: 'a\n', local: 'a\n', remote: 'a\n' },
      jsonKeyMerge: {
        base: '{\n  "a": 1\n}\n',
        local: '{\n  "a": 1\n}\n',
        remote: '{\n  "a": 1\n}\n',
      },
      tomlKeyMerge: { base: 'a = 1\n', local: 'a = 1\n', remote: 'a = 1\n' },
      appendUnion: { base: 'a\n', local: 'a\n', remote: 'a\n' },
      binaryNewestWins: { base: 'a', local: 'a', remote: 'a' },
      none: { base: 'a', local: 'a', remote: 'a' },
    }
    for (const strategy of strategies) {
      const result = merge({
        strategy,
        ...inputs[strategy],
        localTimestamp: '2026-09-19T10:00:00.000Z',
        remoteTimestamp: '2026-09-19T10:00:00.000Z',
      })
      expect(result.format).toBeDefined()
      expect(result.status).toBe('unchanged')
    }
  })
})

describe('appendUnion', () => {
  test('appends both sides in a stable order', () => {
    const result = mergeAppendUnion('base\n', 'base\nlocal\n', 'base\nremote\n')
    expect(result.status).toBe('clean')
    expect(result.content).toBe('base\nlocal\nremote\n')
  })

  test('a deletion on one side makes it conflicted', () => {
    const result = mergeAppendUnion('a\nb\n', 'b\n', 'a\nb\nremote\n')
    expect(result.status).toBe('conflicted')
    expect(result.format.reason).toContain('deletion')
  })

  test('identical inputs report unchanged', () => {
    expect(mergeAppendUnion('a\n', 'a\n', 'a\n').status).toBe('unchanged')
  })
})
