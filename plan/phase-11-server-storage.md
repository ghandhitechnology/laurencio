# Phase 11: Server storage

Back-link: [overview](overview.md)

## Goal

Blob upload and download through presigned URLs, idempotent revision commits, quotas, and orphan cleanup. The server still never parses config.

## Changes

- `packages/server/src/storage/types.ts` plus two implementations: `s3.ts` for the Railway bucket (presigned PUT and GET, short TTL, opaque content type, size limits) and `fs.ts` for tests.
- Key scheme `u/<storeId>/b/<blobId>`; the server never generates a name from user content, only from the client-supplied ciphertext hash it verifies on commit.
- `packages/server/src/routes/blob.ts`: `POST /v1/stores/:id/blobs/presign` (returns upload URL plus expiry, validates declared size against quota) and `GET /v1/stores/:id/blobs/:blobId` (returns a presigned download URL; ownership checked).
- `packages/server/src/routes/commits.ts`:
  - `POST /v1/stores/:id/commits` taking `CommitRequest` from the protocol package. Idempotent by client-generated revision id: a repeat returns the stored result with no side effects. Validates parents exist, all referenced blobs exist in the store, and declared sizes match.
  - `GET /v1/stores/:id/commits?since=<revision>&limit=` returning `RevisionSummary[]` with manifest blob reference.
- `packages/server/src/quota.ts`: per-store byte and object limits, enforced at presign and commit; typed errors the client can surface.
- `packages/server/src/rate.ts`: per-device token bucket on write endpoints.
- `packages/server/src/gc.ts`: orphan sweep. Blobs not referenced by any committed revision and older than a grace period are deleted; a `--dry-run` mode reports what would go. Runs as a scheduled Railway job at low frequency.
- Tests: idempotent commit under retry, quota rejection, cross-store blob access denied, orphan GC removes only unreferenced blobs, presign expiry behavior.

## Data structures

- `BlobRecord` = `{ id, storeId, size, createdAt, refCount }`.
- `RevisionRecord` = `{ id, storeId, deviceId, parents, manifestBlobId, manifestSize, createdAt }`, plus a fan-out row per referenced blob.
- `GcReport` = `{ scanned, deleted, bytesFreed, kept }`.

## Verification

Static: integration tests against Postgres plus the filesystem storage backend.

Runtime: against the dev deployment, two curl clients (each with its own device token) push and pull a revision: client A commits a manifest blob plus one content blob, client B lists commits, fetches the presigned URL, downloads, and verifies the ciphertext hash matches. Then confirm quota behavior by pushing beyond the test limit and reading the typed error. Run the GC in `--dry-run` and confirm it reports zero deletions when everything is referenced, then delete a revision row in dev and confirm the blob becomes collectable.

## Notes

Idempotency is the contract of this phase (the **make-operations-idempotent** principle): retries and duplicate requests are normal, and a duplicate commit must be a no-op returning the same `RevisionSummary`. The verifier runs **interrogate** on the commit protocol before this phase ships.
