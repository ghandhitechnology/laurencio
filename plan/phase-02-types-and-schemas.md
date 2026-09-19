# Phase 2: Types and schemas

Back-link: [overview](overview.md)

## Goal

One source of truth for the domain model and the wire protocol, with illegal states unrepresentable and external data parsed at boundaries.

## Changes

- `packages/protocol/src/ids.ts`: branded primitives (`UserId`, `DeviceId`, `StoreId`, `RevisionId`, `BlobId`, `SurfaceId`, `HarnessId`) with constructors that validate once at the boundary.
- `packages/protocol/src/schemas.ts`: zod schemas for wire types (`DeviceRecord`, `KdfParams`, `PresignRequest`, `PresignResponse`, `BlobRef`, `CommitRequest`, `CommitResponse`, `RevisionSummary`, `ErrorResponse`). Export inferred types; never hand-write a parallel interface.
- `packages/protocol/src/version.ts`: `PROTOCOL_VERSION`, compatibility rule, and the error shape the server returns on mismatch.
- `packages/core/src/types.ts`: domain unions. `Surface` as a discriminated union over `kind` (`tree`, `file`, `keyed-file`), `Policy` (`sync`, `never`, `opt-in`), `MergeStrategy` (`text3way`, `jsonKeyMerge`, `tomlKeyMerge`, `binaryNewestWins`, `appendUnion`), `Transform` variants, `SecretRule`.
- `packages/core/src/model.ts`: `Manifest`, `ManifestEntry`, `Revision`, `LocalLayout`, `MarkerRange`, `DevicePolicy`, `SyncPlan`, `MergeResult`.
- Tests: schema round-trips, rejection cases for malformed payloads, and a compile-time exhaustiveness test that fails if a new `Transform` variant is unhandled.

## Data structures

- `Surface` carries all behavior: id, harness, path template, kind, format, policy, merge strategy, transforms, secret rules.
- `Manifest` = revision id + device id + entries `{ path, hash, size, mode }`.
- `Revision` = id, parents, device, createdAt, digests of changed surfaces.
- `LocalLayout` maps resolved path to `{ mode: 'direct' | 'symlink', linkTarget? }`.
- `SyncPlan` = the computed list of reads, merges, writes, uploads, downloads for one run.

## Verification

Static: typecheck and unit tests; the exhaustiveness test must fail when a variant is added without a handler.

Runtime: `bun packages/protocol/examples/parse.ts` parses a sample commit payload from a fixture and prints the typed result, then rejects a tampered payload with a readable error.

## Notes

Parse, don't validate (the **type-system-discipline** and **boundary-discipline** principles): zod only at wire, CLI, and file boundaries; internal code trusts the types. Keep the four core types (`Surface`, `Manifest`, `Revision`, `LocalLayout`) stable; every later phase consumes them.
