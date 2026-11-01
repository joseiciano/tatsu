#!/usr/bin/env bash
# Stop the server this run started and delete its scratch state. Keeps <run-root>/evidence.
# Usage: cleanup.sh <run-root>
set -uo pipefail
ROOT="${1:?usage: cleanup.sh <run-root>}"
if [ -f "$ROOT/server.pid" ]; then
  PID="$(cat "$ROOT/server.pid")"
  KIDS="$(pgrep -P "$PID" 2>/dev/null || true)"
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"
    for _ in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
    kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
  fi
  for k in $KIDS; do kill -0 "$k" 2>/dev/null && kill -TERM "$k"; done
fi
rm -rf "$ROOT/data" "$ROOT/fixture" "$ROOT/url" "$ROOT/server.pid" "$ROOT/server.log"
if [ -d "$ROOT/evidence" ]; then echo "cleaned; evidence kept at $ROOT/evidence"; else echo "cleaned; no evidence at $ROOT/evidence"; fi
