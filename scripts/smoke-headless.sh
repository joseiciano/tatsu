#!/usr/bin/env bash
# End-to-end smoke test for the headless server.
#
# Launches dist-headless/main/index.js on an ephemeral port + localhost,
# parses the [web-client] URL out of stdout, then delegates to
# scripts/web-smoke.mjs and scripts/ws-smoke.mjs for HTTP + WS
# validation, and scripts/workflow-smoke.mjs for a real workflow run
# (agent step via scripts/fake-agent.mjs, then shell steps). Finally
# SIGTERMs the server and confirms it exits within 5s (no zombies).
#
# Run locally:  pnpm run build:headless && bash scripts/smoke-headless.sh
# Run in CI:    same — invoked from .github/workflows/ci.yml.
#
# Exit codes: 0 = all checks passed; non-zero = a check failed (the
# server log and fake-agent log are dumped to stderr on any failure).

set -euo pipefail

REPO_DIR="$(pwd -P)"
NODE_BIN="$(command -v node)"
LOG="${HARNESS_SMOKE_LOG:-/tmp/harness-server.log}"
SCRATCH="$(mktemp -d)"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
SERVER_PID=""

# Everything the server, its PTYs and installed hooks write goes under
# $SCRATCH: the server installs agent hooks into $HOME, the boot PATH probe
# and every tab run `$SHELL -ilc`, and snapshot commits need a git identity.
export HARNESS_DATA_DIR="$SCRATCH/data"
export HOME="$SCRATCH/home"
export ZDOTDIR="$HOME"
export XDG_CONFIG_HOME="$HOME/.config"
export CODEX_HOME="$HOME/.codex"
export SHELL=/bin/bash
export BASH_SILENCE_DEPRECATION_WARNING=1
export GIT_AUTHOR_NAME="Tatsu Smoke" GIT_AUTHOR_EMAIL="smoke@example.invalid"
export GIT_COMMITTER_NAME="Tatsu Smoke" GIT_COMMITTER_EMAIL="smoke@example.invalid"
export FAKE_AGENT_LOG="$SCRATCH/fake-agent.log"
unset CLAUDE_CONFIG_DIR CLAUDE_CODE_SANDBOXED
mkdir -p "$HARNESS_DATA_DIR/workflows" "$HOME" "$SCRATCH/bin"

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "--- server log ---" >&2
    cat "$LOG" >&2 || true
    if [ -f "$HARNESS_DATA_DIR/debug.log" ]; then
      echo "--- debug.log (tail) ---" >&2
      tail -n 200 "$HARNESS_DATA_DIR/debug.log" >&2 || true
    fi
    if [ -f "$FAKE_AGENT_LOG" ]; then
      echo "--- fake-agent log ---" >&2
      cat "$FAKE_AGENT_LOG" >&2 || true
    fi
  fi
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT

# Fake `claude`: an absolute path, because the login shell may reorder PATH.
CLAUDE_SHIM="$SCRATCH/bin/claude"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$REPO_DIR/scripts/fake-agent.mjs" > "$CLAUDE_SHIM"
chmod +x "$CLAUDE_SHIM"

# Temp repo; its main checkout is the workflow worktree.
mkdir -p "$SCRATCH/repo"
git -C "$SCRATCH/repo" init -q
printf 'smoke\n' > "$SCRATCH/repo/README.md"
git -C "$SCRATCH/repo" add README.md
git -C "$SCRATCH/repo" commit -q -m init
WORKTREE="$(git -C "$SCRATCH/repo" rev-parse --show-toplevel)"

"$NODE_BIN" -e '
const fs = require("fs")
const [home, dataDir, worktree, shim] = process.argv.slice(1)
fs.writeFileSync(`${home}/.claude.json`, JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } }))
fs.writeFileSync(`${dataDir}/config.json`, JSON.stringify({
  repoRoots: [],
  claudeCommand: shim,
  hooksConsent: "accepted",
  hooksMigratedToGlobal: true,
  labs: { workflows: true },
  workflowSettings: { maxConcurrentAgents: 1 }
}))
' "$HOME" "$HARNESS_DATA_DIR" "$WORKTREE" "$CLAUDE_SHIM"

cat > "$HARNESS_DATA_DIR/workflows/smoke.yaml" <<'YAML'
name: smoke
steps:
  - id: plan
    agent: claude
    permissions: read-only
    prompt: "Reply PLAN-OK and call complete_step."
  - id: echo
    kind: shell
    run: echo {{steps.plan.summary}}
YAML
cat > "$HARNESS_DATA_DIR/workflows/smoke-retry.yaml" <<'YAML'
name: smoke-retry
steps:
  - id: check
    kind: shell
    run: test -f flag
YAML
cat > "$HARNESS_DATA_DIR/workflows/smoke-full.yaml" <<'YAML'
name: smoke-full
steps:
  - id: plan
    agent: claude
    permissions: full
    prompt: "This must never start without allowFull."
YAML

if command -v curl >/dev/null 2>&1; then CURL=yes; else CURL=no; fi
echo "curl present: $CURL"

node dist-headless/main/index.js --port 0 --host 127.0.0.1 > "$LOG" 2>&1 &
SERVER_PID=$!

# Wait up to 15s for the URL line. Format is
#   "[web-client] open http://127.0.0.1:<port>/?token=<token>"
# emitted from src/main/index.ts in the webHttpServer.listen callback.
# If the log shape changes, this fails loudly (which is what we want,
# since the Settings UI and other tooling read the same line).
URL=""
for _ in $(seq 1 75); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[a-f0-9]+' "$LOG" | head -1 || true)"
  if [ -n "$URL" ]; then break; fi
  sleep 0.2
done
if [ -z "$URL" ]; then
  echo "::error::headless server did not advertise a URL within 15s" >&2
  exit 1
fi
echo "server up at $URL"

# Split URL into host:port + token for the existing smoke scripts.
# URL shape is fixed (http://127.0.0.1:<port>/?token=<hex>), no need
# for a real URL parser.
HOST_PORT="${URL#http://}"
HOST_PORT="${HOST_PORT%%/*}"
TOKEN="${URL##*token=}"
PORT="${HOST_PORT##*:}"

# 1+2. web-client HTTP: auth gate + HTML + asset reachability.
node scripts/web-smoke.mjs "$HOST_PORT" "$TOKEN"

# 3. WS upgrade + snapshot round-trip.
node scripts/ws-smoke.mjs "$TOKEN" "$PORT"

# 4. Workflow runs: agent + shell steps, then shell fail -> retry -> done.
node scripts/workflow-smoke.mjs "$TOKEN" "$PORT" "$WORKTREE" "$CURL"

# 5. Clean shutdown — SIGTERM should exit within 5s. Catches "server
# hangs on SIGTERM" bugs that would leave zombies in CI.
kill -TERM "$SERVER_PID"
for _ in $(seq 1 25); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
  sleep 0.2
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
  echo "::error::server did not exit on SIGTERM within 5s" >&2
  kill -9 "$SERVER_PID" || true
  exit 1
fi
SERVER_PID=""
echo "clean shutdown OK"
