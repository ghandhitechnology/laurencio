import { buildFakeHome, type FakeHome } from './fake-home'

export const CODEX_CONFIG_TOML = `model = "gpt-5.6-codex"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
notify = ["/Users/laurencio/bin/notify", "turn-ended"]
profile = "fast"

[profiles.fast]
model = "gpt-5.6-codex-mini"
approval_policy = "never"

[features]
hooks = true

[history]
persistence = "save-all"

[skills.config]
include_instructions = true

[plugins."chrome@openai-bundled"]
enabled = true
last_updated = "2026-09-13T00:56:51Z"

[mcp_servers.docs]
command = "npx"
args = ["-y", "docs-server"]

[mcp_servers.docs.env]
DOCS_ENDPOINT = "http://127.0.0.1:4318"

[tui]
theme = "dark"

[hooks]
pre_tool_use = [{ command = "/Users/laurencio/bin/check.sh" }]

[hooks.state."/Users/laurencio/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:1111111111111111111111111111111111111111111111111111111111111111"

[marketplaces.bundled]
last_updated = "2026-09-13T00:56:51Z"
source_type = "local"
source = "/Users/laurencio/.codex/.tmp/bundled-marketplaces/bundled"

[projects."/Users/laurencio/projects/app"]
trust_level = "trusted"

[shell_environment_policy]
inherit = "core"

[shell_environment_policy.set]
PATH_EXTRA = "/Users/laurencio/tools/bin"

[future_thing]
nested = { value = true }
`

export const CODEX_PROFILE_TOML = `model = "gpt-5.6-codex-mini"
approval_policy = "never"
`

export const CODEX_AUTOMATION_TOML = `version = 1
id = "nightly-docs"
kind = "cron"
name = "Nightly docs"
prompt = "Update READMEs."
status = "ACTIVE"
rrule = "RRULE:FREQ=DAILY"
model = "gpt-5.6-codex"
reasoning_effort = "medium"
execution_environment = "local"
target = { type = "projectless" }
cwds = ["/Users/laurencio/projects/app"]
created_at = 1785345678652
updated_at = 1785345920266
last_run_at = 1785346000000
`

export const CODEX_RULES = `prefix_rule(pattern=["node", "/Users/laurencio/.codex/skills/.system/x/run.mjs"], decision="allow")
prefix_rule(pattern=["git", "pull"], decision="allow")
prefix_rule(pattern=["sh", "/bin/sh"], decision="allow")
`

export const CODEX_HOOKS_JSON = `{
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "bash '/Users/laurencio/.codex/herdr-agent-state.sh' session" }] }
    ]
  }
}
`

export interface CodexFixtureOptions {
  /** Materialize `~/.codex/skills` as a symlink to `~/.agents/skills`. */
  skillsLink?: boolean
}

/** A sanitized HOME with every Codex surface family the adapter knows about. */
export function buildCodexHome(options: CodexFixtureOptions = {}): FakeHome {
  return buildFakeHome({
    entries: [
      { kind: 'file', path: '.codex/config.toml', content: CODEX_CONFIG_TOML },
      { kind: 'file', path: '.codex/.config.toml', content: 'model = "gpt-5.6-codex-mini"\n' },
      { kind: 'file', path: '.codex/work.config.toml', content: CODEX_PROFILE_TOML },
      { kind: 'file', path: '.codex/AGENTS.md', content: '# global instructions\n' },
      { kind: 'file', path: '.codex/AGENTS.override.md', content: '# override\n' },
      { kind: 'file', path: '.codex/hooks.json', content: CODEX_HOOKS_JSON },
      { kind: 'file', path: '.codex/rules/default.rules', content: CODEX_RULES },
      { kind: 'dir', path: '.agents/skills/shared' },
      { kind: 'file', path: '.agents/skills/shared/SKILL.md', content: '# shared skill\n' },
      options.skillsLink === true
        ? { kind: 'dir', path: '.codex/skills', link: '$HOME/.agents/skills' }
        : { kind: 'dir', path: '.codex/skills/local' },
      ...(options.skillsLink === true
        ? []
        : [
            {
              kind: 'file' as const,
              path: '.codex/skills/local/SKILL.md',
              content: '# local skill\n',
            },
          ]),
      {
        kind: 'file',
        path: '.codex/automations/daily/automation.toml',
        content: CODEX_AUTOMATION_TOML,
      },
      {
        kind: 'file',
        path: '.codex/automations/daily/memory.md',
        content: '# automation memory\n',
      },
      { kind: 'file', path: '.codex/auth.json', content: '{"tokens":"never-read"}\n' },
      { kind: 'file', path: '.codex/.codex-global-state.json', content: '{}\n' },
      { kind: 'file', path: '.codex/history.jsonl', content: '{"prompt":"hi"}\n' },
      { kind: 'file', path: '.codex/session_index.jsonl', content: '{}\n' },
      { kind: 'file', path: '.codex/sessions/2026/rollout.jsonl', content: '{}\n' },
      { kind: 'file', path: '.codex/archived_sessions/old.jsonl', content: '{}\n' },
      { kind: 'file', path: '.codex/plugins/cache/blob', content: 'plugin cache\n' },
      { kind: 'file', path: '.codex/cache/blob', content: 'cache\n' },
      { kind: 'file', path: '.codex/log/codex.log', content: 'log\n' },
      { kind: 'file', path: '.codex/tmp/scratch', content: 'scratch\n' },
      { kind: 'file', path: '.codex/sqlite/aux', content: 'aux\n' },
      { kind: 'file', path: '.codex/state_5.sqlite', content: 'state\n' },
      { kind: 'file', path: '.codex/logs_2.sqlite-wal', content: 'wal\n' },
      { kind: 'file', path: '.codex/memories_1.sqlite', content: 'memory\n' },
      { kind: 'file', path: '.codex/.tmp/plugin/blob', content: 'bundled plugin\n' },
      { kind: 'file', path: '.codex/computer-use/blob', content: 'app bundle\n' },
    ],
  })
}
