#!/usr/bin/env bash
# Start one isolated Tatsu headless server for verification.
#
# Usage: .claude/skills/verify/scripts/launch.sh [--build] [run-id]
#
# Sources scripts/smoke-sandbox.sh, the isolation scripts/smoke-headless.sh
# uses: scratch HOME/ZDOTDIR/XDG_CONFIG_HOME/CODEX_HOME, SHELL=/bin/bash,
# CLAUDE_CONFIG_DIR unset, and claudeCommand pointed at a shim for
# scripts/fake-agent.mjs, so step tabs (login-shell PTYs) never run a real
# agent or the user's rc files. The seeded repo is in repoRoots. Starts the
# loopback GitHub stub (smoke_github_stub) before the server, so GITHUB_TOKEN
# only ever reaches the stub; cleanup.sh stops it.
# Prints the state file path as the last line of stdout.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd -P)"

BUILD=0
if [ "${1:-}" = "--build" ]; then BUILD=1; shift; fi
RUN_ID="${1:-$(date +%Y%m%d-%H%M%S)-$$}"
if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "run id must match [A-Za-z0-9._-]+ (got '$RUN_ID')" >&2
  exit 2
fi

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_ROOT="$(cd "${TMP_ROOT%/}" && pwd -P)"
SCRATCH="$TMP_ROOT/tatsu-verify/$RUN_ID"
EVIDENCE_ROOT="${VERIFY_EVIDENCE_ROOT:-$TMP_ROOT/tatsu-verify-evidence}"
EVIDENCE="${EVIDENCE_ROOT%/}/$RUN_ID"
STATE="$SCRATCH/state.env"
case "$EVIDENCE" in "$REPO"/*) echo "evidence must live outside the repo (got $EVIDENCE)" >&2; exit 2 ;; esac

if [ -e "$SCRATCH" ]; then
  echo "run id $RUN_ID already exists at $SCRATCH; pick another or run cleanup.sh first" >&2
  exit 1
fi

cd "$REPO"
if [ "$BUILD" = 1 ] || [ ! -f dist-headless/main/index.js ]; then
  pnpm build:headless >&2
fi

SANDBOX_HOME="$SCRATCH/home"
DATA_DIR="$SCRATCH/data"
mkdir -p "$SCRATCH" "$EVIDENCE"
"$SKILL_DIR/scripts/home-guard.sh" snapshot > "$EVIDENCE/real-home-before.txt"
git -C "$REPO" rev-parse HEAD > "$EVIDENCE/git-rev.txt"

# shellcheck source=../../../../scripts/smoke-sandbox.sh
. "$REPO/scripts/smoke-sandbox.sh"
smoke_sandbox "$SCRATCH" "$REPO" yes
smoke_github_stub "$SCRATCH" "$REPO"

LOG="$SCRATCH/server.log"
node dist-headless/main/index.js --port 0 --host 127.0.0.1 > "$LOG" 2>&1 &
PID=$!

URL=""
for _ in $(seq 1 75); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[a-f0-9]+' "$LOG" | head -1 || true)"
  if [ -n "$URL" ]; then break; fi
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  sleep 0.2
done
if [ -z "$URL" ]; then
  echo "server did not advertise a URL within 15s; log follows" >&2
  cat "$LOG" >&2
  kill "$PID" "$GITHUB_STUB_PID" 2>/dev/null || true
  exit 1
fi
PORT="${URL#http://127.0.0.1:}"
PORT="${PORT%%/*}"

cat > "$STATE" <<STATE_EOF
RUN_ID=$RUN_ID
PID=$PID
URL=$URL
PORT=$PORT
SCRATCH=$SCRATCH
SANDBOX_HOME=$SANDBOX_HOME
DATA_DIR=$DATA_DIR
WORKTREE=$WORKTREE
EVIDENCE=$EVIDENCE
LOG=$LOG
FAKE_AGENT_LOG=$FAKE_AGENT_LOG
GITHUB_STUB_PID=$GITHUB_STUB_PID
GITHUB_STUB_URL=$HARNESS_GITHUB_API_URL
GITHUB_STUB_LOG=$GITHUB_STUB_LOG
REMOTE_REPO=$SMOKE_REMOTE_REPO
REMOTE_BARE=$SMOKE_REMOTE_BARE
STATE_EOF

echo "tatsu-verify $RUN_ID up: pid $PID, $URL" >&2
echo "evidence: $EVIDENCE" >&2
echo "$STATE"
