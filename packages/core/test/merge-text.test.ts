import { describe, expect, test } from 'bun:test'
import {
  extractMarkerBlocks,
  mergeText3Way,
  restoreMarkerBlocks,
  unifiedDiff,
} from '../src/merge/text3way'

const join = (lines: readonly string[]): string => `${lines.join('\n')}\n`

describe('text3way: clean merges', () => {
  test('edits on separate lines merge without conflict', () => {
    const base = join(['a', 'b', 'c', 'd', 'e'])
    const local = join(['a', 'X', 'c', 'd', 'e'])
    const remote = join(['a', 'b', 'c', 'Z', 'e'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(join(['a', 'X', 'c', 'Z', 'e']))
    expect(result.conflicts).toEqual([])
  })

  test('adjacent edits on neighboring lines merge cleanly', () => {
    const base = join(['a', 'b', 'c'])
    const local = join(['a', 'b', 'L', 'c'])
    const remote = join(['a', 'b', 'c', 'R'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(join(['a', 'b', 'L', 'c', 'R']))
  })

  test('touching replacements on neighboring lines conflict, as git does', () => {
    const base = join(['a', 'b', 'c', 'd'])
    const local = join(['a', 'X', 'c', 'd'])
    const remote = join(['a', 'b', 'Y', 'd'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
  })

  test('a deletion on one side is not a conflict', () => {
    const base = join(['a', 'b', 'c', 'd'])
    const local = join(['a', 'c', 'd'])
    const remote = join(['a', 'b', 'c', 'D'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(join(['a', 'c', 'D']))
  })

  test('both sides appending different lines conflicts and keeps local', () => {
    const base = join(['a'])
    const local = join(['a', 'local'])
    const remote = join(['a', 'remote'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
  })

  test('identical change on both sides is not a conflict and keeps one copy', () => {
    const base = join(['a', 'b'])
    const changed = join(['a', 'same'])
    const result = mergeText3Way(base, changed, changed)
    // The local working copy already holds the merged content.
    expect(result.status).toBe('unchanged')
    expect(result.content).toBe(changed)
    expect(result.conflicts).toEqual([])
  })

  test('unchanged input reports unchanged', () => {
    const base = join(['a', 'b'])
    expect(mergeText3Way(base, base, base).status).toBe('unchanged')
  })
})

describe('text3way: conflicts', () => {
  test('both sides editing the same line conflicts and keeps local', () => {
    const base = join(['a', 'b', 'c'])
    const local = join(['a', 'LOCAL', 'c'])
    const remote = join(['a', 'REMOTE', 'c'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]).toEqual({
      baseRange: [2, 3],
      localRange: [2, 3],
      remoteRange: [2, 3],
    })
  })

  test('delete on one side and edit on the other conflicts', () => {
    const base = join(['a', 'b', 'c'])
    const local = join(['a', 'c'])
    const remote = join(['a', 'B', 'c'])
    const result = mergeText3Way(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
  })

  test('conflict ranges are 1-based and end exclusive', () => {
    const base = join(['one', 'two', 'three', 'four'])
    const local = join(['one', 'TWO', 'three', 'four'])
    const remote = join(['one', '2', 'three', 'four'])
    const [conflict] = mergeText3Way(base, local, remote).conflicts
    expect(conflict?.baseRange).toEqual([2, 3])
  })
})

describe('text3way: marker blocks', () => {
  const marked = join([
    'top',
    '<!-- laurencio:local -->',
    'secret local line',
    '<!-- /laurencio:local -->',
    'bottom',
  ])

  test('extract keeps anchors and lifts the body', () => {
    const { projection, blocks } = extractMarkerBlocks(marked)
    expect(projection).toBe(
      join(['top', '<!-- laurencio:local -->', '<!-- /laurencio:local -->', 'bottom']),
    )
    expect(blocks).toEqual([
      {
        startMarker: '<!-- laurencio:local -->',
        endMarker: '<!-- /laurencio:local -->',
        body: ['secret local line'],
      },
    ])
  })

  test('extract and restore round-trip', () => {
    const { projection, blocks } = extractMarkerBlocks(marked)
    expect(restoreMarkerBlocks(projection, blocks)).toBe(marked)
  })

  test('unclosed marker block throws', () => {
    expect(() => extractMarkerBlocks(join(['top', '<!-- laurencio:local -->', 'body']))).toThrow(
      'unclosed',
    )
  })

  test('nested marker block throws', () => {
    const nested = join([
      '<!-- laurencio:local -->',
      '<!-- laurencio:local -->',
      'body',
      '<!-- /laurencio:local -->',
      '<!-- /laurencio:local -->',
    ])
    expect(() => extractMarkerBlocks(nested)).toThrow('nested')
  })

  test('a remote edit next to a marker block keeps the local body', () => {
    const base = join([
      'top',
      '<!-- laurencio:local -->',
      'secret local line',
      '<!-- /laurencio:local -->',
      'bottom',
    ])
    const local = marked
    const remote = join([
      'top',
      '<!-- laurencio:local -->',
      'secret local line',
      '<!-- /laurencio:local -->',
      'BOTTOM',
    ])
    const result = mergeText3Way(base, local, remote, { markerBlocks: true })
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      join([
        'top',
        '<!-- laurencio:local -->',
        'secret local line',
        '<!-- /laurencio:local -->',
        'BOTTOM',
      ]),
    )
  })

  test('a block whose anchor was deleted is re-appended, never dropped', () => {
    const base = join([
      'top',
      '<!-- laurencio:local -->',
      'secret',
      '<!-- /laurencio:local -->',
      'bottom',
    ])
    const local = base
    const remote = join(['TOP', 'bottom'])
    const result = mergeText3Way(base, local, remote, { markerBlocks: true })
    expect(result.content).toContain('secret')
    expect(result.content).toContain('<!-- laurencio:local -->')
  })

  test('a broken marker block reports a conflict instead of throwing', () => {
    const base = join(['a'])
    const local = join(['a', '<!-- laurencio:local -->', 'orphan'])
    const result = mergeText3Way(base, local, base, { markerBlocks: true })
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.format.reason).toContain('unclosed')
  })
})

describe('text3way: symmetry', () => {
  test('clean merges are symmetric for a table of edit pairs', () => {
    const cases: Array<[string, string, string]> = [
      [join(['a', 'b', 'c']), join(['a', 'L', 'c']), join(['a', 'b', 'R'])],
      [join(['a', 'b', 'c', 'd']), join(['a', 'b', 'c']), join(['a', 'B', 'c', 'd'])],
      [join(['a', 'b']), join(['a', 'b', 'x']), join(['a', 'b', 'y'])],
      [join(['a', 'b', 'c']), join(['a', 'b', 'c', 'd', 'e']), join(['z', 'a', 'b', 'c'])],
      ['', 'only local\n', 'only remote\n'],
    ]
    for (const [base, local, remote] of cases) {
      const forward = mergeText3Way(base, local, remote)
      const backward = mergeText3Way(base, remote, local)
      expect(forward.status === 'conflicted').toBe(backward.status === 'conflicted')
      if (forward.status !== 'conflicted') expect(forward.content).toBe(backward.content)
    }
  })

  test('a generated fuzz pass stays symmetric on clean merges', () => {
    let seed = 7
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon']
    const pick = (): string => words[Math.floor(next() * words.length)] ?? 'x'
    const mutate = (lines: readonly string[]): string[] => {
      const out = [...lines]
      for (let i = 0; i < 2; i++) {
        const at = Math.floor(next() * Math.max(out.length, 1))
        const roll = next()
        if (roll < 0.4) out.splice(at, 0, pick())
        else if (roll < 0.7 && out.length > 1) out.splice(Math.min(at, out.length - 1), 1)
        else if (out.length > 0) out[Math.min(at, out.length - 1)] = pick()
      }
      return out
    }
    let clean = 0
    for (let i = 0; i < 300; i++) {
      const base = join(Array.from({ length: 3 + Math.floor(next() * 5) }, pick))
      const local = join(mutate(base.trimEnd().split('\n')))
      const remote = join(mutate(base.trimEnd().split('\n')))
      const forward = mergeText3Way(base, local, remote)
      const backward = mergeText3Way(base, remote, local)
      // Status reflects "does the caller write?" so it can differ when one side
      // made no edits; content is the invariant.
      expect(forward.status === 'conflicted').toBe(backward.status === 'conflicted')
      if (forward.status !== 'conflicted') {
        expect(forward.content).toBe(backward.content)
        if (forward.status === 'clean') clean++
      }
    }
    expect(clean).toBeGreaterThan(50)
  })
})

describe('unifiedDiff', () => {
  test('renders hunks with line counts and no index header', () => {
    const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', { from: 'local', to: 'merged' })
    expect(diff).toContain('--- local')
    expect(diff).toContain('+++ merged')
    expect(diff).toContain('@@ -1,3 +1,3 @@')
    expect(diff).toContain('-b')
    expect(diff).toContain('+B')
    expect(diff).not.toContain('Index:')
  })

  test('identical input yields an empty diff', () => {
    expect(unifiedDiff('a\n', 'a\n')).toBe('')
  })
})
