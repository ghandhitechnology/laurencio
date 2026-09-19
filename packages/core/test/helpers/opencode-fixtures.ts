import type { AdapterContext, HarnessProbe } from '../../src/types'
import { buildFakeHome, type FakeEntry, type FakeHome } from './fake-home'

/** Sanitized v1-shaped sample: plural key families, array permissions, nested mcp servers. */
export const OPENCODE_V1_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    "./plugins/local",
    { "package": "./plugins/router", "options": { "threshold": 90 } }
  ],
  "agents": { "reviewer": { "mode": "subagent", "system": "Review the diff." } },
  "commands": { "deploy": { "template": "Deploy now." } },
  "permissions": [{ "action": "shell", "resource": "*", "effect": "ask" }],
  "mcp": {
    "servers": {
      "railway": { "type": "local", "command": ["railway", "mcp"] }
    }
  }
}
`

/** Sanitized v2-shaped sample: singular key families, object permissions, flat mcp, skills array. */
export const OPENCODE_V2_CONFIG = `{
  "$schema": "https://opencode.ai/config.json",
  // Skills and agents live in ~/.agents-opencode.
  "plugin": ["opencode-notify"],
  "agent": { "poteto": { "mode": "primary" } },
  "command": { "review": { "template": "Review the diff." } },
  "permissions": { "edit": "allow" },
  "mcp": { "cua-driver": { "type": "local", "command": ["cua-driver", "mcp"] } },
  "skills": ["~/.agents-opencode/skills"],
  "unknown_future_key": { "keep": true }
}
`

export const OPENCODE_CLI_CONFIG = `{
  "$schema": "https://opencode.ai/v2/cli.json",
  "theme": { "name": "vesper" },
  "attention": { "sounds": { "permission": "~/sounds/permission.wav" } }
}
`

export const OPENCODE_TUI_CONFIG = `{
  "$schema": "https://opencode.ai/tui.json",
  "theme": "vesper"
}
`

/**
 * A machine-shaped OpenCode home: both config schemas, the never roots, and the
 * `~/.agents-opencode` single source that `AGENTS.md`, `agents/`, and `skills/` symlink into.
 */
export function buildOpenCodeHome(): FakeHome {
  const entries: FakeEntry[] = [
    { kind: 'file', path: '.agents-opencode/agents.md', content: '# global rules\n' },
    { kind: 'file', path: '.agents-opencode/agents/poteto.md', content: '# poteto\n' },
    { kind: 'file', path: '.agents-opencode/skills/architect/SKILL.md', content: '# architect\n' },
    { kind: 'file', path: '.config/opencode/opencode.json', content: OPENCODE_V1_CONFIG },
    { kind: 'file', path: '.config/opencode/opencode.jsonc', content: OPENCODE_V2_CONFIG },
    { kind: 'file', path: '.config/opencode/cli.json', content: OPENCODE_CLI_CONFIG, mode: 0o600 },
    { kind: 'file', path: '.config/opencode/tui.json', content: OPENCODE_TUI_CONFIG },
    {
      kind: 'file',
      path: '.config/opencode/service.json',
      content: '{"password":"hunter2"}\n',
      mode: 0o600,
    },
    {
      kind: 'file',
      path: '.config/opencode/package.json',
      content: '{"dependencies":{"@opencode-ai/plugin":"1.17.11"}}\n',
    },
    {
      kind: 'file',
      path: '.config/opencode/package-lock.json',
      content: '{"lockfileVersion":3}\n',
    },
    {
      kind: 'file',
      path: '.config/opencode/plugins/local/index.js',
      content: 'export default {}\n',
    },
    { kind: 'file', path: '.config/opencode/plugins/node_modules/dep/index.js', content: 'x\n' },
    { kind: 'file', path: '.config/opencode/node_modules/dep/index.js', content: 'x\n' },
    { kind: 'file', path: '.config/opencode/tools/mytool.ts', content: 'export default {}\n' },
    { kind: 'file', path: '.config/opencode/commands/deploy.md', content: '# deploy\n' },
    { kind: 'file', path: '.config/opencode/themes/vesper.json', content: '{}\n' },
    {
      kind: 'file',
      path: '.local/share/opencode/auth.json',
      content: '{"token":"secret"}\n',
      mode: 0o600,
    },
    {
      kind: 'file',
      path: '.local/share/opencode/opencode.db',
      content: 'SQLite format 3\n',
      mode: 0o600,
    },
    {
      kind: 'file',
      path: '.local/share/opencode/mcp-auth.json',
      content: '{"oauth":true}\n',
      mode: 0o600,
    },
    { kind: 'file', path: '.local/share/opencode/tool-output/session.txt', content: 'output\n' },
    { kind: 'file', path: '.local/state/opencode/model.json', content: '{"recent":[]}\n' },
    { kind: 'file', path: '.cache/opencode/models.json', content: '{"models":[]}\n' },
    { kind: 'file', path: '.claude/skills/commit/SKILL.md', content: '# commit\n' },
    { kind: 'file', path: '.agents/skills/shared/SKILL.md', content: '# shared\n' },
    { kind: 'file', path: '.config/opencode/AGENTS.md', link: '$HOME/.agents-opencode/agents.md' },
    { kind: 'file', path: '.config/opencode/agents', link: '$HOME/.agents-opencode/agents' },
    { kind: 'file', path: '.config/opencode/skills', link: '$HOME/.agents-opencode/skills' },
  ]
  return buildFakeHome({ entries })
}

export const OPENCODE_PROBE: HarnessProbe = {
  installed: true,
  version: '1.18.23',
  notes: [
    'opencode 1.18.23',
    'opencode2 0.0.0-beta-19059',
    'config:cli.json',
    'config:opencode.jsonc',
  ],
}

export function withOpenCodeProbe(ctx: AdapterContext): AdapterContext {
  return { ...ctx, probes: { opencode: OPENCODE_PROBE } }
}
