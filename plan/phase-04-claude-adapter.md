# Phase 4: Claude adapter

Back-link: [overview](overview.md)

## Goal

The complete Claude Code surface map as data: every known path classified, transforms declared, opt-ins wired, and the `~/.claude.json` MCP extraction implemented as a pure transform.

## Changes

- `packages/core/src/adapters/claude/surfaces.ts`: the DESIGN section 2 table as declarations, including `never` entries so the scanner can prove it classified everything it saw.
- `packages/core/src/adapters/claude/detect.ts`: version detection from `claude --version` when available, falling back to directory shape; config root from `CLAUDE_CONFIG_DIR`.
- `packages/core/src/adapters/claude/transforms.ts`:
  - `claudeMcpExtract`: read user-scope `mcpServers` from `~/.claude.json` into a dedicated synced surface, strip `env` values to indirection, never touch the rest of that file.
  - `claudeSlugRekey`: map `projects/<slug>/memory/` to a repo-keyed identity (git remote plus repo-relative path) on upload, and write back to the local slug on apply. Falls back to a stable hash when there is no remote.
  - `claudePluginRecords`: strip `installLocation` and timestamps from plugin install records.
  - `claudePathRewrite`: tokenize absolute paths in hooks and statusLine.
- Fixtures: sanitized capture of this machine's `~/.claude` structure plus hand-built cases for memory slugs and plugin records.
- Tests: policy table coverage (every fixture path classified), transform round-trips, and the never-sync list asserted against `.credentials.json`, transcripts, `settings.local.json`, and `plugins/cache`.

## Data structures

- Reuses `Surface`; adds no new core types.
- `MemoryIdentity` = `{ repoRemote?, repoRelativePath, fallbackHash }`, the stable key for memory surfaces.

## Verification

Static: adapter tests over fixtures, including a synthetic HOME where `~/.claude/skills` is a symlink, asserting the link is preserved and not dereferenced.

Runtime: `bun run scan:demo -- --harness claude --json` on the real machine. Manually check that `.credentials.json`, `projects/*.jsonl`, `history.jsonl`, `settings.local.json`, `stats-cache.json`, and `plugins/cache/` are classified `never`, that `settings.json`, `CLAUDE.md`, `rules/`, `agents/`, `commands/`, `skills/`, `keybindings.json`, and `hooks/` are `sync`, and that memory appears only with the opt-in flag.

## Notes

Do not sync `~/.claude.json` as a file under any circumstance (DESIGN section 2). The extraction transform exists precisely because that file mixes identity, machine state, and one thing we want.
