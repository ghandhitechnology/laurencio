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
allows the development sign-in fallback, and permits a single instance to run
without the GitHub OAuth app. Use it to smoke-test a deployment:

```
bun scripts/smoke-live.ts --base-url https://<service>.up.railway.app
```

A **production** environment sets `NODE_ENV=production` and refuses the
development sign-in path, so it needs the GitHub OAuth app from section 3
before anyone can sign in.

## 2. Variables

Copy `.env.example` into the service variables and set:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `BETTER_AUTH_SECRET` | `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | the public service URL, for example `https://laurencio.up.railway.app` |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from the GitHub OAuth app |
| `STORAGE_DRIVER` | `s3` (implied when `BUCKET`/`S3_BUCKET` is set) |

`ALLOW_DEV_SIGNIN` must not be set in production; startup fails if it is.
`DATABASE_URL` comes from the Postgres plugin. The filesystem storage driver is
refused in production.

## 3. GitHub OAuth app

Create an OAuth app with callback URL:

```
${BETTER_AUTH_URL}/api/auth/callback/github
```

Sign-in is required to approve device codes and to open `/account/devices`.

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

## 9. Operational notes

KDF writes are compare-and-set: a PUT carries the generation the writer read, `null` for the first write, and a stale one comes back as `409` with the current generation in `details`.

The rate limiter is in-memory and per instance. The app runs a single Railway
instance today; a second instance would double the configured burst, not the
long-term rate.
