# Phase 12: Client sync

Back-link: [overview](overview.md)

## Goal

The live sync loop against the real server: authenticated, encrypted, retrying, offline-tolerant, and safe around harness writers.

## Changes

- `packages/core/src/remote/http.ts`: `Remote` implementation over fetch. Device token auth, presigned upload and download, `Retry-After` and backoff with jitter, typed errors mapped from the protocol error shape, and `protocolVersion` negotiation with a clear upgrade path.
- `packages/core/src/sync/loop.ts`: pull, compute plan, apply, push, record. Reuses the phase 9 engine unchanged; the loop only supplies the remote and the policy.
- `packages/core/src/sync/queue.ts`: offline queue persisted in `state.db` (`pending_ops`), drained in order on reconnect, with idempotent replay since commits are content addressed.
- `packages/core/src/sync/credentials.ts`: device token and derived key retrieval from the OS keychain; token refresh; explicit `laurencio login` state machine for the device flow.
- `packages/core/src/sync/policy.ts`: device-local policy loading (per-harness and per-surface toggles, ignore lists, cadence), stored in `~/.laurencio/config.toml`, never synced.
- Integration with quiescence and the CAS retry from phase 9 in the live path.
- `scripts/e2e-server.ts`: the end-to-end harness. Two fake HOMEs plus the deployed dev server; asserts convergence, offline queue replay, revoked-device failure, wrong-passphrase failure, protocol mismatch messaging, and ciphertext-only storage by scanning raw bucket bytes for plaintext markers and decrypting with a wrong key.
- Tests: transport unit tests with a mock server, queue replay tests, and the harness above.

## Data structures

- Reuses `SyncPlan`, `SyncReport`, `Remote`, `PendingOp`.
- `SyncCredentials` = `{ deviceId, token (keychain), keyMaterial (keychain) }`.
- `DevicePolicy` gains `cadence: { watch: boolean, intervalSeconds: number }`.

## Verification

Static: unit and integration tests.

Runtime: run `bun run e2e:server` against the dev deployment and read the full transcript. Then the manual pass from [testing.md](testing.md): enroll this machine as a real device, sync a scratch HOME pair against the dev server, edit files on both sides, and confirm merge, conflict copy, and marker behavior end to end. Inspect the bucket directly (or via presigned URLs and `openssl`) to confirm no plaintext config bytes exist.

## Notes

The loop is the integration point for every earlier phase; when something fails, suspect the observation method before the merge logic (the **prove-it-works** principle) and reproduce with `e2e:two-home` first to isolate server versus engine faults.
