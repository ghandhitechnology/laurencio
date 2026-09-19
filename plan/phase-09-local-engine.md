# Phase 9: Local engine

Back-link: [overview](overview.md)

## Goal

A complete sync run that converges two machines without a server, encrypted end to end, crash-safe and idempotent. After this phase the product works offline against a file-based remote.

## Changes

- `packages/core/src/remote/types.ts`: the `Remote` interface (`getKdfParams`, `listRevisions`, `getManifest`, `putBlob`, `getBlob`, `commit`, `listDevices`). The server client in phase 12 and the test double both implement it.
- `packages/core/src/remote/file.ts`: `FileRemote`, a directory that behaves exactly like the server protocol with the same framing and content addressing. This is the test lever that de-risks phase 12.
- `packages/core/src/engine.ts`: one run computes a `SyncPlan` from three manifests (local scan, base revision, remote head), orders operations, and executes. Returns a `SyncReport` for the CLI.
- `packages/core/src/apply.ts`: the only writer in the codebase. Rules: atomic temp-plus-rename, compare-and-swap on mtime and hash before replacing, retry the merge on mismatch, never write outside the plan, never delete a non-empty directory, deletions become tombstones.
- `packages/core/src/materialize.ts`: apply `LocalLayout`. Symlinked targets are written through, links are never replaced; missing links are recreated only when the layout says so; Windows copy mode is a distinct code path.
- `packages/core/src/state.ts`: bun:sqlite database at `~/.laurencio/state.db` with tables `revisions`, `base_manifest`, `layouts`, `markers`, `pending_ops`, `journal`. Startup runs reconciliation: adopt or roll back incomplete applies from the journal, clear stale PID locks.
- `packages/core/src/quiescence.ts`: the deferral rule. A file is quiescent when its mtime is older than the configured window and unchanged across two reads; the engine re-queues otherwise.
- `scripts/two-home-e2e.ts`: the committed harness. Builds two fake HOMEs from fixtures, syncs A, syncs B, asserts convergence; then asserts idempotence (second run makes no writes), marker round-trip, conflict-copy creation and exclusion, secret blocking, symlink preservation, and crash recovery by killing the apply mid-write and rerunning.
- Tests: engine unit tests per operation class plus the scripted harness above.

## Data structures

- `SyncPlan` = ordered `PlanOp[]` where `PlanOp` is `read | merge | write | delete | upload | download | link`.
- `SyncReport` = `{ revisionId, changed, conflicts: ConflictArtifact[], blocked: SecretFinding[], deferred: string[] }`.
- `journal` row = `{ opId, op, targetPath, state: 'intent' | 'applied', tempPath?, startedAt }`.
- Tombstone entries extend `ManifestEntry` with a `kind` field.

## Verification

Static: unit tests plus the scripted harness in CI, on ubuntu and macos.

Runtime: `bun run e2e:two-home` prints a step-by-step transcript; read it and confirm every assertion line. Then a manual pass: build two scratch HOMEs from this machine's sanitized fixtures, edit one `CLAUDE.md` and one `config.toml` on each side, sync, and inspect the merged files and any conflict copies by hand. Kill the process with SIGKILL during the apply step, rerun, confirm convergence with no duplicated artifacts.

## Notes

Crash safety is the point of the journal plus reconciliation (the **make-operations-idempotent** principle): every write is preceded by an intent row, and startup repairs anything left behind. Keep the applier the single writer; the scanner stays read-only. Everything in this phase is testable without network access, which is why it precedes the server.
