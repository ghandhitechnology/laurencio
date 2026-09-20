# Setup edge cases: Mac mini and MacBook Air

This is a living record of the edge cases found while linking Andy's two Macs. Each entry records the setup decision and the product change needed to make the next enrollment safer.

## Current setup policy

- Account: staging email login for `heemang12bo@gmail.com`.
- Canonical shared content: the Mac mini wins for files present on both devices.
- Laptop-only skills: preserve and add them to the shared state.
- Initial sync scope: Claude skills, shared agent skills, and Codex skills only.
- Keep settings, MCP servers, hooks, automations, plugins, instructions, memory, and OpenCode local for the first sync.
- Keep pruning, file watching, and memory sync off until both devices have completed a clean manual round trip.

## Edge-case log

### Existing staging deployment

The Railway project, Postgres service, blob bucket, public domain, and staging environment already existed. The setup process must inspect and health-check existing infrastructure before provisioning anything. The selected account had no enrolled devices; existing bucket objects belonged to other test data and were left untouched.

### Remote shell PATH differs from an interactive shell

The laptop is reached over Tailscale and SSH. Bun and other user-installed tools were available in the laptop's login shell but absent from a basic remote command PATH. Remote setup commands must either use a login shell or set the expected user-local paths explicitly.

### The CLI package is not published

The documented package-manager install path was not available. A validated arm64 standalone binary was built from this checkout and installed as `~/.local/bin/laurencio` on both Macs. Tagged releases now publish checksum-protected standalone binaries for both macOS architectures and Linux; the quickstart uses a one-line installer that keeps the previous executable for rollback. npm publication can remain a later distribution channel.

### Tool versions and layouts differ

The machines have different Claude patch versions and substantially different OpenCode installations. The Mac mini also has `opencode2`; the laptop reports both OpenCode commands as version 2.0.9. Setup discovery must inventory commands, versions, config roots, and symlink topology on every device before choosing surfaces.

### Machine-role instructions must remain local

The Mac mini's Claude instructions identify it as a remote Mac mini, while the laptop instructions identify a local laptop and prescribe different browser behavior. These are operational settings, not shared preferences. `claude.instructions`, `codex.instructions`, `codex.instructions-override`, `opencode.instructions`, and the mixed `opencode.source` surface remain disabled on both devices. If instruction sync is enabled later, every machine-role section must first be wrapped in `laurencio:local` markers. Discovery also found that the Mac mini's existing OpenCode instructions say “local laptop”; that mismatch needs an explicit user decision before correction.

### Skill inventories differ substantially

The Mac mini has hundreds more skill files, while the laptop has unique skills that must survive. A first sync cannot safely treat either complete home directory as replaceable. The chosen merge policy is Mac mini precedence for common skill paths plus preservation of laptop-only paths.

### Runtime-managed system skills are not user skills

Codex refreshed files under `~/.codex/skills/.system` during the live round trip. Those files belong to the installed Codex release and can differ between machines, so copying them would overwrite runtime-managed state. Both Codex skill roots now exclude `.system` before scanning, and the two installed configs carry matching ignore rules as defense in depth. Policy ignore globs now match dotfiles consistently, including the `.codex-system-skills.marker` file.

### Absolute and broken symlinks are present

Both machines use symlinked skill directories, including machine-specific absolute links. One Mac mini OpenCode link already pointed into the laptop user's home. Enrollment backup previously dereferenced nested links, which could copy unintended trees. Backups now preserve nested symlinks and include only enabled or explicitly opted-in surfaces.

### Enrollment backed up surfaces that would never sync

The old enrollment backup included catch-all and credential/session locations even when those surfaces could not sync. That created unnecessary plaintext copies. Backup selection now follows the enabled sync plan and excludes never-sync surfaces.

### “Decide later” still synchronized data

Deferring a surface did not persist an off state, so the surface could still join the initial sync. The choice now disables the surface until the user explicitly enables it.

### Local marker support did not match the documentation

The docs promised local blocks for instruction files, but Claude and Codex instructions did not apply the marker transform. OpenCode was subtler: a symlinked `AGENTS.md` was owned by the mixed `opencode.source` tree, bypassing the instruction surface transform. Marker preservation now follows the owning surface, applies to Markdown files in mixed trees, leaves non-Markdown files byte-for-byte unchanged, and preserves symlinks.

### Entropy scanning treated JSON keys as secrets

The scanner classified high-entropy JSON/JSONC property names, public hashes, fingerprints, and recurrence rules as secret values. It now scans parsed literal values and narrowly permits known public formats. A real high-entropy `apiKey` remains in the laptop's OpenCode config, so OpenCode stays local until that value moves to an environment reference or another secure store.

### Per-device override documentation exceeded the implementation

The quickstart described a `devices/<id>.toml` override store that does not exist. Local configuration currently controls surface selection, harnesses, ignores, pruning, and cadence; values inside an enabled settings surface are shared. The documentation now states the implemented behavior.

### Recovery passphrase storage differs over SSH

A generated recovery passphrase was saved in the Mac mini Keychain. macOS refused the laptop Keychain write from a non-interactive SSH session with `User interaction is not allowed`. The laptop copy remains in a mode-`0600` temporary file for enrollment and must be imported from a local laptop session before that temporary file is removed. Setup should detect Keychain interaction limits and present a local handoff step without exposing the secret.

### Rebuilt standalone binaries can trigger Keychain ACL prompts

The first Mac mini enrollment cached its token and derived store key through one unsigned standalone binary. Rebuilding and replacing that binary caused macOS Keychain access to wait for interactive approval on the next sync. Source-built installations need a stable signing identity, or setup must explain that a rebuilt executable may require “Always Allow” again. Background commands should time out or report this state instead of appearing network-stalled.

The first rollback copy also exposed an invalid linker signature in the raw Bun-compiled Mach-O: the original inode launched, while a byte-identical copied backup was killed with exit 137. macOS builds and release artifacts now receive an explicit ad-hoc `codesign` pass before installation. This makes copied rollback binaries executable, though a future Developer ID signature is still needed to preserve Keychain trust across releases.

### Device authorization used to require copying a code

Enrollment now opens the complete short-lived approval link in the default browser. The link carries the device code, computer name, and platform into a confirmation page that shows the selected account. JSON, `--yes`, headless, and failed browser-launch paths still print the complete link and code. Setup must preserve the active terminal process until approval and token exchange finish.

### Staging email access needs a server-side allowlist

The original staging email form used one internal password and accepted any email address, which let an uninvited visitor create or enter an account. Staging now refuses to boot with email sign-in enabled unless `STAGING_EMAIL_ALLOWLIST` is populated. Both the browser form and the underlying auth endpoints normalize and enforce the allowlist. The current invite is `heemang12bo@gmail.com`.

### A device code is claimed by the first signed-in account that views it

Better Auth associates a code with the current account when its approval details are loaded. Signing out after that point cannot move the same code to another account. The approval page now shows the account email before approval. If it is wrong, return to the terminal, restart `laurencio init` to request a fresh code, then open it under the intended account.

### A fresh CLI should not require deployment knowledge

The old `init` asked a user to supply a server URL before they could begin. The beta CLI now defaults to the staging service while preserving `--server`, `LAURENCIO_SERVER`, saved configuration, and file-remote overrides. A fresh interactive setup starts with a guided scope choice; the recommended skills-only preset explicitly disables instruction, settings, automation, plugin, memory, and other portable surfaces.

### Machine instructions need a safe onboarding default

Marker blocks protect machine-local sections after a user adds them, but existing unmarked “this is the Mac mini” or “this is the laptop” text can still travel if global instructions are enabled. Both the skills-only and portable-config setup presets leave Claude, Codex, and OpenCode global instruction sources local. Enabling them requires the explicit custom surface path.

### Large first seeds look stalled

The Mac mini's first seed uploaded 1,189 skill files and took roughly 15 minutes. The old client requested and uploaded each missing blob serially without printing progress after device approval, even though the server continued accepting work. The engine now uses four-worker upload and download pools, deduplicates identical projected content within a run, preserves deterministic manifest ordering, and waits for active work before surfacing an error. The TTY shows the current phase, checked files, transfer counts, throughput, estimated time, and a final duration; JSON and pipes stay stable.

Large `--dry-run --json` plans also exposed an abrupt-exit bug: the process could terminate before a piped stdout stream drained, leaving invalid JSON around the 16 KiB boundary. The CLI now sets its exit code and allows both output streams to flush naturally.

### Device access should survive normal daily use

Device tokens originally expired 90 days after enrollment even when the computer synced every day. Active tokens now use a sliding 90-day window, refreshed with last-seen presence at most once per minute. Revoked and expired tokens cannot renew. The account page separates active and revoked computers, shows exact connection times, supports rename, and requires a dedicated confirmation before revocation.

### Release runner labels expire

The first `v0.1.0` release stalled because GitHub retired the `macos-13` hosted runner label. The Intel build now uses `macos-15-intel`. A failed tag stays in the repository, and the corrected workflow publishes the next patch version instead of rewriting public tag history.

### A real round trip needs content and cleanup verification

A disposable skill was created on the Mac mini, uploaded, downloaded to the laptop, and verified by SHA-256. The laptop then changed the file, uploaded it, and the Mac mini downloaded the exact matching hash. The Mac mini published the deletion and the laptop removed its copy. Every transfer completed without conflicts, blocked secrets, deferred files, or queued work.

## Setup flow improvements

1. Inspect both devices before initialization: tool versions, config roots, enabled surfaces, file counts, symlinks, and secret-scan results.
2. Ask which device wins for common paths and whether unique paths should merge.
3. Start with the smallest safe surface set; keep settings and automation local until content sync is proven.
4. Back up only selected surfaces while preserving symlink objects.
5. Enroll and manually sync the canonical device first, then enroll the second device with an explicit merge decision per overlapping surface.
6. Verify device registration, remote state, local-only markers, symlinks, and blocked secrets before enabling watchers or pruning.
7. Record every new mismatch here and convert repeatable findings into setup validation, code, tests, or documentation.

## Decision log

- Use staging email login instead of GitHub OAuth.
- Use the Mac mini as the winner for shared skill paths.
- Preserve laptop-only skills.
- Generate one recovery passphrase. Cache it in the Mac mini Keychain; the SSH-enrolled laptop uses mode-`0600` credential files until a local Keychain import is completed.
- Defer OpenCode sync until its real API key is removed from the portable config.
