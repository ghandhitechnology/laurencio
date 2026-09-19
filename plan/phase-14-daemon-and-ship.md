# Phase 14: Daemon and ship

Back-link: [overview](overview.md)

## Goal

Unattended sync and a clean install for other people.

## Changes

- `packages/cli/src/daemon/`: file watchers per enabled surface (debounced), interval sync, exponential backoff on failures, pause honoring, single-instance lock with stale PID detection, and status written to `state.db` for `laurencio status`.
- Service installers: `laurencio daemon install|uninstall|status` writing a launchd plist on macOS and a systemd user unit on Linux, with logs to `~/Library/Logs/laurencio` or journald.
- `packages/cli/src/daemon/events.ts`: the later hook integration point (harness session hooks), defined but not wired in v1.
- Packaging: npm package `@laurencio/cli` with a bin entry, plus `bun build --compile` targets for macOS arm64 and x64, and Linux x64 and arm64. `laurencio upgrade` checks npm for a newer version and prints the command.
- Release automation: GitHub Actions on tag, running check, lint, test, the two-HOME harness, and building binaries with checksums; npm publish with provenance.
- `docs/`: install, quickstart, security model (what the server sees, what it never sees, the passphrase warning), harness support matrix, troubleshooting, and a privacy page.
- Final smoke: run the full checklist in [testing.md](testing.md) on a clean temp HOME with the released artifacts, on macOS and on Linux.

## Data structures

- `DaemonState` = `{ pid, startedAt, paused, lastSync, lastResult }`, persisted in `state.db`.

## Verification

Static: full suite plus the two-HOME harness in release CI.

Runtime: install from npm into a clean temp HOME and repeat the manual smoke checklist; then compile the binary and repeat. Leave the daemon running for a full day of real use on this machine, then inspect `status` history and `~/.laurencio` state for anomalies: memory growth in the daemon process, duplicate conflict copies, unexpected files inside declared surfaces, or keychain prompts. Verify `daemon uninstall` leaves no plist or unit behind.

## Notes

The daemon is the only long-running process; keep it boring. No sync while paused, no sync of a surface that a harness is actively rewriting beyond the quiescence rule, and no silent failures (every failure lands in `status` and the log).
