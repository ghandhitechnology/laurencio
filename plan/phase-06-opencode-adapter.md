# Phase 6: OpenCode adapter

Back-link: [overview](overview.md)

## Goal

The OpenCode surface map across v1 and v2 schemas, with symlink preservation, shared skill sources, and the three secret stores excluded.

## Changes

- `packages/core/src/adapters/opencode/surfaces.ts`: global and shared surfaces from DESIGN section 2. Project surfaces (`.opencode/`, repo `opencode.json`) are declared as `never` with a reason string so diagnostics can point users at repo git.
- `packages/core/src/adapters/opencode/detect.ts`: detect v1 and v2 presence (`opencode` and `opencode2` binaries, `cli.json` versus `tui.json`, config key shapes). Report which schema owns each file.
- `packages/core/src/adapters/opencode/transforms.ts`:
  - `opencodeSchemaNormalize`: on upload, write keys both versions read (`plugin` plus `plugins` when ambiguous, profile-scoped arrays); on apply, leave unknown keys untouched and log keys that only one version reads.
  - `opencodePathRewrite`: tokenize absolute sound paths and local plugin paths, keeping the documented relative-resolution rules (plugin paths relative to the config file, skills paths expanded from `~`).
  - `opencodeSkillOwnership`: claim `~/.claude/skills` and `~/.agents/skills` as references, never as second owners.
- Fixtures: both v1 and v2 config samples plus a symlinked global tree matching this machine's `~/.agents-opencode` layout.
- Tests: upload projections never contain `service.json`, `auth.json`, `mcp-auth.json`, `opencode.db`, `node_modules`, state, or cache paths; symlinked `AGENTS.md`, `agents/`, `skills/` are preserved as links on apply.

## Data structures

- `OpenCodeSchema` = `{ version: 1 | 2, keys: Record<string, 'v1' | 'v2' | 'both'> }`.
- Reuses `OwnershipRef` for shared skill trees.

## Verification

Static: adapter tests for both schema versions, a node_modules exclusion test, and a link-preservation test.

Runtime: `bun run scan:demo -- --harness opencode --json` on the real machine. Confirm it reports `~/.config/opencode/AGENTS.md` as a symlink into `~/.agents-opencode`, classifies `service.json` and everything under `~/.local/share/opencode` as `never`, and that a dry-run upload projection of `opencode.jsonc` is valid JSONC that both `opencode` and `opencode2` can parse (`opencode2 debug config` if available).

## Notes

The machine runs both versions against one config dir. Schema normalization is not cosmetic; a naive write can silently drop keys for one version. When in doubt, preserve all keys and warn.
