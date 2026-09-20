# Laurencio

Your agent workbench on any Mac or Windows computer.

Temporary mode opens an isolated tmux or WezTerm session with your synced setup, leaves the host configuration alone, and deletes the private runtime when the session closes. Full mode migrates the native setup, keeps it synchronized, and preserves backups and revision history.

Skills, instructions, agents, model preferences, MCP definitions, and explicitly selected credentials follow your account with end-to-end encryption. The server stores opaque blobs only.

In full mode, launch an agent with `laurencio agent codex -- [arguments]` (also `claude` and `opencode`) to load its selected MCP secrets from the OS credential store into that process. MCP secrets remain in Keychain or Credential Manager and are injected only into the selected child process.

`enroll` and manual `sync` discover secrets in enabled MCP server definitions and ask before importing them into the encrypted account vault; `--yes` confirms the import. The original configuration is backed up before inline values are replaced with native environment references. Existing native references can import their values from the current environment. New references discovered by background sync wait for a manual import.

Harnesses: Claude Code, Codex CLI, OpenCode.

```sh
laurencio open [project]  # one private session
laurencio enroll          # migrate and sync this device
laurencio config          # browse configuration and recovery actions
```

Design: [DESIGN.md](DESIGN.md). Plan: [plan/overview.md](plan/overview.md). Docs: [quickstart](docs/quickstart.md), [security model](docs/security.md), [deploy](packages/server/docs/deploy.md).

## Development

```
bun install
bun run check
bun run lint
bun test
```
