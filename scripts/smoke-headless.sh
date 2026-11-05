#!/usr/bin/env bash
# End-to-end smoke test for the headless server.
#
# Starts the loopback GitHub stub (scripts/github-stub.mjs) so chain items
# can open pull requests without touching GitHub, then
# launches dist-headless/main/index.js on an ephemeral port + localhost,
# parses the [web-client] URL out of stdout, then delegates to
# scripts/web-smoke.mjs and scripts/ws-smoke.mjs for HTTP + WS
# validation, scripts/workflow-smoke.mjs for a real workflow run
# (agent step via scripts/fake-agent.mjs, then shell steps), and
# scripts/browser-smoke.mjs for the workflow UI in headless Chrome. Finally
# SIGTERMs the server and confirms it exits within 5s (no zombies).
#
# Run locally:  pnpm run build:headless && bash scripts/smoke-headless.sh
# Run in CI:    same — invoked from .github/workflows/ci.yml.
#
# Exit codes: 0 = all checks passed; non-zero = a check failed (the
# server log and fake-agent log are dumped to stderr on any failure).

set -euo pipefail

REPO_DIR="$(pwd -P)"
SCRATCH="$(mktemp -d)"
SCRATCH="$(cd "$SCRATCH" && pwd -P)"
LOG="${HARNESS_SMOKE_LOG:-$SCRATCH/server.log}"
EVIDENCE="${HARNESS_SMOKE_EVIDENCE:-$SCRATCH/evidence}"
SERVER_PID=""
GITHUB_STUB_PID=""

stop_server() {
  kill "$SERVER_PID" 2>/dev/null || true
  for _ in $(seq 1 25); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then break; fi
    sleep 0.2
  done
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "server ignored SIGTERM for 5s; sending SIGKILL" >&2
    kill -9 "$SERVER_PID" 2>/dev/null || true
  fi
  wait "$SERVER_PID" 2>/dev/null || true
}

cleanup() {
  local status=$?
  if [ -n "$SERVER_PID" ]; then
    stop_server
  fi
  if [ -n "$GITHUB_STUB_PID" ]; then
    kill "$GITHUB_STUB_PID" 2>/dev/null || true
    wait "$GITHUB_STUB_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    echo "--- server log ---" >&2
    cat "$LOG" >&2 || true
    if [ -f "${HARNESS_DATA_DIR:-}/debug.log" ]; then
      echo "--- debug.log (tail) ---" >&2
      tail -n 200 "$HARNESS_DATA_DIR/debug.log" >&2 || true
    fi
    if [ -f "${FAKE_AGENT_LOG:-}" ]; then
      echo "--- fake-agent log ---" >&2
      cat "$FAKE_AGENT_LOG" >&2 || true
    fi
    if [ -f "${GITHUB_STUB_LOG:-}" ]; then
      echo "--- github stub requests ---" >&2
      cat "$GITHUB_STUB_LOG" >&2 || true
    fi
    if [ "$EVIDENCE" = "$SCRATCH/evidence" ] && [ -n "$(ls -A "$EVIDENCE" 2>/dev/null)" ]; then
      local kept
      kept="$(mktemp -d "${TMPDIR:-/tmp}/tatsu-smoke-evidence.XXXXXX")"
      cp -R "$EVIDENCE/." "$kept/"
      echo "browser smoke evidence kept at $kept" >&2
    fi
  fi
  rm -rf "$SCRATCH"
  exit "$status"
}
trap cleanup EXIT

# shellcheck source=scripts/smoke-sandbox.sh
. "$REPO_DIR/scripts/smoke-sandbox.sh"
smoke_sandbox "$SCRATCH" "$REPO_DIR" no
smoke_github_stub "$SCRATCH" "$REPO_DIR"
echo "github stub up at $HARNESS_GITHUB_API_URL"
mkdir -p "$EVIDENCE"

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

# 5. Browser: the Phase 2 workflow UI in headless Chrome. Browser
# resolution follows HARNESS_PLAYWRIGHT_BROWSER (used exclusively when set),
# then a Chrome/Chromium on PATH, then playwright's channel:'chrome'.
# browser-smoke exits 77 only when no browser launches: that skips with a
# WARN locally and fails under CI.
if [ -z "${HARNESS_PLAYWRIGHT_BROWSER:-}" ]; then
  for candidate in google-chrome google-chrome-stable chromium; do
    if found="$(command -v "$candidate")"; then
      export HARNESS_PLAYWRIGHT_BROWSER="$found"
      break
    fi
  done
fi
BROWSER_STATUS=0
node scripts/browser-smoke.mjs "$TOKEN" "$PORT" "$WORKTREE" "$EVIDENCE" "$CURL" || BROWSER_STATUS=$?
if [ "$BROWSER_STATUS" -eq 77 ]; then
  if [ -n "${CI:-}" ]; then
    echo "::error::browser smoke: no browser could be launched, and CI requires the browser leg" >&2
    exit 1
  fi
  echo "WARN: browser smoke SKIPPED: no browser could be launched (set HARNESS_PLAYWRIGHT_BROWSER or install Chrome); CI fails here" >&2
elif [ "$BROWSER_STATUS" -ne 0 ]; then
  exit "$BROWSER_STATUS"
fi

# 6. Clean shutdown — SIGTERM should exit within 5s. Catches "server
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
