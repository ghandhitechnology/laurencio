# Phase 5: Codex adapter

Back-link: [overview](overview.md)

## Goal

The Codex CLI surface map with a key-level `config.toml` split, skill and rule surfaces, and explicit "unsupported" reporting for SQLite memory.

## Changes

- `packages/core/src/adapters/codex/surfaces.ts`: DESIGN section 2 table as declarations, keyed off `CODEX_HOME` (default `~/.codex`).
- `packages/core/src/adapters/codex/detect.ts`: version from `codex --version`; detect `auth.json` versus keyring credential storage and report the mode in diagnostics without reading values.
- `packages/core/src/adapters/codex/transforms.ts`:
  - `codexTomlSplit`: partition parsed `config.toml` into portable keys and machine keys. Portable: model, provider prefs, approval and sandbox defaults, `mcp_servers`, tui, features, history, `skills.config`, `plugins.*.enabled`. Machine: `[projects.*]` trust, `[hooks.state.*]` hashes, `[marketplaces.*].source`, `shell_environment_policy.set`.
  - `codexPathRewrite`: tokenize absolute paths inside `rules/default.rules` and hooks.
  - `codexAutomationSplit`: sync `automations/<name>/` definitions, keep per-machine cwds and run history in the device override.
- Skill sources: `~/.codex/skills` and `~/.agents/skills` claimed with `ownership` refs where they overlap OpenCode.
- Tests: the split must be total (every key classified or explicitly ignored), a round-trip must not drop unknown keys, and machine keys must never appear in an uploaded manifest.

## Data structures

- `CodexConfigSplit` = `{ portable: TomlTable, machine: TomlTable, ignored: string[] }`.

## Verification

Static: adapter tests over sanitized fixtures, including a config with trust entries, hook hashes, marketplace sources, and profiles, asserting no machine key leaks into the portable projection.

Runtime: `bun run scan:demo -- --harness codex --json`. Manually confirm `auth.json`, `sessions/`, `history.jsonl`, `*_*.sqlite`, `.codex-global-state.json`, and caches are `never`, and that `config.toml`, profile files, `AGENTS.md`, `skills/`, and `rules/default.rules` are handled. Attempt `--memory` and confirm the CLI reports Codex memory as unsupported with the reason (opaque SQLite store), not a silent skip.

## Notes

`config.toml` is the highest-risk file in the whole product: it interleaves portable prefs with absolute-path trust state, and Codex rewrites it on approval. The split must survive concurrent writes (re-read, re-split, merge) rather than caching a parse.
