import { describe, expect, test } from 'bun:test'
import { mergeJsonc } from '../src/merge/jsonMerge'

const settings = (body: string): string => `{\n${body}\n}\n`

describe('jsonMerge: formatting preservation', () => {
  test('a remote scalar edit keeps comments, key order, and indentation', () => {
    const base = settings(`  // model preference\n  "model": "opus",\n  "theme": "dark"`)
    const local = settings(`  // model preference\n  "model": "opus",\n  "theme": "dark"`)
    const remote = settings(`  // model preference\n  "model": "sonnet",\n  "theme": "dark"`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      settings(`  // model preference\n  "model": "sonnet",\n  "theme": "dark"`),
    )
    expect(result.format).toEqual({ preserved: true, mode: 'patched' })
  })

  test('trailing comments on the edited line survive', () => {
    const base = settings(`  "model": "opus", // keep me\n  "theme": "dark"`)
    const remote = settings(`  "model": "sonnet", // keep me\n  "theme": "dark"`)
    const result = mergeJsonc(base, base, remote)
    expect(result.content).toContain('"model": "sonnet", // keep me')
  })

  test('comments inside a nested object survive a leaf edit', () => {
    const base = settings(`  "permissions": {\n    // allow list\n    "allow": ["Read"]\n  }`)
    const remote = settings(
      `  "permissions": {\n    // allow list\n    "allow": ["Read", "Write"]\n  }`,
    )
    const result = mergeJsonc(base, base, remote)
    expect(result.content).toContain('// allow list')
    expect(result.content).toContain('"Read"')
    expect(result.content).toContain('"Write"')
  })

  test('tab indentation and CRLF are preserved', () => {
    const base = '{\r\n\t"model": "opus"\r\n}\r\n'
    const remote = '{\r\n\t"model": "sonnet"\r\n}\r\n'
    const result = mergeJsonc(base, base, remote)
    expect(result.content).toBe('{\r\n\t"model": "sonnet"\r\n}\r\n')
  })

  test('a deleted key takes its line with it', () => {
    const base = settings(`  "model": "opus",\n  "theme": "dark"`)
    const remote = settings(`  "theme": "dark"`)
    const result = mergeJsonc(base, base, remote)
    expect(result.content).toBe(settings(`  "theme": "dark"`))
  })
})

describe('jsonMerge: unknown keys', () => {
  test('unknown keys added by both sides survive', () => {
    const base = settings(`  "model": "opus"`)
    const local = settings(`  "model": "opus",\n  "unknownLocal": { "a": 1 }`)
    const remote = settings(`  "model": "opus",\n  "unknownRemote": [1, 2]`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toContain('"unknownLocal"')
    expect(result.content).toContain('"unknownRemote"')
  })

  test('an unknown key changed on both sides identically merges once', () => {
    const base = settings(`  "custom": { "n": 1 }`)
    const local = settings(`  "custom": { "n": 2 }`)
    const remote = settings(`  "custom": { "n": 2 }`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('unchanged')
    expect(result.content.match(/"custom"/g)).toHaveLength(1)
    expect(result.content).toContain('"n": 2')
  })

  test('disjoint nested edits under one unknown key merge', () => {
    const base = settings(`  "custom": { "a": 1, "b": 1 }`)
    const local = settings(`  "custom": { "a": 2, "b": 1 }`)
    const remote = settings(`  "custom": { "a": 1, "b": 2 }`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toContain('"a": 2')
    expect(result.content).toContain('"b": 2')
  })
})

describe('jsonMerge: arrays', () => {
  test('a known append-only array unions both sides', () => {
    const base = settings(`  "allow": ["Read"]`)
    const local = settings(`  "allow": ["Read", "Write"]`)
    const remote = settings(`  "allow": ["Read", "Bash(ls:*)"]`)
    const result = mergeJsonc(base, local, remote, { unionArrays: ['allow'] })
    expect(result.status).toBe('clean')
    expect(result.content).toContain('"Read"')
    expect(result.content).toContain('"Write"')
    expect(result.content).toContain('"Bash(ls:*)"')
    expect(result.format.preserved).toBe(true)
  })

  test('a union array keeps the local formatting of its lines', () => {
    const base = settings(`  "allow": [\n    "Read"\n  ]`)
    const local = settings(`  "allow": [\n    "Read",\n    "Write"\n  ]`)
    const remote = settings(`  "allow": [\n    "Read",\n    "Bash(ls:*)"\n  ]`)
    const result = mergeJsonc(base, local, remote, { unionArrays: ['allow'] })
    expect(result.content).toBe(
      settings(`  "allow": [\n    "Read",\n    "Write",\n    "Bash(ls:*)"\n  ]`),
    )
  })

  test('several remote additions in one union merge land once each', () => {
    const base = settings(`  "allow": [\n    "a"\n  ]`)
    const local = settings(`  "allow": [\n    "a",\n    "local"\n  ]`)
    const remote = settings(`  "allow": [\n    "a",\n    "b",\n    "c"\n  ]`)
    const result = mergeJsonc(base, local, remote, { unionArrays: ['allow'] })
    expect(result.status).toBe('clean')
    expect(result.format.preserved).toBe(true)
    for (const item of ['"a"', '"local"', '"b"', '"c"']) {
      expect(result.content.match(new RegExp(item, 'g'))).toHaveLength(1)
    }
  })

  test('an array not marked append-only conflicts when both sides change it', () => {
    const base = settings(`  "hooks": ["a"]`)
    const local = settings(`  "hooks": ["a", "b"]`)
    const remote = settings(`  "hooks": ["a", "c"]`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.conflicts).toHaveLength(1)
  })
})

describe('jsonMerge: conflicts', () => {
  test('both sides editing the same scalar conflicts and keeps local', () => {
    const base = settings(`  "model": "a"`)
    const local = settings(`  "model": "b"`)
    const remote = settings(`  "model": "c"`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.format).toEqual({ preserved: true, mode: 'verbatim' })
  })

  test('delete on one side and edit on the other conflicts', () => {
    const base = settings(`  "model": "a",\n  "theme": "dark"`)
    const local = settings(`  "model": "b",\n  "theme": "dark"`)
    const remote = settings(`  "theme": "dark"`)
    const result = mergeJsonc(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
  })

  test('conflict ranges point at the offending line', () => {
    const base = settings(`  "a": 1,\n  "model": "a",\n  "z": 3`)
    const local = settings(`  "a": 1,\n  "model": "b",\n  "z": 3`)
    const remote = settings(`  "a": 1,\n  "model": "c",\n  "z": 3`)
    const result = mergeJsonc(base, local, remote)
    expect(result.conflicts[0]?.baseRange).toEqual([3, 4])
    expect(result.conflicts[0]?.localRange).toEqual([3, 4])
  })

  test('invalid JSONC refuses the merge instead of rewriting', () => {
    const local = '{\n  "model": "a",\n}\n' // trailing comma is fine
    const remote = '{\n  "model": "b"\n'
    const result = mergeJsonc('{\n  "model": "a"\n}\n', local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.format.reason).toContain('invalid JSONC')
  })
})

describe('jsonMerge: symmetry', () => {
  test('clean merges agree on values even when insertion order differs', () => {
    const base = settings(`  "model": "opus",\n  "custom": { "a": 1 }`)
    const local = settings(`  "model": "sonnet",\n  "custom": { "a": 1 },\n  "localOnly": true`)
    const remote = settings(`  "model": "opus",\n  "custom": { "a": 2 },\n  "remoteOnly": true`)
    const forward = mergeJsonc(base, local, remote)
    const backward = mergeJsonc(base, remote, local)
    expect(forward.status).toBe('clean')
    expect(backward.status).toBe('clean')
    // Inserted keys follow the argument order; the values are identical.
    expect(JSON.parse(forward.content)).toEqual(JSON.parse(backward.content))
  })

  test('a clean merge with no insertions is byte-identical in both orders', () => {
    const base = settings(`  "model": "opus",\n  "theme": "dark"`)
    const local = settings(`  "model": "sonnet",\n  "theme": "dark"`)
    const remote = settings(`  "model": "opus",\n  "theme": "light"`)
    const forward = mergeJsonc(base, local, remote)
    const backward = mergeJsonc(base, remote, local)
    expect(forward.status).toBe('clean')
    expect(forward.content).toBe(backward.content)
  })
})
