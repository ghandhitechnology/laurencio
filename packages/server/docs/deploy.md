# Deploying the Laurencio server

The server is one Railway service plus a Postgres database and a storage
bucket. Blobs are opaque ciphertext; the server never parses config.

## 1. Project and services

1. Create a Railway project and add the Postgres plugin. `DATABASE_URL` is
   injected into services that reference the database.
2. Add a storage bucket. Railway exposes `BUCKET`, `ENDPOINT`, `REGION`,
   `ACCESS_KEY_ID`, and `SECRET_ACCESS_KEY`; the server reads both those names
   and the `S3_*` variants.
3. Create the app service from this repository. Leave the root directory at
   the repository root so the workspace lockfile is present; `railway.toml`
   sets the build, pre-deploy, and start commands.

## Environments

A **staging** environment sets `NODE_ENV=staging`, which binds all interfaces,
allows email sign-in for addresses in `STAGING_EMAIL_ALLOWLIST`, and permits a
single instance to run. Set `ALLOW_DEV_SIGNIN=true` and a comma-separated list of
invited emails. Startup fails if staging email access has no allowlist.
Use it to smoke-test a deployment:

```
bun scripts/smoke-live.ts --base-url https://<service>.up.railway.app
```

A **production** environment sets `NODE_ENV=production` and refuses the
development sign-in path. Production email verification is not implemented yet,
so new browser sign-ins and device enrollments require the staging environment
for this beta. Existing device tokens remain usable in production.

## 2. Variables

Copy `.env.example` into the service variables and set:

| Variable | Value |
|---|---|
| `NODE_ENV` | `staging` for the onboarding beta |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | the public service URL, for example `https://laurencio.up.railway.app` |
| `ALLOW_DEV_SIGNIN` | `true` in staging only |
| `STAGING_EMAIL_ALLOWLIST` | comma-separated invited email addresses |
| `STORAGE_DRIVER` | `s3` (implied when `BUCKET`/`S3_BUCKET` is set) |

`ALLOW_DEV_SIGNIN` must not be set in production; startup fails if it is.
`DATABASE_URL` comes from the Postgres plugin. The filesystem storage driver is
refused in production.

## 3. Email sign-in and device approval

The CLI opens `${BETTER_AUTH_URL}/device?user_code=...`. An existing browser
session continues directly to approval; a signed-out browser enters an email
first and returns to that same code. The approval page shows the account email
so a second computer joins the intended account.

Staging access does not verify email ownership. The allowlist limits test
accounts; anyone who knows an invited email can sign in as that account.
Both the browser form and direct email auth endpoints enforce the allowlist.
Use this only for the private beta, not public account security.

`/account/devices` lists active and revoked computers, connection times, and
device IDs. Rename devices there, or review a confirmation before revoking
access. Sign out to switch accounts. Revocation stops future syncing and leaves
existing local files in place.

Device tokens have a sliding 90-day expiry. Successful authenticated requests
refresh expiry and last-seen time at most once per minute. An expired or revoked
token is never renewed; sign in again on a computer idle for over 90 days.

## 4. Migrations

`railway.toml` runs `bun packages/server/src/db/migrate.ts` as the pre-deploy
command, so every release applies the Drizzle migrations in
`packages/server/drizzle/` before taking traffic. To run them by hand:

```bash
railway run bun packages/server/src/db/migrate.ts
```

Migrations are additive; generate new ones with:

```bash
bun run --cwd packages/server db:generate
```

## 5. Device enrollment

```bash
bun scripts/auth-demo.ts --base-url https://<service>.up.railway.app
```

The script requests a device code, prints the verification URL and user code,
polls until the browser approval lands, then enrolls a device and prints its
token. On a local development server `--dev-email you@example.com` skips the
browser by signing in through the development path.

## 6. Garbage collection

Blobs that no committed revision references and that are older than
`GC_GRACE_SECONDS` are collectable. Run the sweep as a second Railway service
from the same repository with:

```
startCommand = "bun packages/server/src/gc.ts"
cronSchedule = "0 4 * * *"
```

`bun packages/server/src/gc.ts --dry-run` reports what would go without
deleting anything. `--grace-seconds=` and `--store=` narrow the sweep.

## 7. Health and logs

`GET /health` answers `200` with `{ ok, db, protocolVersion }` when the
database replies, and `503` otherwise. Every request is logged as one JSON line
with `requestId`, method, path, status, and duration; `x-request-id` is echoed
back, or generated when absent. Client requests must send
`x-laurencio-protocol-version`; mismatches return the upgrade message from
`@laurencio/protocol`.

## 8. Known limitations

- Concurrent commits from two devices that touch the same path can create two
  heads the engine refuses to fold on its own. The sync reports
  `RemoteForkError` with the head ids; restore one side with
  `laurencio restore <revision>` and sync again to converge.
- Passphrase rotation reseals only the newest revision. Export before rotating
  if older history matters.

## 9. Publishing the CLI

The CLI publishes as the unscoped `laurencio` package from `packages/cli`, bundled
to a single bun-runtime file.

```bash
cd packages/cli
bunx npm login        # once per machine
bun publish           # prepublishOnly builds dist/index.js
```

Future releases run the `release` workflow on a `v*` tag and need an `NPM_TOKEN`
repository secret with publish rights.

## 10. Operational notes

KDF writes are compare-and-set: a PUT carries the generation the writer read, `null` for the first write, and a stale one comes back as `409` with the current generation in `details`.

The rate limiter is in-memory and per instance. The app runs a single Railway
instance today; a second instance would double the configured burst, not the
long-term rate.
