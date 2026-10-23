#!/usr/bin/env bash
# Read-only: is this verify instance worth driving?
#
# Usage: doctor.sh <state.env>
set -uo pipefail

# shellcheck disable=SC1090
. "$1"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
FAIL=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; FAIL=1; }

if kill -0 "$PID" 2>/dev/null; then ok "pid $PID alive"; else bad "pid $PID not running"; fi

ENV_LINE="$(ps eww -o command= -p "$PID" 2>/dev/null || true)"
case "$ENV_LINE" in *"HOME=$SANDBOX_HOME"*) ok "HOME is the sandbox ($SANDBOX_HOME)" ;; *) bad "process HOME is not $SANDBOX_HOME; do not drive it" ;; esac
case "$ENV_LINE" in *"HARNESS_DATA_DIR=$DATA_DIR"*) ok "HARNESS_DATA_DIR is the sandbox" ;; *) bad "HARNESS_DATA_DIR is not $DATA_DIR" ;; esac

LISTENER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ "$LISTENER" = "$PID" ]; then ok "port $PORT owned by pid $PID"; else bad "port $PORT owned by '${LISTENER:-nobody}', not $PID"; fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
if [ "$CODE" = "200" ]; then ok "web client answers 200 with token"; else bad "web client returned $CODE"; fi

BUILT_REV="$(cat "$EVIDENCE/git-rev.txt" 2>/dev/null || echo unknown)"
HEAD_REV="$(git -C "$REPO" rev-parse HEAD)"
NEWER="$(find "$REPO/src" -newer "$REPO/dist-headless/main/index.js" -type f 2>/dev/null | head -3)"
if [ -n "$NEWER" ]; then bad "src/ has files newer than dist-headless (e.g. ${NEWER%%$'\n'*}); relaunch with --build"; else ok "dist-headless is newer than src/"; fi
[ "$BUILT_REV" = "$HEAD_REV" ] && ok "launched at HEAD $HEAD_REV" || bad "launched at $BUILT_REV but HEAD is $HEAD_REV"

for d in .claude/skills .claude/commands .claude/agents .agents/skills .config/opencode/skills .config/opencode/commands .config/opencode/agents .codex; do
  [ -d "$SANDBOX_HOME/$d" ] || bad "sandbox root missing: $d"
done
[ "$FAIL" = 0 ] && ok "sandbox roots present"

exit "$FAIL"
