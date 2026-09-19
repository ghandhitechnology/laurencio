# Quickstart

Back-link: [README](../README.md).

## Install

```
bun add -g @laurencio/cli
laurencio --version
```

Single-file binaries are built from the same source with `bun build --compile` for macOS (arm64, x64) and Linux (x64, arm64).

## Enroll this device

```
laurencio init
```

`init` detects the harnesses you have installed, shows every configuration surface it found with its policy, asks for a passphrase (this derives your encryption key, and a lost passphrase means lost data), signs you in through the browser, and pushes your first revision. Choose which surfaces to enable; memory sync is opt-in.

## Daily use

```
laurencio status          # last sync, pending queue, conflicts
laurencio sync            # run once now
laurencio diff CLAUDE.md  # local vs remote vs base
laurencio log             # revision history
laurencio restore <rev>   # bring back a file, a surface, or everything
laurencio devices         # list, rename, revoke
laurencio doctor          # versions, link topology, secret scan, keychain
```

Exit codes: `0` clean, `1` error, `2` conflicts are present and need a decision.

## Conflicts

`laurencio resolve` walks each conflicted file with a keep-local, keep-remote, or open-in-editor choice. Unresolved files stay on disk as `.conflict-<device>-<timestamp>` copies and never sync.

## Unattended sync

```
laurencio daemon install
laurencio pause | resume
```

The daemon watches the enabled surfaces, syncs on an interval, backs off on failures, and defers any file a harness is actively writing.

## Per-device overrides

Values that must differ per machine (model choice, provider region, MCP commands that only exist on one host) live in `~/.laurencio/config.toml` and in `devices/<id>.toml` in the store. Machine-specific sections inside markdown files can be wrapped in `<!-- laurencio:local -->` blocks; they are stripped before upload and re-inserted on each device.

## Uninstall

```
laurencio daemon uninstall
laurencio export --out backup.lrn
```
