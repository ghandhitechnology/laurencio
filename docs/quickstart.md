# Quickstart

Back-link: [README](../README.md).

## Install

Install the latest standalone binary on macOS:

```
curl -fsSL https://raw.githubusercontent.com/ghandhitechnology/laurencio/main/scripts/install.sh | sh
laurencio --version
```

On Windows, run in PowerShell:

```powershell
irm https://raw.githubusercontent.com/ghandhitechnology/laurencio/main/scripts/install.ps1 | iex
laurencio --version
```

Both installers verify the release checksum and keep the previous binary for rollback. macOS installs to `~/.local/bin`; Windows installs to `%LOCALAPPDATA%\Laurencio\bin` and adds it to your user PATH. Both support x64 and ARM64. Set `LAURENCIO_VERSION` to install a specific release or `LAURENCIO_INSTALL_DIR` to choose another directory.

Add `~/.local/bin` to `PATH` if your shell does not already include it.

## Build from source

The same source compiles to one file with `bun build --compile`:

```
bun install
bun build --compile --outfile laurencio packages/cli/src/index.ts
codesign --force --sign - --identifier com.ghandhitechnology.laurencio laurencio # macOS only
./laurencio --version
```

Release targets are `bun-darwin-arm64`, `bun-darwin-x64`, `bun-windows-x64`, and `bun-windows-arm64`. Build on the target OS and architecture so the native credential-store binding is included. Windows executables use the `.exe` extension. The macOS signing step repairs the linker signature before the binary is copied or backed up. `laurencio daemon install` records the path of the program that ran it, so run the binary you want the service to use when installing.

## Temporary workbench

```sh
laurencio open ~/project
```

On an enrolled computer, `open` reuses the device sign-in and the cached store key: no browser approval and no passphrase prompt. Elsewhere it signs in through the browser and asks for the workbench passphrase. On macOS 15 or later, a clean host downloads the pinned tmux build shipped in the CLI and starts a private server; a host tmux executable is used instead of the pinned download when present. Older macOS releases need a host tmux executable. On Windows x64, a clean host downloads pinned portable WezTerm and PowerShell 7 releases; host executables take precedence when present. Windows ARM64 downloads portable PowerShell 7, but currently needs a host WezTerm executable because upstream does not publish a Windows ARM64 archive. The project directory remains the real host directory, while `HOME`, agent config roots, credentials, and downloaded tools point into the private runtime.

Closing the runtime deletes its private configuration and session token. Project edits remain. To keep selected configuration edits before closing:

```sh
laurencio sessions
laurencio save <session-id> --surface codex.config
laurencio close <session-id>
```

On enrolled computers, verified tools stay under `~/.laurencio/tools` and encrypted blobs under `~/.laurencio/cache/blobs`, so later launches skip downloads. On other computers pass `--cache-tools` to keep the same caches; otherwise everything is deleted with the session. Cached tools are reused through a matching checksum receipt without downloading the artifact again.

The shipped catalog is the fallback when the encrypted profile has an empty tool lock. `laurencio tools update` returns the account to the catalog shipped with the current client. A lock file may select exact entries from that embedded catalog; Laurencio rejects new executable names, sources, versions, or checksums. Catalog and profile artifacts use versioned HTTPS release URLs and pinned SHA-256 hashes.

## Enroll this device

```
laurencio enroll
```

`enroll` detects the harnesses you have installed, guides the sync selection, asks for the store passphrase, signs you in through the browser, and pushes the first revision. It backs up enabled native surfaces before replacing anything and provisions the matching pinned runtimes under `~/.laurencio/tools`. Memory stays off unless explicitly selected. The passphrase derives the encryption key; every linked computer needs the same one. `init` remains a deprecated compatibility alias.

For the public beta, `enroll` connects to the staging service automatically. It first offers:

- Skills only, the recommended default.
- Portable config, with global instruction files kept local.
- A surface-by-surface selection.

The browser opens a prefilled approval page showing the computer name. Sign in with an invited email, approve the device, then return to the terminal. The CLI exchanges the short-lived code for a device token and stores it in macOS Keychain or Windows Credential Manager. The recovery passphrase unlocks the encrypted store and must be the same on every computer.

To add another computer, run `laurencio enroll` there, use the same email and recovery passphrase, and choose how to handle any surface that already has local and remote files. Manage names and revoke access with `laurencio devices` or the browser device page.

When the profile contains terminal keybindings or window dimensions, enrollment and each successful sync apply them to the native tmux or WezTerm config. Generated settings live in `~/.laurencio/generated`. The native config keeps its existing content inside a marked include or Lua wrapper; original files are backed up under `~/.laurencio/backups/terminal`. Edits outside the markers survive synchronization. Modified markers or generated files stop the merge. Symlinks to regular files inside your home directory keep their links.

First enrollment imports tmux bindings that map exactly to Laurencio's portable actions, plus `default-size`. Update the shared profile later with commands such as `laurencio terminal set split-horizontal=ctrl+alt+h columns=120 rows=40`. Prefix a setting with `darwin.` or `win32.` for a platform override; assign an empty value to remove it.

WezTerm watches the generated settings for changes and defaults to PowerShell 7 with its normal profiles when no shell is already configured. Existing tmux servers pick up changes after you reload your native config with `tmux source-file ~/.tmux.conf`, or when you start a new server. Profiles without terminal settings leave existing terminal configs alone.

## Daily use

Run `laurencio config` for an interactive menu, or choose **Manage configuration** from bare `laurencio`. Browse skills and MCP file locations, review changes, sync, inspect history, restore selected files, resolve conflicts, and manage device or terminal settings. Each action shows its command and returns to the menu. Enter a number to choose, `b` to go back, or `q` to leave.

For deliberate skill editing, pause background sync through the menu first, edit the skill in your usual editor, then review and sync when ready. Resume background sync afterward. Restore creates a local backup and asks for confirmation; background sync can publish restored content unless paused. In a temporary workbench, publish selected changes with `laurencio save <session-id> --surface <surface>` from the host terminal before closing.

`laurencio config --json` lists the available actions for scripts. Piped output and `--yes` also list actions without opening prompts or executing them.

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
laurencio daemon install     # launchd on macOS, per-user Scheduled Task on Windows
laurencio daemon status      # pid, last sync, service file, log location
laurencio pause | resume     # stop and restart background syncs
laurencio daemon uninstall   # stops and removes the background service
```

The daemon watches the enabled surfaces, syncs on an interval, backs off on failures, and defers any file a harness is actively writing. Logs go to `~/Library/Logs/laurencio` on macOS and `%USERPROFILE%\.laurencio\logs` on Windows. The Windows task starts at sign-in and runs as your account while you remain signed in, keeping access to your Credential Manager entries without an administrator prompt.

## Per-device overrides

`~/.laurencio/config.toml` is local to each device. It controls harness and surface toggles, ignore patterns, pruning, and daemon cadence.

Machine-specific sections in Claude's `CLAUDE.md`, Codex's `AGENTS.md` and `AGENTS.override.md`, and OpenCode's `AGENTS.md` can be wrapped in `<!-- laurencio:local -->` blocks. Laurencio strips their contents before upload and restores each device's own contents when applying remote edits. Settings such as models and MCP definitions remain shared when their containing surface is enabled, so disable that surface on devices that need different values.

## Uninstall

```
laurencio daemon uninstall
laurencio export --out backup.lrn
```
