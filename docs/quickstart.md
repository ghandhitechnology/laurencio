# Quickstart

Back-link: [README](../README.md).

## Install

```
bun add -g @laurencio/cli
laurencio --version
```

The package runs on bun 1.3 or newer. On machines without bun, use the standalone binary for your platform instead.

## Build a binary

The same source compiles to one file with `bun build --compile`:

```
bun install
bun build --compile --outfile laurencio packages/cli/src/index.ts
./laurencio --version
```

Add `--target=bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, or `bun-linux-arm64` to cross-compile. `laurencio daemon install` records the path of the program that ran it, so run the binary you want the service to use when installing.

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

## Deletions and `--prune`

`laurencio sync` commits a deletion only when this device can testify to it: the surface root still exists and the path is not on the ignore list. Ignored paths, and entries under a surface root that is missing here, keep their manifest entry so the other devices' copies survive. Run `laurencio sync --prune` to push those removals anyway: a missing surface root and an ignored path that is gone from this device become deletions for that run. The daemon honors `prune = true` in `~/.laurencio/config.toml` the same way.

## Conflicts

`laurencio resolve` walks each conflicted file with a keep-local, keep-remote, or open-in-editor choice. Unresolved files stay on disk as `.conflict-<device>-<timestamp>` copies and never sync.

## Unattended sync

```
laurencio daemon install     # launchd agent on macOS, systemd user unit on Linux
laurencio daemon status      # pid, last sync, service file, log location
laurencio pause | resume     # stop and restart background syncs
laurencio daemon uninstall   # stops the service and removes the plist or unit
```

The daemon watches the enabled surfaces, syncs on an interval, backs off on failures, and defers any file a harness is actively writing. Logs go to `~/Library/Logs/laurencio` on macOS and to journald (`journalctl --user -u laurencio.service`) on Linux.

## Per-device overrides

Values that must differ per machine (model choice, provider region, MCP commands that only exist on one host) live in `~/.laurencio/config.toml` and in `devices/<id>.toml` in the store. Machine-specific sections inside markdown files can be wrapped in `<!-- laurencio:local -->` blocks; they are stripped before upload and re-inserted on each device.

## Uninstall

```
laurencio daemon uninstall
laurencio export --out backup.lrn
```
