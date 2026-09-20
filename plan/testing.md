# Testing strategy

Back-link: [overview](overview.md)

## Layers

| Layer | Scope | Tooling | Runs |
|---|---|---|---|
| Unit | Pure functions: transforms, markers, merge, scanner, crypto, path resolution | `bun test` | Every commit, CI |
| Adapter | One harness against a synthetic HOME built from fixtures, including link topologies | `bun test` + `helpers/fake-home.ts` | Every commit, CI |
| Engine | Scan-merge-apply loop against a `FileRemote`, two fake HOMEs, crash injection | `bun test` + `scripts/two-home-e2e.ts` | Every commit, CI |
| Server | Hono app, Drizzle against a throwaway Postgres, storage interface with a filesystem backend | `bun test` | Every commit, CI |
| End-to-end | CLI + client + real server + bucket + two fake HOMEs | `scripts/e2e-server.ts` | Milestones M2, M3, M4 |
| Manual | Real harnesses on a real machine, read-only scan first, then a scoped real sync | checklist below | Before each milestone closes |

## Fixtures

Real harness directories contain personal content, so fixtures are synthetic and derived, never committed raw.

- `scripts/capture-fixtures.ts` walks a real harness directory read-only, writes a redacted structural report (paths, sizes, link topology, file kinds) plus sanitized file bodies into `packages/core/test/fixtures/<harness>/<version>/`.
- A redaction pass replaces values of any key matching the secret patterns, any absolute home path with `$HOME`, and any account identifiers with placeholders.
- The capture script is a committed lever: rerun it when a harness updates, and its output diff shows what the adapter needs to change.
- Fixture HOMEs are assembled by `helpers/fake-home.ts`, which can create plain directories, symlinked trees, and Windows-style copy layouts to exercise the materialization map.

## Invariants (property-style tests)

1. Nothing outside declared surfaces is ever written or read. The applier refuses paths not in the plan.
2. No denylisted path is ever uploaded, even if its surface is enabled.
3. The secret scanner blocks any fixture from the secret corpus, and the block is fail-closed.
4. A second sync run with no edits produces no commits and no writes (idempotence).
5. Two HOMEs converge to identical plaintext content regardless of sync order.
6. Marker blocks round-trip: stripped on upload, re-inserted at their markers on apply, never dropped when a remote edit deletes the anchor.
7. Conflict copies are created on true conflicts and are excluded from the next sync.
8. Symlink topology is preserved on apply; a link is never replaced by a directory.
9. Every uploaded blob is ciphertext: raw bucket bytes never match plaintext markers, and a decrypt with a wrong key fails authentication.
10. A crashed apply followed by a rerun converges to the same state (crash injection at every write step).

## Manual smoke checklist

Run before each milestone closes, on this machine, against a scratch HOME pair.

- `laurencio surfaces --json` on the real machine lists every path from the DESIGN tables with the right policy, and flags nothing as `unknown`.
- `laurencio enroll` enrolls, prints the KDF parameters and passphrase warning, caches the key in the keychain, and a re-run is a no-op.
- `laurencio diff <surface>` shows real edits made in a harness config directory.
- Kill the daemon mid-apply, restart, confirm convergence and no duplicate conflict copies.
- Real Claude Code, Codex, and OpenCode sessions still start and read their config after a sync, with no lock or permission regressions.
- `laurencio devices` revoke kills the revoked device's next sync with a clear error.
- `laurencio doctor` reports link topology, detected harness versions, and the never-sync inventory.
