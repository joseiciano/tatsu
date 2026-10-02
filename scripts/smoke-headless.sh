#!/usr/bin/env bash
# End-to-end smoke test for the headless server.
#
# Launches dist-headless/main/index.js on an ephemeral port + localhost,
# parses the [web-client] URL out of stdout, then delegates to
# scripts/web-smoke.mjs and scripts/ws-smoke.mjs for HTTP + WS
# validation. Finally SIGTERMs the server and confirms it exits within
# 5s (no zombies).
#
# Run locally:  pnpm run build:headless && bash scripts/smoke-headless.sh
# Run in CI:    same — invoked from .github/workflows/ci.yml.
#
# Exit codes: 0 = all checks passed; non-zero = a check failed (the
# server log is dumped to stderr on URL-parse failure).

set -euo pipefail

# Isolated data dir so we don't touch ~/.harness on a dev box or the
# runner's $HOME in CI.
LOG="${HARNESS_SMOKE_LOG:-/tmp/harness-server.log}"
HARNESS_DATA_DIR="$(mktemp -d)"
export HARNESS_DATA_DIR

node dist-headless/main/index.js --port 0 --host 127.0.0.1 > "$LOG" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true; wait "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait up to 15s for the server to be ready. The server now writes the
# full token URL to $HARNESS_DATA_DIR/web-client-url.txt and prints a
# redacted log line. We watch for either the file or the log line.
URL_FILE="$HARNESS_DATA_DIR/web-client-url.txt"
URL=""
for _ in $(seq 1 75); do
  # Prefer the file — it has the real token URL.
  if [ -f "$URL_FILE" ] && [ -s "$URL_FILE" ]; then
    URL="$(head -1 "$URL_FILE")"
  fi
  # Fallback: parse the redacted log line for host:port only (no token),
  # then read the token from the file.
  if [ -z "$URL" ]; then
    HOST_PORT_LINE="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/' "$LOG" | head -1 || true)"
    if [ -n "$HOST_PORT_LINE" ] && [ -f "$URL_FILE" ] && [ -s "$URL_FILE" ]; then
      TOKEN="$(head -1 "$URL_FILE" | sed 's/.*token=//')"
      URL="${HOST_PORT_LINE}?token=${TOKEN}"
    fi
  fi
  if [ -n "$URL" ]; then break; fi
  sleep 0.2
done
if [ -z "$URL" ]; then
  echo "::error::headless server did not advertise a URL within 15s" >&2
  echo "--- server log ---" >&2
  cat "$LOG" >&2
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

# 4. Clean shutdown — SIGTERM should exit within 5s. Catches "server
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
echo "clean shutdown OK"
trap - EXIT
