# Security model

Back-link: [README](../README.md). Design decisions live in [DESIGN.md](../DESIGN.md).

## What the server can see

- Opaque ciphertext blobs, addressed by the sha256 hash of their own bytes.
- The revision graph: revision ids, parent ids, device id, timestamps, blob sizes.
- Account and device metadata: your user id, device names, platforms, last-seen times.
- The public KDF parameters: algorithm, salt, memory and time costs.

## What the server never sees

- File contents, paths, skill names, project names, or memory text. Manifests are encrypted, so even the file list is opaque.
- Your passphrase. It is stretched locally with Argon2id; only the public salt and cost parameters are stored server-side.
- Credentials of any kind. `.credentials.json`, `auth.json`, `service.json`, `mcp-auth.json`, `opencode.db`, and keyring data are classified `never` by the adapters and are never read, hashed, or uploaded.

## Key custody

The master key is derived from your passphrase with Argon2id and never stored on the server. It is cached in the OS keychain so the sync daemon can run unattended; on headless Linux the fallback is a 0600 key file under `~/.laurencio`. Losing the passphrase loses the data, and there is no recovery code by design. Use `laurencio export` to keep an encrypted bundle somewhere safe.

## Encryption

- Subkeys are derived per namespace (content, manifest, metadata) with HKDF-SHA256.
- Every blob and manifest is sealed with XChaCha20-Poly1305 under a random nonce.
- The AAD binds the store id, blob type, and protocol version, so a blob cannot be replayed into another store or reinterpreted as another type.
- Blob ids are the hash of the ciphertext, so the server cannot dedupe or index by content, and a client verifies what it downloads.

## Secrets inside synced files

Files that may contain live credentials are never uploaded. Secret scanning runs before every upload and fails closed: a file with a key-shaped value is blocked, not sanitized. Where a harness supports it, secret values are rewritten to environment indirection (`${ENV}` for Claude MCP config, `{env:VAR}` for OpenCode) before upload. The device also keeps a local secret store for values with no harness-native indirection.

## Conflicts and history

Conflicts never silently overwrite. Text merges three-way, settings merge per key, and anything unresolvable lands as a `.conflict-<device>-<timestamp>` copy that is excluded from future syncs. Every run is a revision; `laurencio log` and `laurencio restore` can bring back a file, a surface, or the whole store.

## Devices

Each device enrolls through the device authorization flow and holds its own token. `laurencio devices revoke <id>` kills the device's access on its next request. A revoked device fails with a clear error and must sign in again.

## Limits worth knowing

- The daemon caches the derived key in the keychain; protecting your unlocked session is your operating system's job.
- Conflict copies are local artifacts and are not synced, by design.
- Codex memory (a SQLite store) and session transcripts are out of scope; they are reported as unsupported rather than guessed at.
- Project-level config in repositories is not synced here. Repo git owns it.
