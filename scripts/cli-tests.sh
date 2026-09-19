#!/usr/bin/env bash
# End-to-end CLI tests against a scratch HOME and a FileRemote store. Every
# command runs the real entry point as a subprocess; assertions cover exit
# codes, human output, and JSON parseability.
#
# Run: bash scripts/cli-tests.sh   (or: bun run --cwd packages/cli cli:test)

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(bun "$ROOT/packages/cli/src/index.ts")
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/laurencio-cli-tests.XXXXXX")"
HOME_DIR="$SCRATCH/home"
REMOTE_DIR="$SCRATCH/remote"
mkdir -p "$HOME_DIR"

export LAURENCIO_KEYCHAIN=file
export LAURENCIO_REMOTE_DIR="$REMOTE_DIR"

PASS=0
FAILED=0
LAST_OUT=""

cleanup() {
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  FAILED=$((FAILED + 1))
}

pass() {
  PASS=$((PASS + 1))
}

# run <expected-exit> <args...>
run() {
  local expected="$1"
  shift
  set +e
  LAST_OUT="$("${CLI[@]}" "$@" --home "$HOME_DIR" 2>&1)"
  local code=$?
  set -e
  if [ "$code" != "$expected" ]; then
    fail "exit $code, expected $expected: laurencio $*"
    echo "$LAST_OUT" | sed 's/^/    /' >&2
  else
    pass
  fi
}

assert_contains() {
  case "$LAST_OUT" in
    *"$1"*) pass ;;
    *)
      fail "output does not contain '$1': laurencio $2"
      echo "$LAST_OUT" | sed 's/^/    /' >&2
      ;;
  esac
}

assert_json() {
  if printf '%s' "$LAST_OUT" | bun -e 'const text = await Bun.stdin.text(); JSON.parse(text)' >/dev/null 2>&1; then
    pass
  else
    fail "output is not JSON: $1"
    echo "$LAST_OUT" | sed 's/^/    /' >&2
  fi
}

json_field() {
  printf '%s' "$LAST_OUT" | bun -e "const data = JSON.parse(await Bun.stdin.text()); console.log($1)"
}

echo "== help and version =="
run 0 --version
assert_contains "laurencio" "--version"
run 0 --help
assert_contains "Usage: laurencio" "--help"
run 1 frobnicate
assert_contains "unknown command" "frobnicate"

echo "== seed =="
bun "$ROOT/packages/cli/test/helpers/seed-cli.ts" \
  --home "$HOME_DIR" \
  --remote "$REMOTE_DIR" \
  --file '.claude/CLAUDE.md=# Instructions' \
  --file '.codex/AGENTS.md=# Codex rules' >/dev/null
pass

echo "== surfaces =="
run 0 surfaces
assert_contains "claude.settings" "surfaces"
run 0 surfaces --json
assert_json "surfaces --json"

echo "== init =="
run 0 init --yes
assert_contains "Sync synced" "init"
run 0 status
assert_contains "Last sync" "status"
run 0 status --json
assert_json "status --json"
STATUS_EXIT=0

echo "== drift and diff =="
printf '# Instructions\n\nMore.\n' >"$HOME_DIR/.claude/CLAUDE.md"
run 0 status --json
assert_json "status with drift"
run 0 diff claude.instructions
assert_contains "--- base" "diff"
run 0 diff --json
assert_json "diff --json"

echo "== sync =="
run 0 sync --dry-run
assert_contains "Dry run" "sync --dry-run"
run 0 sync --dry-run --json
assert_json "sync --dry-run --json"
run 0 sync
assert_contains "Sync synced" "sync"
run 0 sync
assert_contains "Sync idle" "sync again"
run 0 sync --harness codex
assert_contains "Sync" "sync --harness"

echo "== log and restore =="
run 0 log
assert_contains "REVISION" "log"
run 0 log --json
assert_json "log --json"
REV="$(json_field 'data.revisions[0].id')"
if [ -z "$REV" ]; then fail "log --json returned no revision"; else pass; fi
run 0 restore "$REV" claude.instructions --yes
assert_contains "Restored" "restore"
run 1 restore "$REV" --json
assert_contains "confirmation-required" "restore without --yes"

echo "== devices =="
run 0 devices
assert_contains "DEVICE" "devices"
run 0 devices --json
assert_json "devices --json"
run 0 devices rename self --name bash-laptop
assert_contains "bash-laptop" "devices rename"
run 0 devices rename self --name test-laptop

echo "== resolve =="
run 0 resolve
assert_contains "No conflicts" "resolve"

echo "== export and doctor =="
run 0 export --out "$SCRATCH/bundle.json"
assert_contains "Exported" "export"
if [ -s "$SCRATCH/bundle.json" ]; then pass; else fail "export wrote no file"; fi
run 0 doctor
assert_contains "Protocol: v1" "doctor"
run 0 doctor --json
assert_json "doctor --json"

echo "== pause and resume =="
run 0 pause
assert_contains "paused" "pause"
run 0 pause
assert_contains "already paused" "pause twice"
run 0 resume
assert_contains "resumed" "resume"

echo "== conflicts exit 2 =="
printf 'local content\n' >"$HOME_DIR/.claude/CLAUDE.md"
bun "$ROOT/packages/cli/test/helpers/seed-cli.ts" \
  --home "$HOME_DIR" \
  --remote "$REMOTE_DIR" \
  --conflict '.claude/CLAUDE.md' >/dev/null
run 2 status
assert_contains "Conflicts: 1" "status with a conflict"
run 0 resolve --keep-local
assert_contains "Resolved 1 conflict" "resolve --keep-local"
run 0 status
assert_contains "Conflicts: none" "status after resolve"

echo "== offline init =="
OFFLINE_HOME="$SCRATCH/offline-home"
mkdir -p "$OFFLINE_HOME"
set +e
OFFLINE_OUT="$(env -u LAURENCIO_REMOTE_DIR "${CLI[@]}" init --server http://127.0.0.1:1 --yes --home "$OFFLINE_HOME" 2>&1)"
OFFLINE_CODE=$?
set -e
if [ "$OFFLINE_CODE" != "0" ]; then
  fail "offline init exit $OFFLINE_CODE, expected 0"
else
  pass
fi
case "$OFFLINE_OUT" in
  *"not reachable"*) pass ;;
  *) fail "offline init did not report the unreachable server: $OFFLINE_OUT" ;;
esac

echo
echo "cli tests: $PASS passed, $FAILED failed"
if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
