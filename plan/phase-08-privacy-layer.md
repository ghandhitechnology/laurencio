# Phase 8: Privacy layer

Back-link: [overview](overview.md)

## Goal

Nothing unencrypted or secret ever leaves a device, and nothing derivable from the passphrase is ever stored server-side.

## Changes

- `packages/core/src/secrets/patterns.ts`: the key-shape rules (`sk-`, `ghp_`, `github_pat_`, `xoxb-`, `AKIA`, PEM blocks, JWT-shaped strings) plus an entropy heuristic for JSON and TOML string values, with an allowlist for known false positives (hashes, public keys, example keys).
- `packages/core/src/secrets/scan.ts`: scan a projection before upload; return `SecretFinding[]`. Policy: fail closed. Any finding blocks the commit for that surface; an override flag records what was overridden and where.
- `packages/core/src/secrets/placeholders.ts`: rewrite MCP `env` and header values to harness-native indirection where supported (`${ENV}` for Claude, `{env:VAR}` for OpenCode); otherwise move the value to the device-local secret store and leave a placeholder token behind.
- `packages/core/src/crypto/kdf.ts`: Argon2id via `@noble/hashes`, parameters calibrated once per enrollment to a target duration, with the calibration result recorded in `KdfParams`. Never store the passphrase; only salt and parameters are public.
- `packages/core/src/crypto/aead.ts`: HKDF-SHA256 subkeys per namespace (content, manifest, metadata) and XChaCha20-Poly1305 sealing. Envelope framing: magic, version, nonce, ciphertext, with AAD binding store id, blob type, and protocol version. `BlobId` equals sha256 of the framed ciphertext.
- `packages/core/src/crypto/keyring.ts`: cache the derived key via `@napi-rs/keyring`; documented file fallback (0600, warning) for headless Linux. Never write the key into the store or any synced path.
- `packages/core/src/crypto/rotate.ts`: passphrase change re-encrypts all blobs client-side under a new epoch and commits a new revision; old blobs become garbage for phase 11.
- Tests: RFC vectors for Argon2id and XChaCha20-Poly1305, tamper detection, wrong-passphrase failure, keychain fallback, rotation round-trip, and a secret corpus asserting every planted secret is blocked.

## Data structures

- `KdfParams` = `{ algo: 'argon2id', salt, m, t, p, version }` (public).
- `EncryptedEnvelope` = `{ version, nonce, ciphertext }` plus AAD inputs derivable from context.
- `SecretFinding` = `{ path, line?, rule, match (redacted), severity }`.
- `KeyMaterial` = derived bytes wrapper with a `zeroize()` and a hard rule: never serialized, never logged.

## Verification

Static: crypto vectors and the secret corpus suite; a test asserting that no code path serializes `KeyMaterial`.

Runtime: `laurencio doctor --scan` against a scratch HOME seeded with fake credentials in MCP config, settings `env`, and a `.credentials.json`, confirming findings are reported, the sync is blocked, and the override path logs. Then run `bun run e2e:two-home` and attempt to decrypt a store blob with a wrong passphrase; it must fail authentication.

## Notes

Run the **interrogate** skill on this design before shipping the phase. Crypto mistakes are silent, and the review must check envelope framing, AAD binding, nonce generation, and the no-escrow claim end to end.
