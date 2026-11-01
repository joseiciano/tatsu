#!/usr/bin/env bash
# Tear down one verify run: stop the server this run started, check the real
# harness roots were untouched, delete scratch state. Evidence is kept.
#
# Usage: cleanup.sh <state.env>
set -uo pipefail

# shellcheck disable=SC1090
. "$1"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if kill -0 "$PID" 2>/dev/null; then
  case "$(ps eww -o command= -p "$PID" 2>/dev/null)" in
    *"HOME=$SANDBOX_HOME"*)
      kill "$PID"
      for _ in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
      kill -0 "$PID" 2>/dev/null && kill -9 "$PID"
      echo "stopped pid $PID"
      ;;
    *) echo "pid $PID is not this run's server (HOME mismatch); not killing it" >&2 ;;
  esac
fi

[ -f "$LOG" ] && cp "$LOG" "$EVIDENCE/server.log"
if [ -d "$SANDBOX_HOME" ]; then
  (cd "$SANDBOX_HOME" && find .claude .codex .agents .config/opencode -print 2>/dev/null | sort) > "$EVIDENCE/sandbox-home-tree.txt"
  mkdir -p "$EVIDENCE/sandbox-home"
  for d in .claude .agents .config; do
    [ -d "$SANDBOX_HOME/$d" ] && cp -RP "$SANDBOX_HOME/$d" "$EVIDENCE/sandbox-home/"
  done
fi
GUARD=0
"$SKILL_DIR/scripts/home-guard.sh" check "$EVIDENCE/real-home-before.txt" > "$EVIDENCE/real-home-check.txt" 2>&1 || GUARD=1
cat "$EVIDENCE/real-home-check.txt"

case "$SCRATCH" in
  */tatsu-verify/*) rm -rf "$SCRATCH" && echo "removed $SCRATCH" ;;
  *) echo "refusing to remove unexpected scratch path $SCRATCH" >&2 ;;
esac

echo "evidence kept at $EVIDENCE"
exit "$GUARD"
