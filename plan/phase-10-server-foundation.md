# Phase 10: Server foundation

Back-link: [overview](overview.md)

## Goal

A deployed service that authenticates a human in a browser, enrolls devices, and stores per-store KDF parameters. No content yet.

## Changes

- `packages/server/src/index.ts`: Hono app, request ids, structured logs, error shape from `packages/protocol`, `protocolVersion` middleware rejecting mismatches with an upgrade message.
- `packages/server/src/auth.ts`: Better Auth with the device authorization plugin and email sign-in for invited staging accounts. Session for the web approval page; device tokens for the CLI, one per device, revocable.
- `packages/server/src/db/schema.ts`: Drizzle tables `users`, sessions and accounts (owned by Better Auth), `devices` (name, platform, createdAt, lastSeenAt, revokedAt), `device_tokens`, `kdf_params` (store id, salt, params, setAt, immutable after first write), `audit_log`.
- `packages/server/src/routes/{health,me,devices,kdf}.ts`: `/health`, `/v1/me`, `GET/POST/DELETE /v1/devices`, `GET/PUT /v1/stores/:id/kdf-params`.
- `packages/server/src/web/`: a minimal approval page at `/device` (enter or confirm the user code) and a device management page at `/account/devices` (list, rename, revoke). Server-rendered, no client framework.
- `drizzle.config.ts`, `railway.toml`, `docs/deploy.md`, `.env.example`.
- Tests: route tests against a throwaway Postgres, device-flow happy path and expiry, revoke semantics (revoked token fails immediately), KDF params immutability.

## Data structures

- `DeviceRecord` = `{ id, name, platform, createdAt, lastSeenAt, revokedAt? }`.
- `KdfParams` from phase 2, stored per store, immutable after first write.
- `audit_log` row = `{ actorUserId, deviceId?, action, subject, at, meta }`.

## Verification

Static: typecheck, route tests.

Runtime, using the **use-railway** skill: deploy to a Railway project with Postgres, run migrations, then from a terminal walk the device flow end to end (`bun run auth:demo` performs the device authorization request, prints the code, polls, and exchanges for a token). Confirm in the browser page that a device appears, rename it, revoke it, and verify the revoked token gets a 401 on the next call. Confirm `/health` reports database connectivity and that logs include request ids.

## Notes

Keep the server blind to content by construction: at this phase it has no concept of file paths, only stores, devices, and blobs. KDF parameters are public values; the salt must be random per store and never derived from the passphrase.
