# Quickstart

Back-link: [README](../README.md).

## Install

Install the latest standalone binary:

```
curl -fsSL https://raw.githubusercontent.com/ghandhitechnology/laurencio/main/scripts/install.sh | sh
laurencio --version
```

The installer detects macOS or Linux and the CPU architecture, verifies the release checksum, keeps the previous binary as `~/.local/bin/laurencio.previous`, and installs to `~/.local/bin`. Set `LAURENCIO_VERSION` to install a specific release or `LAURENCIO_INSTALL_DIR` to choose another directory.

Add `~/.local/bin` to `PATH` if your shell does not already include it.

## Build from source

The same source compiles to one file with `bun build --compile`:

```
bun install
bun build --compile --outfile laurencio packages/cli/src/index.ts
codesign --force --sign - --identifier com.ghandhitechnology.laurencio laurencio # macOS only
./laurencio --version
```

Add `--target=bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, or `bun-linux-arm64` to cross-compile. The macOS signing step repairs the linker signature before the binary is copied or backed up. `laurencio daemon install` records the path of the program that ran it, so run the binary you want the service to use when installing.

## Enroll this device

```
laurencio init
```

`init` detects the harnesses you have installed, guides the sync selection, asks for the store passphrase, signs you in through the browser, and pushes the first revision. Memory stays off unless explicitly selected. The passphrase derives the encryption key; every linked computer needs the same one.

For the public beta, `init` connects to the staging service automatically. It first offers:

- Skills only, the recommended default.
- Portable config, with global instruction files kept local.
- A surface-by-surface selection.

The browser opens a prefilled approval page showing the computer name. Sign in with an invited email, approve the device, then return to the terminal. The CLI exchanges the short-lived code for a device token and stores it in macOS Keychain. The recovery passphrase unlocks the encrypted store and must be the same on every computer.

To add another computer, run `laurencio init` there, use the same email and recovery passphrase, and choose how to handle any surface that already has local and remote files. Manage names and revoke access with `laurencio devices` or the browser device page.

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

`~/.laurencio/config.toml` is local to each device. It controls harness and surface toggles, ignore patterns, pruning, and daemon cadence.

Machine-specific sections in Claude's `CLAUDE.md`, Codex's `AGENTS.md` and `AGENTS.override.md`, and OpenCode's `AGENTS.md` can be wrapped in `<!-- laurencio:local -->` blocks. Laurencio strips their contents before upload and restores each device's own contents when applying remote edits. Settings such as models and MCP definitions remain shared when their containing surface is enabled, so disable that surface on devices that need different values.

## Uninstall

```
laurencio daemon uninstall
laurencio export --out backup.lrn
```
