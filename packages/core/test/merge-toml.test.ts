import { describe, expect, test } from 'bun:test'
import { mergeToml } from '../src/merge/tomlMerge'

const codex = (body: string): string => `${body}\n`

describe('tomlMerge: formatting preservation', () => {
  test('a remote scalar edit keeps the key comment and the file layout', () => {
    const base = codex(`# codex config
model = "gpt-5" # portable
approval_policy = "on-request"`)
    const remote = codex(`# codex config
model = "o3" # portable
approval_policy = "on-request"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`# codex config
model = "o3" # portable
approval_policy = "on-request"`),
    )
    expect(result.format).toEqual({ preserved: true, mode: 'patched' })
  })

  test('comments and blank lines elsewhere are untouched', () => {
    const base = codex(`# top
model = "a"

# section note
[tui]
theme = "dark" # keep
`)
    const remote = codex(`# top
model = "b"

# section note
[tui]
theme = "dark" # keep
`)
    const result = mergeToml(base, base, remote)
    expect(result.content).toBe(
      codex(`# top
model = "b"

# section note
[tui]
theme = "dark" # keep
`),
    )
  })

  test('a table-aware edit lands in the right table', () => {
    const base = codex(`[tui]
theme = "dark"

[history]
persistence = "save-all"`)
    const remote = codex(`[tui]
theme = "dark"

[history]
persistence = "none"`)
    const result = mergeToml(base, base, remote)
    expect(result.content).toBe(
      codex(`[tui]
theme = "dark"

[history]
persistence = "none"`),
    )
  })

  test('a remote key added to an existing table keeps the table comment', () => {
    const base = codex(`[tui]
theme = "dark" # keep this`)
    const remote = codex(`[tui]
theme = "dark" # keep this
notifications = false`)
    const result = mergeToml(base, base, remote)
    expect(result.content).toBe(
      codex(`[tui]
theme = "dark" # keep this
notifications = false`),
    )
  })

  test('a remote table added at the end keeps its comments', () => {
    const base = codex(`model = "gpt-5"`)
    const remote = codex(`model = "gpt-5"

# feature flags
[features]
web_search = true`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`model = "gpt-5"

# feature flags
[features]
web_search = true`),
    )
  })

  test('a deleted key removes only its line', () => {
    const base = codex(`# keep
model = "a"
approval_policy = "on-request" # drop me
theme = "dark"`)
    const remote = codex(`# keep
model = "a"
theme = "dark"`)
    const result = mergeToml(base, base, remote)
    expect(result.content).toBe(
      codex(`# keep
model = "a"
theme = "dark"`),
    )
  })

  test('dotted keys inside a table are patched by full path', () => {
    const base = codex(`[mcp_servers.filesystem]
command = "npx"
args = ["-y", "server"]`)
    const remote = codex(`[mcp_servers.filesystem]
command = "bunx"
args = ["-y", "server"]`)
    const result = mergeToml(base, base, remote)
    expect(result.content).toBe(
      codex(`[mcp_servers.filesystem]
command = "bunx"
args = ["-y", "server"]`),
    )
  })

  test('a multi-line array is left alone when untouched', () => {
    const base = codex(`allow = [
  "a", # first
  "b",
]
theme = "dark"`)
    const remote = codex(`allow = [
  "a", # first
  "b",
]
theme = "light"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toContain('"a", # first')
    expect(result.content).toContain('theme = "light"')
  })
})

describe('tomlMerge: arrays', () => {
  test('a union array merges both sides', () => {
    const base = codex(`[permissions]
allow = ["a", "b"]`)
    const local = codex(`[permissions]
allow = ["a", "b", "c"]`)
    const remote = codex(`[permissions]
allow = ["a", "b", "d"]`)
    const result = mergeToml(base, local, remote, { unionArrays: ['permissions.allow'] })
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`[permissions]
allow = ["a", "b", "c", "d"]`),
    )
  })

  test('an array not marked append-only conflicts', () => {
    const base = codex(`allow = ["a"]`)
    const local = codex(`allow = ["a", "b"]`)
    const remote = codex(`allow = ["a", "c"]`)
    const result = mergeToml(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.conflicts).toHaveLength(1)
  })
})

describe('tomlMerge: conflicts and fallbacks', () => {
  test('both sides editing the same scalar conflicts and keeps local', () => {
    const base = codex(`model = "a" # portable`)
    const local = codex(`model = "b" # portable`)
    const remote = codex(`model = "c" # portable`)
    const result = mergeToml(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.format).toEqual({ preserved: true, mode: 'verbatim' })
  })

  test('a multi-line value the patcher cannot touch is reported, not rewritten', () => {
    const base = codex(`[permissions]
allow = [
  "a",
  "b",
]`)
    const local = codex(`[permissions]
allow = [
  "a",
  "b",
  "c",
]`)
    const remote = codex(`[permissions]
allow = [
  "a",
  "b",
  "d",
]`)
    const result = mergeToml(base, local, remote, { unionArrays: ['permissions.allow'] })
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.format.preserved).toBe(true)
    expect(result.format.mode).toBe('verbatim')
    expect(result.format.reason).toContain('multi-line')
  })

  test('re-serialization is opt-in and reported', () => {
    const base = codex(`allow = [
  "a",
]`)
    const local = codex(`allow = [
  "a",
  "b",
]`)
    const remote = codex(`allow = [
  "a",
  "c",
]`)
    const result = mergeToml(base, local, remote, {
      unionArrays: ['allow'],
      allowReserialize: true,
    })
    expect(result.status).toBe('conflicted')
    expect(result.format.mode).toBe('reserialized')
    expect(result.format.preserved).toBe(false)
    expect(result.content).toContain('"b"')
    expect(result.content).toContain('"c"')
  })

  test('invalid TOML refuses the merge instead of rewriting', () => {
    const local = 'model = "a"\n[broken\n'
    const result = mergeToml('model = "a"\n', local, 'model = "b"\n')
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
    expect(result.format.reason).toContain('invalid TOML')
  })

  test('a new table with a quoted key keeps the quoted form', () => {
    const base = codex(`model = "a"`)
    const remote = codex(`model = "a"

[projects."/Users/me/code"]
trust_level = "trusted"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`model = "a"

[projects."/Users/me/code"]
trust_level = "trusted"`),
    )
  })
})

describe('tomlMerge: arrays of tables', () => {
  test('an element edit lands in the right section', () => {
    const base = codex(`[[mcp]]
name = "one"
command = "npx"

[[mcp]]
name = "two"
command = "npx"`)
    const remote = codex(`[[mcp]]
name = "one"
command = "bunx"

[[mcp]]
name = "two"
command = "npx"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`[[mcp]]
name = "one"
command = "bunx"

[[mcp]]
name = "two"
command = "npx"`),
    )
  })

  test('a remote array of tables is copied verbatim', () => {
    const base = codex(`model = "a"`)
    const remote = codex(`model = "a"

# local tools
[[mcp]]
name = "one"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`model = "a"

# local tools
[[mcp]]
name = "one"`),
    )
  })

  test('different element counts conflict', () => {
    const base = codex(`[[mcp]]
name = "one"`)
    const local = codex(`[[mcp]]
name = "one"

[[mcp]]
name = "two"`)
    const remote = codex(`[[mcp]]
name = "renamed"`)
    const result = mergeToml(base, local, remote)
    expect(result.status).toBe('conflicted')
    expect(result.content).toBe(local)
  })
})

describe('tomlMerge: inline tables and section deletion', () => {
  test('an inline table key change replaces the inline value', () => {
    const base = codex(`[mcp]
env = { FOO = "bar", BAZ = 1 }`)
    const remote = codex(`[mcp]
env = { FOO = "qux", BAZ = 1 }`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(
      codex(`[mcp]
env = { FOO = "qux", BAZ = 1 }`),
    )
  })

  test('a removed table takes its header and comment with it', () => {
    const base = codex(`model = "a"

# tui prefs
[tui]
theme = "dark"`)
    const remote = codex(`model = "a"`)
    const result = mergeToml(base, base, remote)
    expect(result.status).toBe('clean')
    expect(result.content).toBe(codex(`model = "a"`))
  })
})

describe('tomlMerge: symmetry', () => {
  test('clean merges are byte-identical in both orders', () => {
    const base = codex(`# config
model = "gpt-5"

[tui]
theme = "dark"
[features]
web_search = false`)
    const local = codex(`# config
model = "gpt-5"

[tui]
theme = "dark"
notifications = true
[features]
web_search = false`)
    const remote = codex(`# config
model = "o3"

[tui]
theme = "light"
[features]
web_search = true`)
    const forward = mergeToml(base, local, remote)
    const backward = mergeToml(base, remote, local)
    expect(forward.status).toBe('clean')
    expect(backward.status).toBe('clean')
    expect(forward.content).toBe(backward.content)
  })
})
