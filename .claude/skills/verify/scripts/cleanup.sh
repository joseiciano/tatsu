#!/usr/bin/env bash
# Tear down one verify run: stop the server this run started and any process
# still carrying the sandbox HOME (step-tab PTYs, fake agents), check the real
# agent config files were untouched, delete scratch. Evidence is kept.
#
# Usage: cleanup.sh <state.env>
set -uo pipefail

# shellcheck disable=SC1090
. "$1"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"

sandbox_pids() {
  ps eww -ax -o pid=,command= 2>/dev/null | grep -F "HOME=$SANDBOX_HOME " | grep -v grep | awk '{print $1}'
}

if kill -0 "$PID" 2>/dev/null; then
  case " $(ps eww -o command= -p "$PID" 2>/dev/null) " in
    *" HOME=$SANDBOX_HOME "*)
      kill "$PID"
      for _ in $(seq 1 25); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
      if kill -0 "$PID" 2>/dev/null; then kill -9 "$PID"; echo "pid $PID needed SIGKILL"; fi
      echo "stopped pid $PID"
      ;;
    *) echo "pid $PID is not this run's server (HOME mismatch); not killing it" >&2 ;;
  esac
fi
if [ -n "${GITHUB_STUB_PID:-}" ] && kill -0 "$GITHUB_STUB_PID" 2>/dev/null; then
  case " $(ps eww -o command= -p "$GITHUB_STUB_PID" 2>/dev/null) " in
    *github-stub.mjs*) kill "$GITHUB_STUB_PID" && echo "stopped GitHub stub pid $GITHUB_STUB_PID" ;;
    *) echo "pid $GITHUB_STUB_PID is not this run's GitHub stub; not killing it" >&2 ;;
  esac
fi
STRAYS="$(sandbox_pids)"
if [ -n "$STRAYS" ]; then
  echo "killing sandbox processes: $(echo $STRAYS)"
  kill $STRAYS 2>/dev/null || true
  sleep 1
  STRAYS="$(sandbox_pids)"
  [ -n "$STRAYS" ] && kill -9 $STRAYS 2>/dev/null || true
fi

mkdir -p "$EVIDENCE"
[ -f "$LOG" ] && cp "$LOG" "$EVIDENCE/server.log"
[ -f "$FAKE_AGENT_LOG" ] && cp "$FAKE_AGENT_LOG" "$EVIDENCE/fake-agent.log"
[ -f "$DATA_DIR/debug.log" ] && cp "$DATA_DIR/debug.log" "$EVIDENCE/debug.log"
[ -f "${GITHUB_STUB_LOG:-}" ] && cp "$GITHUB_STUB_LOG" "$EVIDENCE/github-stub.jsonl"
[ -d "$DATA_DIR/workflow-runs" ] && cp -R "$DATA_DIR/workflow-runs" "$EVIDENCE/" 2>/dev/null
GUARD=0
"$SKILL_DIR/scripts/home-guard.sh" check "$EVIDENCE/real-home-before.txt" > "$EVIDENCE/real-home-check.txt" 2>&1 || GUARD=1
cat "$EVIDENCE/real-home-check.txt"

case "$SCRATCH" in
  */tatsu-verify/*) rm -rf "$SCRATCH" && echo "removed $SCRATCH" ;;
  *) echo "refusing to remove unexpected scratch path $SCRATCH" >&2 ;;
esac

echo "evidence kept at $EVIDENCE"
exit "$GUARD"
