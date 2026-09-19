# Phase 3: Adapter framework

Back-link: [overview](overview.md)

## Goal

A declarative adapter API plus the scanner that turns a machine's real directories into a manifest, with single ownership of every physical path and deterministic marker parsing.

## Changes

- `packages/core/src/adapters/types.ts`: `HarnessAdapter` interface. Adapters declare: `id`, `displayName`, `detect(ctx)` returning detected versions and config roots, `surfaces(ctx)` returning `Surface[]`, and nothing else. No I/O in adapters.
- `packages/core/src/adapters/registry.ts`: registry with duplicate-id and duplicate-path detection at startup.
- `packages/core/src/paths.ts`: path templates with tokens (`$HOME`, `${XDG_CONFIG_HOME}`, `${CODEX_HOME}`, `${CLAUDE_CONFIG_DIR}`, `%APPDATA%`), `expand(template, env)` and `tokenize(absPath, env)`, plus the rule that storage never contains absolute paths.
- `packages/core/src/ownership.ts`: resolve each surface's physical path (following symlinks), assert one owning surface per resolved path, and produce `OwnershipRef` entries when a harness references another harness's tree.
- `packages/core/src/markers.ts`: parse `<!-- laurencio:local -->` blocks into `MarkerRange[]`, strip blocks for upload projection, and re-insert them after merge. Unclosed or nested markers are a hard error.
- `packages/core/src/scan.ts`: walk surfaces, classify each file, compute plaintext hashes, capture link topology, emit a `Manifest` plus `LocalLayout`. Reads only; writes nothing.
- `packages/core/test/helpers/fake-home.ts`: build a scratch HOME from a fixture recipe, supporting plain trees, symlinked trees, per-OS layouts, and an ignore list.
- `scripts/capture-fixtures.ts`: the fixture lever described in [testing.md](testing.md).
- Tests: tokenization round-trips, ownership collisions fail fast, marker edge cases, scan determinism across two runs.

## Data structures

- `HarnessAdapter` in, `Manifest` + `LocalLayout` out. Both defined in phase 2.
- `OwnershipRef` = `{ surfaceId, resolvedPath, referencedBy: SurfaceId[] }`.
- `MarkerRange` = `{ path, startLine, endLine, hash }`.

## Verification

Static: unit tests for tokens, ownership, markers, and scan determinism; a scan of a synthetic HOME reproduces an expected manifest fixture byte for byte.

Runtime: `bun run scan:demo -- --json` against this machine's real `~/.claude`, `~/.codex`, and `~/.config/opencode` (read-only, no adapter registered yet beyond a demo one) prints the inventory and the link topology. Manually confirm it follows `~/.config/opencode/AGENTS.md` into `~/.agents-opencode` and reports the link, not a dereferenced copy.

## Notes

- The scanner never writes. Any phase that writes goes through the applier in phase 9.
- Marker syntax decision from DESIGN section 5: blocks are stripped on upload, markers stay in the projection as anchors, local content is never silently dropped.
- Keep `expand`/`tokenize` pure functions (the **boundary-discipline** principle); env access happens once at the CLI edge.
