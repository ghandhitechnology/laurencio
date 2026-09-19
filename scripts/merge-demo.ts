/**
 * Merge demo: two generated variants of a real-shaped settings.json and
 * config.toml, merged with the same API the engine uses. Prints a unified diff
 * and an explicit formatting verdict per file.
 *
 * Run: bun run merge:demo
 */
import { conflictCopyPath, merge } from '../packages/core/src/merge'
import { unifiedDiff } from '../packages/core/src/merge/text3way'

const DEVICE = 'mac-mini'
const NOW = '2026-09-19T16:39:12.000Z'

interface DemoFile {
  label: string
  strategy: 'jsonKeyMerge' | 'tomlKeyMerge'
  unionArrays: string[]
  base: string
  local: string
  remote: string
  /** Text that must survive the merge for the verdict to read "preserved". */
  mustContain: string[]
  /** Local text that must survive at a conflicting key. */
  conflictKeepsLocal: string[]
}

const settingsBase = `{
  // Model used for interactive sessions.
  "model": "claude-opus-4-1",
  "permissions": {
    "allow": [
      "Bash(ls:*)", // safe read-only listing
      "Read",
      "Glob"
    ],
    "deny": ["Bash(rm -rf:*)"]
  },
  "statusLine": { "type": "command", "command": "$HOME/.claude/statusline.sh" },
  "enabledPlugins": { "code-review@local": true },
  "unknownLocalFlag": false
}
`

const settingsLocal = `{
  // Model used for interactive sessions.
  "model": "claude-sonnet-4-5",
  "permissions": {
    "allow": [
      "Bash(ls:*)", // safe read-only listing
      "Read",
      "Glob",
      "Write"
    ],
    "deny": ["Bash(rm -rf:*)"]
  },
  "statusLine": { "type": "command", "command": "$HOME/.claude/statusline.sh" },
  "enabledPlugins": { "code-review@local": true },
  "unknownLocalFlag": false,
  "deviceNote": "laptop keyboard layout"
}
`

const settingsRemote = `{
  // Model used for interactive sessions.
  "model": "claude-opus-4-1",
  "permissions": {
    "allow": [
      "Bash(ls:*)", // safe read-only listing
      "Read",
      "Glob",
      "Bash(git status:*)"
    ],
    "deny": ["Bash(rm -rf:*)"]
  },
  "statusLine": { "type": "command", "command": "$HOME/.claude/statusline.sh" },
  "enabledPlugins": { "code-review@local": true },
  "unknownLocalFlag": true,
  "remoteTheme": "dark"
}
`

const configBase = `# Codex CLI configuration, portable keys only.
model = "gpt-5-codex"          # primary coding model
approval_policy = "on-request" # ask before writes
sandbox_mode = "workspace-write"

[features]
web_search = false

[tui]
theme = "dark" # keep the terminal readable
`

const configLocal = `# Codex CLI configuration, portable keys only.
model = "gpt-5"                # primary coding model
approval_policy = "on-request" # ask before writes
sandbox_mode = "workspace-write"

[features]
web_search = false

[tui]
theme = "dark" # keep the terminal readable
notifications = true
`

const configRemote = `# Codex CLI configuration, portable keys only.
model = "o3"                   # primary coding model
approval_policy = "never"      # ask before writes
sandbox_mode = "workspace-write"

[features]
web_search = true

[tui]
theme = "dark" # keep the terminal readable
`

const files: DemoFile[] = [
  {
    label: 'settings.json',
    strategy: 'jsonKeyMerge',
    unionArrays: ['permissions.allow'],
    base: settingsBase,
    local: settingsLocal,
    remote: settingsRemote,
    mustContain: [
      '// Model used for interactive sessions.',
      '// safe read-only listing',
      '"deviceNote"',
      '"remoteTheme"',
      '"Bash(git status:*)"',
    ],
    conflictKeepsLocal: [],
  },
  {
    label: 'config.toml',
    strategy: 'tomlKeyMerge',
    unionArrays: [],
    base: configBase,
    local: configLocal,
    remote: configRemote,
    mustContain: [
      '# Codex CLI configuration, portable keys only.',
      '# keep the terminal readable',
      'notifications = true',
      'approval_policy = "never"',
    ],
    conflictKeepsLocal: ['model = "gpt-5"'],
  },
]

let failed = false

for (const file of files) {
  const result = merge(
    { strategy: file.strategy, base: file.base, local: file.local, remote: file.remote },
    { unionArrays: file.unionArrays },
  )
  const preserved = file.mustContain.every((needle) => result.content.includes(needle))
  const keptLocal = file.conflictKeepsLocal.every((needle) => result.content.includes(needle))

  console.log(`\n=== ${file.label}`)
  console.log(`strategy: ${file.strategy}`)
  console.log(`status:   ${result.status}`)
  console.log(`conflicts: ${result.conflicts.length}`)
  for (const conflict of result.conflicts) {
    console.log(
      `  base lines ${conflict.baseRange[0]}-${conflict.baseRange[1] - 1}, ` +
        `local ${conflict.localRange[0]}-${conflict.localRange[1] - 1}, ` +
        `remote ${conflict.remoteRange[0]}-${conflict.remoteRange[1] - 1}`,
    )
  }
  console.log(
    `format:   ${preserved ? 'preserved' : 'LOST'} ` +
      `(${result.format.mode}${result.format.reason ? `, ${result.format.reason}` : ''})`,
  )
  const diff = unifiedDiff(file.local, result.content, {
    from: `${file.label} (local)`,
    to: `${file.label} (merged)`,
  })
  console.log(diff === '' ? 'diff: none (merged equals local)' : diff.trimEnd())

  console.log('preservation checks:')
  for (const needle of file.mustContain) {
    console.log(`  ${result.content.includes(needle) ? 'ok  ' : 'LOST'} ${needle}`)
  }
  for (const needle of file.conflictKeepsLocal) {
    console.log(
      `  ${result.content.includes(needle) ? 'ok  ' : 'LOST'} local kept at conflict: ${needle}`,
    )
  }
  if (!preserved || !keptLocal) failed = true

  if (result.status === 'conflicted') {
    const copy = conflictCopyPath(file.label, DEVICE, NOW)
    console.log(`conflict copy would be written: ${copy}`)
    console.log('remote side preserved there verbatim for the resolve command')
  }
}

console.log(`\ndevice for conflict copies: ${DEVICE}`)
console.log(
  failed ? '\nRESULT: formatting loss detected' : '\nRESULT: comments and formatting preserved',
)
process.exit(failed ? 1 : 0)
