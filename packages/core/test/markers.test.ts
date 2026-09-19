import { describe, expect, test } from 'bun:test'
import {
  MarkerError,
  markerRanges,
  parseLocalBlocks,
  reinsertLocalBlocks,
  stripLocalBlocks,
} from '../src/markers'

const text = [
  '# Instructions',
  '',
  '<!-- laurencio:local -->',
  'token: abc123',
  'machine: this one',
  '<!-- /laurencio:local -->',
  '',
  'shared line',
].join('\n')

describe('parseLocalBlocks', () => {
  test('finds blocks and hashes their content', () => {
    const blocks = parseLocalBlocks('CLAUDE.md', text)
    expect(blocks).toHaveLength(1)
    const block = blocks[0]
    expect(block?.content).toBe('token: abc123\nmachine: this one')
    expect(block?.range.path).toBe('CLAUDE.md')
    expect(block?.range.startLine).toBe(3)
    expect(block?.range.endLine).toBe(6)
    expect(block?.range.contentHash).toMatch(/^[0-9a-f]{64}$/)
    if (block === undefined) throw new Error('expected one block')
    expect(markerRanges(blocks)).toEqual([block.range])
  })

  test('parses several blocks in order', () => {
    const two = [
      '<!-- laurencio:local -->',
      'one',
      '<!-- /laurencio:local -->',
      'middle',
      '<!-- laurencio:local -->',
      'two',
      '<!-- /laurencio:local -->',
    ].join('\n')
    const blocks = parseLocalBlocks('f.md', two)
    expect(blocks.map((block) => block.content)).toEqual(['one', 'two'])
  })

  test('tolerates whitespace inside the markers', () => {
    const spaced = '<!--   laurencio:local   -->\nx\n<!--  /  laurencio:local  -->'
    expect(parseLocalBlocks('f.md', spaced)).toHaveLength(1)
  })

  test('an unclosed block fails loudly', () => {
    const broken = '<!-- laurencio:local -->\nsecret'
    try {
      parseLocalBlocks('f.md', broken)
      throw new Error('expected parse to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(MarkerError)
      expect((error as MarkerError).code).toBe('unclosed')
      expect((error as MarkerError).line).toBe(1)
    }
  })

  test('nested and orphan markers fail loudly', () => {
    const nested = '<!-- laurencio:local -->\n<!-- laurencio:local -->\n<!-- /laurencio:local -->'
    expect(() => parseLocalBlocks('f.md', nested)).toThrow(MarkerError)
    const orphan = 'x\n<!-- /laurencio:local -->'
    try {
      parseLocalBlocks('f.md', orphan)
      throw new Error('expected parse to throw')
    } catch (error) {
      expect((error as MarkerError).code).toBe('orphan-close')
    }
  })
})

describe('strip and reinsert', () => {
  test('round-trips through the upload projection', () => {
    const blocks = parseLocalBlocks('CLAUDE.md', text)
    const projection = stripLocalBlocks('CLAUDE.md', text)
    expect(projection).not.toContain('abc123')
    expect(projection).toContain('<!-- laurencio:local -->')
    expect(projection).toContain('shared line')
    expect(reinsertLocalBlocks(projection, blocks)).toBe(text)
  })

  test('keeps local content when a remote edit deletes the anchor', () => {
    const blocks = parseLocalBlocks('CLAUDE.md', text)
    const projection = stripLocalBlocks('CLAUDE.md', text)
    const remote = projection.replace('<!-- laurencio:local -->', 'remote note')
    const applied = reinsertLocalBlocks(remote, blocks)
    expect(applied).toContain('remote note')
    expect(applied).toContain('token: abc123')
    expect(applied).toContain('machine: this one')
  })

  test('two local blocks survive a deleted anchor', () => {
    const two = [
      '<!-- laurencio:local -->',
      'one',
      '<!-- /laurencio:local -->',
      '<!-- laurencio:local -->',
      'two',
      '<!-- /laurencio:local -->',
      '',
    ].join('\n')
    const blocks = parseLocalBlocks('f.md', two)
    const projection = stripLocalBlocks('f.md', two).replace(
      '<!-- laurencio:local -->',
      '<!-- gone -->',
    )
    const applied = reinsertLocalBlocks(projection, blocks)
    expect(applied).toContain('one')
    expect(applied).toContain('two')
  })

  test('stripping a text without markers is identity', () => {
    expect(stripLocalBlocks('f.md', 'plain text\n')).toBe('plain text\n')
  })

  test('a malformed projection with no anchors is appended, never dropped', () => {
    const blocks = parseLocalBlocks('f.md', text)
    const applied = reinsertLocalBlocks('<!-- laurencio:local -->\nx', blocks)
    expect(applied).toContain('token: abc123')
  })

  test('an unclosed projection marker receives its local content and a close', () => {
    const blocks = parseLocalBlocks('f.md', text)
    const applied = reinsertLocalBlocks('<!-- laurencio:local -->\nremote', blocks)
    expect(applied).toContain('token: abc123')
    expect(applied).toContain('<!-- /laurencio:local -->')
  })
})
