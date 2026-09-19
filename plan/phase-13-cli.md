# Phase 13: CLI

Back-link: [overview](overview.md)

## Goal

The product surface. Every command a user touches works, reads well, and is scriptable.

## Changes

- `packages/cli/src/index.ts`: argument parsing (single dependency, no framework unless it earns its place), global `--json`, `--verbose`, `--home` for testing, and exit-code discipline (0 clean, 1 error, 2 conflicts present).
- Commands in `packages/cli/src/commands/`:
  - `init`: detect harnesses, show the surface inventory with policies, walk the passphrase setup with the KDF calibration and the plain "lose it and lose your data" warning, run `login` (device flow), choose per-surface enables, write device-local policy, first push with merge/replace/manual per surface and an automatic backup.
  - `status`: last sync time and result per harness, pending queue length, conflicts, device name, drift warnings (files changed since last sync).
  - `sync`: run once; `--dry-run` prints the plan; `--harness` scopes.
  - `pause` / `resume`: daemon control.
  - `diff <surface|path>`: local versus remote versus base, three panes rendered as a unified diff.
  - `log` and `restore <revision> [path]`: history view, restore of a file, a surface, or everything with confirmation.
  - `devices` and `devices revoke <id>`.
  - `resolve [path]`: interactive conflict resolution, opening the merged file with markers and prompting keep-local, keep-remote, or open in editor.
  - `export --out <file>`: encrypted store bundle for backup, plus `--plaintext` with a warning.
  - `doctor`: harness versions, link topology, never-sync inventory, secret scan results, keychain status, protocol version.
  - `surfaces`: the inventory as a table or JSON.
- `packages/cli/src/ui.ts`: one place for human output, prompts, and JSON rendering; copy reviewed with **unslop**; no alarming language, no disclaimers.
- Snapshot tests for human and JSON output of every command.
- `scripts/cli-tests.sh`: bash-driven tests that run commands against a scratch HOME and assert exit codes and output.

## Data structures

- `CommandResult<T>` = `{ data: T, human: () => string, exitCode: 0 | 1 | 2 }` so every command has one code path per output mode.

## Verification

Static: snapshot tests and bash tests in CI.

Runtime: on this machine, run the checklist in [testing.md](testing.md) end to end: `init` (against the dev server), `surfaces`, `status`, a real edit plus `diff`, `sync`, `log`, `restore` of one file, `devices` with a rename, `resolve` on a planted conflict, `export`, and `doctor`. Every command's human output is read by a human; JSON output is piped through `jq` to confirm it parses.

## Notes

Flag conflicts must exit with code 2 so scripts and the daemon can distinguish them from failures. `--home` exists for tests and for the two-HOME harness; keep it undocumented in the first release or mark it as a testing flag.
