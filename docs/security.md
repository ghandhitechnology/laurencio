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
- Plaintext credentials. Agent login files and explicitly referenced MCP secrets can enter the separately encrypted credential vault; the server sees only its opaque ciphertext. Other credential, database, keyring, and session stores remain excluded.

## Key custody

The master key is derived from your passphrase with Argon2id and never stored on the server. It is cached in macOS Keychain or Windows Credential Manager so the sync daemon can run unattended. Windows requires Credential Manager and stops when it is unavailable; it never falls back to plaintext key or token files. On macOS, a warned fallback can use a 0600 file under `~/.laurencio`. Losing the passphrase loses the data, and there is no recovery code by design. Use `laurencio export` to keep an encrypted bundle somewhere safe.

Windows workbenches launch a separate WezTerm GUI with an explicit configuration file and redirected agent configuration directories. WezTerm chooses the GUI mux socket location itself. The recorded `socketPath` is reserved metadata on Windows; lifecycle checks use the GUI process ID and start identity, and cleanup removes only artifacts owned by that process.

## Encryption

- Subkeys are derived per namespace (content, manifest, metadata, profile, vault) with HKDF-SHA256.
- Every blob and manifest is sealed with XChaCha20-Poly1305 under a random nonce.
- The AAD binds the store id, blob type, and protocol version, so a blob cannot be replayed into another store or reinterpreted as another type.
- Blob ids are the hash of the ciphertext, so the server cannot dedupe or index by content, and a client verifies what it downloads.

## Secrets inside synced files

Files that may contain live credentials never enter configuration revisions. Secret scanning runs before every config upload and fails closed: a file with a key-shaped value is blocked, not sanitized. Agent login files and MCP variables named by the profile use the separate encrypted vault, with per-record versions and compare-and-swap head rotation. Other secrets stay local. Where a harness supports it, MCP values in synced config are rewritten to environment indirection (`${ENV}` for Claude, `{env:VAR}` for OpenCode).

## Conflicts and history

Conflicts never silently overwrite. Text merges three-way, settings merge per key, and anything unresolvable lands as a `.conflict-<device>-<timestamp>` copy that is excluded from future syncs. Every run is a revision; `laurencio log` and `laurencio restore` can bring back a file, a surface, or the whole store.

## Devices

Each device enrolls through the device authorization flow and holds its own token. `laurencio devices revoke <id>` kills the device's access on its next request. A revoked device fails with a clear error and must sign in again.

Temporary workbench tokens expire with their session. They cannot enroll permanent devices, rotate KDF parameters, migrate the account profile, create another temporary actor, or write the account profile head.

## Limits worth knowing

- Two devices that commit between syncs can create two heads. When they edit
  the same file, the engine reports the fork instead of guessing; restore one
  side and sync again.

- The daemon caches the derived key in the keychain; protecting your unlocked session is your operating system's job.
- Conflict copies are local artifacts and are not synced, by design.
- Codex memory (a SQLite store) and session transcripts are out of scope; they are reported as unsupported rather than guessed at.
- Project-level config in repositories is not synced here. Repo git owns it.
