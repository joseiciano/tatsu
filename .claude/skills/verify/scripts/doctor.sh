#!/usr/bin/env bash
# Read-only check: is the instance for <run-root> worth driving?
# Usage: doctor.sh <run-root>
set -uo pipefail
ROOT="${1:?usage: doctor.sh <run-root>}"
REPO_DIR="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
fail=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; fail=1; }

PID="$(cat "$ROOT/server.pid" 2>/dev/null || true)"
URL="$(cat "$ROOT/url" 2>/dev/null || true)"
[ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && ok "server pid $PID alive" || bad "no live server pid in $ROOT/server.pid"
PORT="$(echo "$URL" | sed -nE 's#http://127\.0\.0\.1:([0-9]+)/.*#\1#p')"
if [ -n "$PORT" ] && lsof -a -p "${PID:-0}" -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then ok "port $PORT owned by pid $PID"; else bad "port ${PORT:-?} not owned by pid ${PID:-?}"; fi
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL" 2>/dev/null || true)"
[ "$CODE" = 200 ] && ok "web client answers 200 with token" || bad "web client returned ${CODE:-nothing}"
BUNDLE="$REPO_DIR/dist-headless/main/index.js"
NEWER="$( [ -f "$BUNDLE" ] && find "$REPO_DIR/src" -type f -newer "$BUNDLE" -print -quit )"
if [ -f "$BUNDLE" ] && [ -z "$NEWER" ]; then ok "dist-headless is newer than every file in src/"; else bad "dist-headless is missing or older than ${NEWER:-src/}; run pnpm build:headless and relaunch"; fi
if grep -rqs 'code-diff-base-ref-list' "$REPO_DIR/dist-headless/web-client"; then ok "web client bundle contains the code diff tool"; else bad "code diff tool missing from web client bundle (ENABLE_CODE_DIFF off?)"; fi
[ -d "$ROOT/fixture/demo-feature" ] && ok "fixture worktree present" || bad "fixture worktree missing; run fixture.sh"
exit $fail
