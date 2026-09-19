# Phase 7: Merge engine

Back-link: [overview](overview.md)

## Goal

Deterministic, format-aware merging that never silently loses an edit and preserves user formatting in JSONC and TOML.

## Changes

- `packages/core/src/merge/text3way.ts`: diff3 over line sequences. Evaluate `node-diff3` (MIT) first; if its conflict semantics do not match our needs, implement diff3 on top of a small Myers diff with property tests. Handles marker blocks by merging projections and re-inserting local blocks after.
- `packages/core/src/merge/jsonMerge.ts`: JSONC merge using `jsonc-parser` edits so comments, key order, and formatting survive scalar conflicts. Rules: unknown keys from both sides survive; scalars conflict when both changed; arrays merge by union for known append-only keys (permissions allowlists) and conflict otherwise.
- `packages/core/src/merge/tomlMerge.ts`: parse with a TOML library, merge table-aware, and write back with a line-oriented patcher that preserves comments and formatting for changed keys. Full re-serialization is a documented fallback, not the default.
- `packages/core/src/merge/conflict.ts`: conflict copies named `<file>.conflict-<device>-<timestamp>`, recorded so the scanner excludes them from future manifests.
- `packages/core/src/merge/index.ts`: dispatch on `MergeStrategy` from the surface declaration, returning `MergeResult`.
- Tests: table-driven cases per format, including both-sides-edit-same-line, adjacent edits, deletion on one side, marker block next to an edit, comment preservation, and unknown-key preservation.

## Data structures

- `MergeResult` = `{ status: 'clean' | 'conflicted', content, conflicts: ConflictRegion[] }`.
- `ConflictRegion` = `{ baseRange, localRange, remoteRange }`.
- `ConflictArtifact` = `{ path, content, device, timestamp }`.

## Verification

Static: the full merge table test suite, plus a fuzz pass that asserts merge symmetry properties where valid (clean merge in both orders yields identical content).

Runtime: `bun run merge:demo` takes two generated variants of a real-shaped `settings.json` and `config.toml` (with comments, unknown keys, and a conflicting scalar), merges them, and prints a unified diff plus the preserved formatting. Read the output; formatting loss is a failure.

## Notes

Formatting preservation is the top risk in this phase. Comments disappearing from a user's config will read as data loss even when the content merged correctly. If the TOML patcher cannot preserve formatting for a case, fall back to a conflict copy rather than a canonical rewrite.
