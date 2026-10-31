#!/usr/bin/env bash
# Start one isolated Tatsu headless server for verification.
#
# Usage: .claude/skills/verify/scripts/launch.sh [--build] [run-id]
#
# Creates a scratch sandbox (fake HOME + HARNESS_DATA_DIR), seeds harness
# resources into the fake HOME, starts dist-headless on an ephemeral port,
# waits for the web-client URL, and writes a state file. Prints the state
# file path as the last line of stdout.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"

BUILD=0
if [ "${1:-}" = "--build" ]; then BUILD=1; shift; fi
RUN_ID="${1:-$(date +%Y%m%d-%H%M%S)-$$}"
if ! [[ "$RUN_ID" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "run id must match [A-Za-z0-9._-]+ (got '$RUN_ID')" >&2
  exit 2
fi

SCRATCH="${TMPDIR:-/tmp}"
SCRATCH="${SCRATCH%/}/tatsu-verify/$RUN_ID"
SANDBOX_HOME="$SCRATCH/home"
DATA_DIR="$SCRATCH/data"
EVIDENCE="$REPO/.verify-evidence/$RUN_ID"
STATE="$SCRATCH/state.env"

if [ -e "$SCRATCH" ]; then
  echo "run id $RUN_ID already exists at $SCRATCH; pick another or run cleanup.sh first" >&2
  exit 1
fi

cd "$REPO"
if [ "$BUILD" = 1 ] || [ ! -f dist-headless/main/index.js ]; then
  pnpm build:headless >&2
fi

mkdir -p "$SANDBOX_HOME" "$DATA_DIR" "$EVIDENCE"
"$SKILL_DIR/scripts/seed.sh" "$SANDBOX_HOME" "$SCRATCH"
"$SKILL_DIR/scripts/home-guard.sh" snapshot > "$EVIDENCE/real-home-before.txt"
git -C "$REPO" rev-parse HEAD > "$EVIDENCE/git-rev.txt"

LOG="$SCRATCH/server.log"
env -u CLAUDE_CONFIG_DIR -u CODEX_HOME -u OPENCODE_CONFIG_DIR \
  HOME="$SANDBOX_HOME" HARNESS_DATA_DIR="$DATA_DIR" \
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
  kill "$PID" 2>/dev/null || true
  exit 1
fi
PORT="${URL#http://127.0.0.1:}"
PORT="${PORT%%/*}"

cat > "$STATE" <<EOF
RUN_ID=$RUN_ID
PID=$PID
URL=$URL
PORT=$PORT
SCRATCH=$SCRATCH
SANDBOX_HOME=$SANDBOX_HOME
DATA_DIR=$DATA_DIR
EVIDENCE=$EVIDENCE
LOG=$LOG
EOF

echo "tatsu-verify $RUN_ID up: pid $PID, $URL" >&2
echo "evidence: $EVIDENCE" >&2
echo "$STATE"
