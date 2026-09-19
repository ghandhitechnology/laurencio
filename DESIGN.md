# Laurencio design

v0.2. Decisions locked 2026-09-19 after grilling. Implementation plan lives in `plan/`.
Scope: sync user configuration for AI coding harnesses across a user's devices through a hosted account. The server stores and transports config. Agents never run on it.

## 1. Goals and non-goals

Goals

- One account, many devices. Sign in on a new machine and the selected config appears.
- Per-harness management. Claude Code, Codex, and OpenCode have separate scopes, formats, and policies. Syncing one never touches another.
- Safe by construction. Credentials never leave a machine. Conflicts surface as diffs or conflict copies, never silent overwrites.
- End-to-end encrypted. Content is encrypted client-side before upload. The server stores opaque blobs, the revision graph, and account metadata only.
- Reversible. Every sync run is a revision with history and restore.

Non-goals

- Cloud execution. Sessions, transcripts, and run state stay on the device that made them.
- Cross-harness translation in v1 (for example generating Codex skills from Claude skills). Later, optional.
- Org policy distribution. Enterprise managed settings stay with MDM and admin tooling.

## 2. How each harness stores config

### Claude Code 2.1.x

Precedence: managed policy > CLI `--settings` > project local > shared project > user. Lists merge, scalars take the highest source.

| Path | Contents | Sync verdict |
|---|---|---|
| `~/.claude/settings.json` | model, permissions, hooks, statusLine, theme, enabledPlugins, autoMemoryEnabled | sync; strip `env` secrets, rewrite absolute hook/statusLine paths |
| `~/.claude/settings.local.json` | machine grants | never |
| `~/.claude/CLAUDE.md`, `~/.claude/rules/*.md` | personal instructions | sync |
| `~/.claude/{agents,commands,skills,output-styles,themes,workflows}/` | personal assets | sync; exclude `skills/synced/` |
| `~/.claude/keybindings.json` | key rebinds | sync |
| `~/.claude/hooks/*.sh`, `statusline.sh` | scripts referenced by settings | sync; path-fix |
| `~/.claude/plugins/{installed_plugins,known_marketplaces}.json` | install records with `installLocation` | transform, or let each machine install from `enabledPlugins` |
| `~/.claude/plugins/{cache,marketplaces,data,synced}/` | downloaded copies, account-keyed claude.ai sync | never |
| `~/.claude/projects/<slug>/memory/` | auto memory, `MEMORY.md` index plus topics | transform (re-key slug), opt-in |
| `~/.claude/projects/*.jsonl`, `history.jsonl`, `stats-cache.json`, `sessions/`, `shell-snapshots/`, `backups/`, `cache/`, `jobs/`, `daemon/` | transcripts and machine state | never |
| `~/.claude/.credentials.json` | OAuth tokens | never |
| `~/.claude.json` | oauthAccount, machineID, per-project trust, global and local MCP servers | extract `mcpServers` and chosen global keys only, never whole-file |
| repo `.claude/*`, `./CLAUDE.md`, `.mcp.json` | team surfaces | travels with the repo's git |
| `/Library/Application Support/ClaudeCode/`, `/etc/claude-code/`, `C:\Program Files\ClaudeCode\` | managed policy | never |

Mechanics that matter

- Auto memory lives at `~/.claude/projects/<project>/memory/`, where `<project>` is the working directory path with non-alphanumerics replaced by `-`, truncated to 200 chars plus a hash. Env overrides: `CLAUDE_CONFIG_DIR`, `autoMemoryDirectory`, `CLAUDE_CODE_PROJECT_DIR_NAME`.
- Anthropic syncs only claude.ai artifacts (`syncClaudeAiSkills`, `syncClaudeAiPlugins`) into `skills/synced/` and `plugins/synced/`, keyed by account UUID. Personal settings and memory sync is explicitly unsupported.
- `~/.claude.json` is rewritten by the app during sessions, so whole-file sync creates constant conflicts. https://code.claude.com/docs/en/settings, https://code.claude.com/docs/en/memory

### Codex CLI 0.155.x

Precedence: CLI flags and `-c` > project `.codex/config.toml` (trusted dirs only) > profile `$CODEX_HOME/<name>.config.toml` > `~/.codex/config.toml` > cloud-managed defaults > `/etc/codex/config.toml` > built-ins. `requirements.toml` is a separate enforced admin layer.

| Path | Contents | Sync verdict |
|---|---|---|
| `~/.codex/config.toml` portable keys | model, provider, approval, sandbox, `mcp_servers`, tui, features, history, `skills.config`, `plugins.*.enabled` | transform (key-level merge) |
| `config.toml` machine keys | `[projects."<abs>"].trust_level`, `[hooks.state.*]` hashes, `[marketplaces.*].source` absolute paths, `shell_environment_policy.set` | never |
| `~/.codex/<profile>.config.toml` | profile overrides | sync |
| `~/.codex/AGENTS.md`, `AGENTS.override.md` | global instruction chain | sync |
| repo `AGENTS.md`, nested `AGENTS.override.md` | repo instructions | sync via repo git |
| `~/.codex/skills/`, `~/.agents/skills/` | user skills | sync; symlinks transform |
| `~/.codex/plugins/` cache, `[plugins.*]` enable flags | plugin content vs enablement | cache never, flags sync |
| `~/.codex/automations/<name>/{automation.toml,memory.md}` | scheduled tasks with absolute cwds | transform |
| `~/.codex/rules/default.rules` | Starlark execpolicy | sync; path transform |
| `~/.codex/hooks.json`, inline `[hooks]` | lifecycle shell commands | transform |
| `~/.codex/auth.json` or OS keyring | tokens | never |
| `~/.codex/{sessions,archived_sessions}/`, `history.jsonl`, `session_index.jsonl` | transcripts, prompt history | never |
| `state_*.sqlite`, `thread_history_*.sqlite`, `logs_*.sqlite`, `queue_*.sqlite`, `memories_*.sqlite`, caches | machine state, generated memory | never |
| `/etc/codex/*` | admin layer | never |

Mechanics that matter

- `AGENTS.md` merges global first (`AGENTS.override.md` beats `AGENTS.md`), then repo root to cwd, one file per directory, 32 KiB cap, fallback filenames configurable. `CODEX_HOME` relocates the global file.
- Machine-local keys are barred from project config: `openai_base_url`, `model_provider(s)`, `notify`, `profile(s)`, `otel`.
- Memory is a local store by design (current builds use `memories_1.sqlite`), so Codex memory is out of scope for v1 and the adapter reports it as unsupported rather than guessing.
- The account carries entitlements, cloud-managed config defaults, plugin catalog, and cloud threads. https://developers.openai.com/codex/config-file/config-advanced, https://developers.openai.com/codex/agent-configuration/agents-md

### OpenCode 1.18.x and 2.x beta

Both versions read `~/.config/opencode` with different schemas. v1 uses `plugins`, `agents`/`commands`, array `permissions`, `mcp.servers`, `tui.json`. v2 uses `plugin`, `agent`/`command`, object permissions, flat `mcp`, `cli.json`.

| Path | Contents | Sync verdict |
|---|---|---|
| `~/.config/opencode/opencode.json(c)` | providers, model, MCP, permissions, agents, commands | sync; keep v2-compatible keys |
| `~/.config/opencode/cli.json` (v2), `tui.json` (v1) | TUI preferences | sync; fix absolute sound paths |
| `~/.config/opencode/AGENTS.md` | global rules, symlinked here | sync target; preserve the symlink |
| `~/.config/opencode/{agents,commands,skills,themes}/` | global assets | sync |
| `~/.config/opencode/plugins/`, `package.json`, lockfile | local plugins and deps | sync; exclude `node_modules` |
| `~/.config/opencode/tools/*.ts` | v1 custom tools | sync |
| `~/.config/opencode/service.json` | generated local service password | never |
| `~/.local/share/opencode/{auth.json,opencode.db,mcp-auth.json,snapshot,shell,tool-output,log}` | credentials, sessions, OAuth for MCP | never |
| `~/.local/state/opencode/*`, `~/.cache/opencode/*` | last model, session, history, binaries, caches | never |
| repo `opencode.json(c)`, `.opencode/**`, `AGENTS.md` | project config; `.opencode/` overrides every direct config | travels with repo git |
| `.well-known/opencode`, managed dir | org defaults, admin policy | never |

Mechanics that matter

- Project config walks cwd to root and merges farthest to closest; v2 then applies all `.opencode` configs last.
- Skill sources include `~/.claude/skills` and `~/.agents/skills`. Duplicate skill IDs resolve by precedence: explicit `skills` entries, then project `.opencode/skills`, then auto dirs.
- Symlinks are load-bearing on this machine: `AGENTS.md`, `agents/`, `skills/` point into `~/.agents-opencode`. The tool must preserve links, never dereference or replace them.
- Secrets live in three places: `service.json`, `auth.json`, and the v2 SQLite database. https://opencode.ai/v2/docs/config, https://opencode.ai/v2/docs/cli/config

## 3. Shared surfaces and ownership

Some physical trees are read by several harnesses:

- `~/.agents/skills` is read by Codex and OpenCode.
- `~/.claude/skills` is read by Claude Code and, on this machine, is what `~/.codex/skills` links into.
- `~/.agents-opencode` is a user-built single source with symlinks from `~/.config/opencode`.

Design rule: every resolved physical path has exactly one owning surface. Adapters register references, not copies. The engine syncs each tree once and materializes links per harness. Two adapters claiming the same path is a startup error, not a last-wins race.

## 4. Sync model

Store: one encrypted object store per user, namespaced by harness plus a shared namespace. The client encrypts; the server sees content-addressed blobs and a revision graph.

Logical layout, plaintext view, client-side only:

```
shared/skills/...
claude/{settings.json, CLAUDE.md, agents/...}
codex/{config.toml, AGENTS.md, skills/...}
opencode/{opencode.json, cli.json, agents/...}
devices/<device-id>.toml        # per-device overrides, never applied globally
```

On the wire, every path, manifest, and file body is ciphertext. Blob ids are the hash of the ciphertext, so the server cannot index or dedupe by name.

Revision flow per run:

1. Scan the declared surfaces and produce a manifest (path, kind, plaintext hash, size, mode).
2. Fetch remote revision metadata and the last common revision.
3. Compute a three-way merge per file against the base revision.
4. Apply merges, write conflict copies for unresolvable files, then commit and push.
5. Record the run in a local log and surface last-sync time and result in `status`.

Merge policy per surface kind:

- Markdown, scripts, rules: three-way text merge.
- JSON/JSONC settings: key-level merge preserving unknown keys from both sides.
- TOML: key-level merge on the portable key set, machine keys excluded.
- Binary: newest wins plus a conflict copy, never silent.
- Append-only data (memory files): union merge.

Safety rules

- Atomic writes (temp file plus rename) with a compare-and-swap guard: re-read mtime and hash before replacing, retry the merge on mismatch. This is what keeps the tool from fighting Claude Code as it rewrites files mid-session.
- Quiescence window: the daemon defers applying to any file a harness wrote recently, then retries.
- Conflict copies are named `.conflict-<device>-<timestamp>` and are excluded from future syncs.
- Enrollment is the highest-risk moment. First device pushes; later devices choose merge, replace, or manual per surface, with an automatic backup before apply.
- History is the revision graph. `restore` checks out one path, a surface, or the whole namespace at a revision.

## 5. Transforms

- Path tokens. Store `$HOME` and `${XDG_CONFIG_HOME}` tokens, expand per device. Never store absolute paths.
- Rewrite targets: hooks and statusLine commands, plugin `installLocation`, Codex marketplace sources and `workspace_write_roots`, OpenCode absolute sound paths.
- Claude memory slug re-key. Store memory keyed by git remote plus repo-relative path, and write it into the correct local slug on apply. Falls back to a stable hash of the repo path when there is no remote.
- Codex `config.toml` split. Portable keys sync. Trust levels, hook hashes, and absolute paths stay device-local and merge back on apply.
- OpenCode schema handling. Detect which version owns the config dir, write keys each version reads, never silently drop unknown keys.
- Partial file exclusion. `<!-- laurencio:local -->` blocks are stripped before upload, re-inserted at their markers on apply, and never silently dropped. An unclosed marker fails that file loudly. Whole files are excluded per device with an ignore list.
- Per-device overrides. `devices/<id>.toml` holds values that must differ per machine (model choice, provider region, MCP command binaries present locally).

## 6. Secrets and encryption

- Never-sync inventory per harness, derived from the tables above: `.credentials.json`, `auth.json`, `service.json`, `mcp-auth.json`, `opencode.db`, keyring-backed credentials, `settings.local.json`.
- Scanner before upload. Pattern match for key shapes (`sk-`, `ghp_`, `xoxb-`, `AKIA`, PEM blocks) plus entropy heuristics on string values. Fail closed; an explicit override is logged.
- Env indirection. Prefer harness-native expansion (`${ENV}` in Claude MCP config, `{env:VAR}` in OpenCode). Where a harness has no expansion, MCP secret values move to a per-device secret store backed by the OS keychain.
- End-to-end encryption from launch. Argon2id stretches the user's passphrase into a 32-byte master key. HKDF-SHA256 derives per-namespace subkeys. Manifests and blobs are sealed with XChaCha20-Poly1305 and random nonces. Blob ids are the hash of ciphertext.
- The server stores only the public KDF salt and parameters per user, plus opaque blobs, the revision graph, and account and device metadata. Nothing derivable from the passphrase is stored server-side.
- The derived key caches in the OS keychain so the daemon runs unattended. A passphrase change re-encrypts the store client-side. Losing the passphrase loses the data, and onboarding states that plainly.

## 7. Feature set

MVP

| Feature | Why | Pattern source |
|---|---|---|
| Per-harness and per-surface sync toggles | Categories differ in churn and blast radius | Raycast, VS Code |
| Enroll flow: merge / replace / manual, with backup | Enrollment is the top clobber event | VS Code |
| Device list with rename and revoke | Lost laptop, trust management | VS Code, Raycast |
| Diff and conflict copies | Nothing silently vanishes | VS Code, Obsidian |
| Type-aware merge (text, JSON, TOML, binary) | One policy cannot fit all files | Obsidian |
| Bounded history and restore | Undo a bad sync | VS Code |
| End-to-end encryption with passphrase-derived key and keychain cache | The server never reads content | Atuin |
| Partial file exclusion via marker blocks | Machine-specific sections stay local | this design |
| Secret denylist plus scanner | Tokens hide in these files | harness auth docs |
| Opt-in, kill switch, store wipe | Trust and reversibility | Atuin, VS Code |
| Watcher plus interval sync, coalesced and atomic | Sync every few turns without thrash | Warp, this machine's usage |

Later

- Key rotation without a full re-encrypt (key epochs).
- Generations with atomic rollback of an applied state, not just file restore.
- Per-host templates for anything the override file cannot express.
- Team and workspace sharing of a personal harness, with secrets redaction.
- Cross-harness translation (one skill, generated variants).
- Memory sync beyond human-written files, as append-only records with provenance and expiry.
- Real-time push.

## 8. Prior art and differentiation

- Generators and registries, not sync: rulesync (1.4k stars, ~1M npm dl/mo), Vercel's skills CLI (31.6M dl/mo), claude-code-templates (30.7k stars), Docker MCP Gateway, mcpm.
- Config sync scripts: vibe-config-sync, ai-sync, clisync, ai-config-sync-manager, codex-workspace-sync, claude-sync variants, opencode-sync variants. All file-level copy or last-write-wins, none transform harness-specific formats, none handle shared surfaces.
- Account-based partial sync in products: Warp Drive (rules, MCP, prompts), VS Code Settings Sync (settings, extensions, MCP), Cursor user rules, Copilot Memory (server-side preferences), Amp (hosted plugin and skill repos). None covers all three harnesses, none syncs memory and config together, none is end-to-end encrypted.

Differentiation: harness-native adapters with key-level transforms, single ownership of shared surfaces, secret-aware policies, client-side encryption, and a real revision model.

## 9. Architecture sketch

TypeScript monorepo, bun workspaces, four packages plus the plan.

```
packages/protocol/   zod wire schemas, derived types, protocol version
packages/core/       adapters, scan, ownership, transforms, markers, merge,
                     secrets, crypto, engine, materialize, remote clients
packages/cli/        commands, daemon, service installers
packages/server/     Hono app, Better Auth, Drizzle schema, storage, GC
```

Data shape first

- `Surface`: id, harness, path template, kind (tree, file, keyed file), format, policy, merge strategy, transforms, secret rules.
- `Manifest`: revision, device, entries (path, hash, size, mode).
- `Revision`: id, parents, device, timestamp, digest of changed surfaces.
- `Device`: id, name, platform, last seen, override file.
- `LocalLayout`: resolved path to link mode and link target, per device.
- `MarkerRange`: file, line range, content hash.

Server endpoints stay thin: device auth, device registry, KDF parameters, blob presign and fetch, revision commit and listing, quota and GC. The server never parses config.

## 10. Resolved decisions

1. Transport: hosted service with auth and sync. Bring-your-own git remote is a later export path, not the primary.
2. Client stack: TypeScript monorepo, bun workspaces, Hono on Railway, Postgres with Drizzle, Railway storage bucket (S3-compatible), Better Auth device flow with GitHub OAuth.
3. Placement: respect each device's layout, resolve symlinks to targets, keep a per-device materialization map. No canonical source tree.
4. Conflicts: auto-merge, conflict copies, `laurencio resolve`, quiescence and compare-and-swap around live harness writers.
5. Trust: end-to-end encryption from launch, passphrase-derived key, no server escrow, no recovery code.
6. Default sync set: skills, instructions, agents and commands, model and provider prefs, MCP definitions. Memory is opt-in and file-based only.
7. Exclusion: marker blocks for partial files, per-file ignore list for whole files.

Defaults, changeable by evidence: daemon runs after enrollment (watch plus interval, harness hooks later), sync policy is device-local so toggles never sync themselves, and Windows falls back to copy mode where symlinks need privileges.
