#!/usr/bin/env bash
# Read-only: is this verify instance worth driving?
#
# Usage: doctor.sh <state.env>
set -uo pipefail

# shellcheck disable=SC1090
. "$1"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd -P)"
FAIL=0
ok() { echo "ok   $*"; }
bad() { echo "FAIL $*"; FAIL=1; }

if kill -0 "$PID" 2>/dev/null; then ok "pid $PID alive"; else bad "pid $PID not running"; fi

ENV_LINE=" $(ps eww -o command= -p "$PID" 2>/dev/null || true)"
for want in "HOME=$SANDBOX_HOME" "ZDOTDIR=$SANDBOX_HOME" "XDG_CONFIG_HOME=$SANDBOX_HOME/.config" \
  "CODEX_HOME=$SANDBOX_HOME/.codex" "HARNESS_DATA_DIR=$DATA_DIR" "SHELL=/bin/bash"; do
  case "$ENV_LINE" in *" $want "*|*" $want") ok "server env has $want" ;; *) bad "server env lacks $want; do not drive it" ;; esac
done
for v in CLAUDE_CONFIG_DIR OPENCODE_CONFIG_DIR OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT; do
  case "$ENV_LINE" in *" $v="*) bad "$v is set in the server env; it could point outside the sandbox" ;; *) ok "$v unset" ;; esac
done

case "$ENV_LINE" in
  *" GITHUB_TOKEN="*)
    case "$ENV_LINE" in
      *" HARNESS_GITHUB_API_URL=http://127.0.0.1:"*) ok "GITHUB_TOKEN goes only to the loopback GitHub stub" ;;
      *) bad "GITHUB_TOKEN is set without a loopback HARNESS_GITHUB_API_URL; it would reach api.github.com" ;;
    esac
    ;;
  *) ok "GITHUB_TOKEN unset" ;;
esac
if [ -n "${GITHUB_STUB_PID:-}" ] && kill -0 "$GITHUB_STUB_PID" 2>/dev/null; then ok "GitHub stub pid $GITHUB_STUB_PID alive at ${GITHUB_STUB_URL:-?}"; else bad "GitHub stub is not running"; fi

CMD="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).claudeCommand||"")' "$DATA_DIR/config.json" 2>/dev/null)"
case "$CMD" in "$SCRATCH/bin/claude") ok "claudeCommand is the fake-agent shim" ;; *) bad "claudeCommand is '$CMD', not the shim" ;; esac
CODEX_CMD="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).codexCommand||"")' "$DATA_DIR/config.json" 2>/dev/null)"
case "$CODEX_CMD" in "$SCRATCH/bin/codex") ok "codexCommand is the fake-agent shim" ;; *) bad "codexCommand is '$CODEX_CMD', not the shim" ;; esac
OPENCODE_CMD="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).opencodeCommand||"")' "$DATA_DIR/config.json" 2>/dev/null)"
case "$OPENCODE_CMD" in "$SCRATCH/bin/opencode") ok "opencodeCommand is the fake-agent shim" ;; *) bad "opencodeCommand is '$OPENCODE_CMD', not the shim" ;; esac

LISTENER="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"
if [ "$LISTENER" = "$PID" ]; then ok "port $PORT owned by pid $PID"; else bad "port $PORT owned by '${LISTENER:-nobody}', not $PID"; fi

CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL" || true)"
if [ "$CODE" = "200" ]; then ok "web client answers 200 with token"; else bad "web client returned $CODE"; fi

TOKEN="${URL##*token=}"
if node "$REPO/scripts/ws-smoke.mjs" "$TOKEN" "$PORT" > /dev/null 2>&1; then ok "websocket state snapshot round-trips"; else bad "websocket snapshot failed (node scripts/ws-smoke.mjs <token> $PORT)"; fi

NEWER="$(find "$REPO/src" -newer "$REPO/dist-headless/main/index.js" -type f 2>/dev/null | head -1)"
if [ -n "$NEWER" ]; then bad "src/ has files newer than dist-headless (e.g. $NEWER); relaunch with --build"; else ok "dist-headless is newer than src/"; fi
BUILT_REV="$(cat "$EVIDENCE/git-rev.txt" 2>/dev/null || echo unknown)"
HEAD_REV="$(git -C "$REPO" rev-parse HEAD)"
if [ "$BUILT_REV" = "$HEAD_REV" ]; then ok "launched at HEAD $HEAD_REV"; else bad "launched at $BUILT_REV but HEAD is $HEAD_REV"; fi

exit "$FAIL"
