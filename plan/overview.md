# Laurencio implementation plan

Status: draft, not started. Design decisions live in `../DESIGN.md`.
Plan directory: `plan/`. Fourteen phases in four milestones. Each phase is independently shippable and ends in a check.

## Context

Agent harnesses keep user configuration in per-machine directories (`~/.claude`, `~/.codex`, `~/.config/opencode`) that mix portable content (instructions, skills, agents, model prefs, MCP definitions) with machine state (trust decisions, transcripts, credentials, caches). Nothing official syncs this, requests for it are open or declined, and existing community tools do file-level copy or last-write-wins. We build a hosted service with a CLI: sign in, and per-harness config follows the account across devices, end-to-end encrypted, with real merges and history.

## Scope

Included

- Three harness adapters: Claude Code 2.1.x, Codex CLI 0.155.x, OpenCode 1.18.x and 2.x.
- A scanner that classifies every known path as sync, never, opt-in, or transform, with shared-surface ownership.
- Content pipeline: transforms (path tokens, marker blocks, harness key splits), merge (text 3-way, JSON key, TOML key, conflict copies), secret scanning, E2EE.
- A local engine that converges two machines offline, a hosted server (auth, devices, blobs, revisions), a sync loop, a CLI, and a daemon.
- Packaging: npm package plus single-file binaries, docs.

Explicitly excluded

- Cloud agent execution, sessions, transcripts, run state.
- Project-level config (`.claude/`, `.codex/`, `.opencode/` in repos). Repo git owns those.
- Cross-harness translation, team sharing, org policy, memory sync beyond file-based memory.
- Windows as a first-class platform: copy mode only, no symlink preservation.
- Mobile, web UI beyond device approval and device management.

## Constraints

- Toolchain on this machine: bun 1.3.14, node 26.7, git 2.50, railway CLI, gh 2.100, psql. Package manager and test runner: bun. Orientation: macOS primary, Linux remote second, Windows best effort.
- Crypto must run under both bun and node (npm-installed CLI): audited pure-TS primitives (`@noble/hashes` Argon2id, `@noble/ciphers` XChaCha20-Poly1305) with a native fast path when available. No native modules in the CLI path.
- Keychain access via `@napi-rs/keyring`, with a documented file fallback for headless Linux.
- Server: Hono + Drizzle + Postgres, deployed on Railway; blobs in a Railway storage bucket with presigned URLs. Better Auth device authorization flow plus GitHub OAuth.
- Protocol version negotiation from day one: `protocolVersion` on every request, server rejects on mismatch with a clear upgrade message.
- Adapters are data plus small pure transforms. No harness-specific logic inside the engine.
- Every path we write must be one we declared. Nothing writes outside declared surfaces; the scanner and applier share the declaration.

## Alternatives considered

| Decision | Chosen | Rejected | Rationale |
|---|---|---|---|
| Transport | Hosted service with thin custom protocol, content-addressed encrypted blobs | (a) BYO git remote, (b) real git hosting, (c) generic sync engine (Zero/Electric/PowerSync/Jazz) | Git hosting is ops burden and we parse-merge anyway; generic engines sync database state, not files with harness-specific merge rules. Blob store keeps E2EE natural and the server thin. |
| Placement | Respect per-device layout, resolve symlinks, record materialization map | Canonical source tree with links into harness dirs | The user's machines already run deliberate symlink topologies; canonical trees restructure setups and file-level links break under atomic-rename writers. |
| Conflicts | Auto-merge, conflict copies, `resolve` command, quiescence plus CAS | Halt on conflict; last-writer-wins | Halting stalls an unattended daemon; LWW loses edits. CAS protects against harness writers without user prompts. |
| Trust | E2EE from launch, passphrase-derived key, no escrow | Server-readable; recovery-code escrow | Configs contain proprietary prompts and workflow detail; a lost passphrase is an acceptable, stated risk. |
| Language | TypeScript monorepo, bun | Rust or Go single binary | One language for CLI, server, and protocol types; harness formats (JSONC, TOML) are first-class in TS; single binary still possible via `bun build --compile`. |

## Milestones

| Milestone | Phases | Demoable outcome |
|---|---|---|
| M1 Local core | 1-9 | `bun run e2e:two-home` converges two fake HOMEs through a file-based remote, encrypted, secrets blocked, markers preserved. |
| M2 Server | 10-11 | Two curl clients push and pull revisions against the deployed dev server; bucket holds ciphertext only. |
| M3 Product loop | 12-13 | Real CLI syncs this machine's harness config against the dev server; `status`, `diff`, `restore`, `devices`, `resolve` work. |
| M4 Ship | 14 | Daemon runs unattended; npm package and macOS/Linux binaries install cleanly. |

## Phases

1. [Scaffold](phase-01-scaffold.md): monorepo, tooling, CI, empty packages.
2. [Types and schemas](phase-02-types-and-schemas.md): protocol and domain types, branded ids.
3. [Adapter framework](phase-03-adapter-framework.md): surface declarations, ownership, scanner, marker parsing, fixture lever.
4. [Claude adapter](phase-04-claude-adapter.md): full surface map, MCP extraction, memory slug re-key.
5. [Codex adapter](phase-05-codex-adapter.md): config.toml key split, skills and rules, exclusions.
6. [OpenCode adapter](phase-06-opencode-adapter.md): v1/v2 schema handling, symlink preservation, shared skill sources.
7. [Merge engine](phase-07-merge-engine.md): text 3-way, JSONC and TOML key merges, conflict copies.
8. [Privacy layer](phase-08-privacy-layer.md): secret scanner, Argon2id, AEAD envelopes, keychain.
9. [Local engine](phase-09-local-engine.md): scan to apply loop, materialization, crash recovery, two-HOME e2e.
10. [Server foundation](phase-10-server-foundation.md): Hono app, Better Auth device flow, device registry, Railway deploy.
11. [Server storage](phase-11-server-storage.md): presigned blobs, revision commits, quotas, GC.
12. [Client sync](phase-12-client-sync.md): HTTP transport, offline queue, quiescence, live loop.
13. [CLI](phase-13-cli.md): init, status, sync, diff, log, restore, devices, resolve, export, doctor.
14. [Daemon and ship](phase-14-daemon-and-ship.md): watcher, service installers, packaging, docs.

Parallelism: phases 4-6 are independent after 3 and can go to three worktrees. Phases 10-11 are independent of 4-9 and can start any time after 1.

## Verification

Static, per phase and in CI: `bun install --frozen-lockfile && bun run check && bun run lint && bun test`.

Runtime, per phase as specified in its file, driven with `bash` or background terminals. The recurring runtimes are:

- `bun run scan:demo` against this machine's real harness dirs, read-only, printing the surface inventory.
- `bun run e2e:two-home`, the deterministic two-fake-HOME convergence script with crash injection.
- `bun run e2e:server` against a local Postgres and the dev deployment.
- Manual smoke checklist in [testing.md](testing.md) before each milestone closes.

A phase is not done until its runtime check runs on the matching surface, not on a unit-test surrogate (the **prove-it-works** principle).

## Implementation guidance

Non-negotiables for implementers, by name.

- **how** skill over each unfamiliar subsystem before changing it: harness discovery semantics, jsonc/toml edit libraries, Better Auth plugins, S3 presign behavior.
- **architect** before implementing phases 3, 9, and 11 if the type shape is contested; the checkpoint must name data structures before code.
- **interrogate** on the crypto and commit protocol designs before phase 8 and phase 11 ship; adversarial review is required there, not optional.
- Inspect every diff for generated-code slop before commit, and apply **unslop** to CLI copy and docs.
- **build-the-lever**: fixture capture script (phase 3), two-HOME harness (phase 9), and the secret corpus (phase 8) are committed levers, not one-off scripts.
- **show-me-your-work** decision log for the whole build, since it spans many sessions. Commit it; a reviewer should be able to replay decisions.
- **sequence-verifiable-units**: one phase, one branch, one PR, one green check before the next.
- After opening a PR: `gh pr checks`, triage review comments, fix real issues, dismiss noise with a reason.
- Delegation: children write code per phase with file paths, data shapes, and success criteria; the parent reviews actual diffs and runs the runtime check.
