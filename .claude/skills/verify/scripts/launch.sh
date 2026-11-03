#!/usr/bin/env bash
# Start one isolated Tatsu headless server for verification.
#
# Usage: .claude/skills/verify/scripts/launch.sh [--build] [run-id]
#
# Same isolation as scripts/smoke-headless.sh: scratch HOME/ZDOTDIR/
# XDG_CONFIG_HOME/CODEX_HOME, SHELL=/bin/bash, CLAUDE_CONFIG_DIR unset, and
# claudeCommand pointed at a shim for scripts/fake-agent.mjs, so step tabs
# (login-shell PTYs) never run a real agent or the user's rc files.
# Prints the state file path as the last line of stdout.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd -P)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd -P)"
NODE_BIN="$(command -v node)"

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
WORKTREE_DIR="$SCRATCH/repo"
mkdir -p "$SANDBOX_HOME" "$DATA_DIR/workflows" "$SCRATCH/bin" "$EVIDENCE"
"$SKILL_DIR/scripts/home-guard.sh" snapshot > "$EVIDENCE/real-home-before.txt"
git -C "$REPO" rev-parse HEAD > "$EVIDENCE/git-rev.txt"

export HARNESS_DATA_DIR="$DATA_DIR"
export HOME="$SANDBOX_HOME"
export ZDOTDIR="$HOME"
export XDG_CONFIG_HOME="$HOME/.config"
export CODEX_HOME="$HOME/.codex"
export SHELL=/bin/bash
export BASH_SILENCE_DEPRECATION_WARNING=1
export GIT_AUTHOR_NAME="Tatsu Verify" GIT_AUTHOR_EMAIL="verify@example.invalid"
export GIT_COMMITTER_NAME="Tatsu Verify" GIT_COMMITTER_EMAIL="verify@example.invalid"
export FAKE_AGENT_LOG="$SCRATCH/fake-agent.log"
unset CLAUDE_CONFIG_DIR CLAUDE_CODE_SANDBOXED OPENCODE_CONFIG_DIR

CLAUDE_SHIM="$SCRATCH/bin/claude"
printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$NODE_BIN" "$REPO/scripts/fake-agent.mjs" > "$CLAUDE_SHIM"
chmod +x "$CLAUDE_SHIM"

mkdir -p "$WORKTREE_DIR"
git -C "$WORKTREE_DIR" init -q -b main
printf 'verify\n' > "$WORKTREE_DIR/README.md"
git -C "$WORKTREE_DIR" add README.md
git -C "$WORKTREE_DIR" commit -q -m init
WORKTREE="$(git -C "$WORKTREE_DIR" rev-parse --show-toplevel)"

"$NODE_BIN" -e '
const fs = require("fs")
const [home, dataDir, worktree, shim] = process.argv.slice(1)
fs.writeFileSync(`${home}/.claude.json`, JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } }))
fs.writeFileSync(`${dataDir}/config.json`, JSON.stringify({
  repoRoots: [worktree],
  claudeCommand: shim,
  hooksConsent: "accepted",
  hooksMigratedToGlobal: true,
  labs: { workflows: true },
  workflowSettings: { maxConcurrentAgents: 1 }
}))
' "$HOME" "$HARNESS_DATA_DIR" "$WORKTREE" "$CLAUDE_SHIM"

cat > "$DATA_DIR/workflows/verify-done.yaml" <<'YAML'
name: verify-done
steps:
  - id: plan
    agent: claude
    permissions: read-only
    prompt: "Reply PLAN-OK and call complete_step."
  - id: echo
    kind: shell
    run: echo {{steps.plan.summary}}
YAML
cat > "$DATA_DIR/workflows/browser-hang.yaml" <<'YAML'
name: browser-hang
steps:
  - id: hang
    agent: claude
    permissions: read-only
    prompt: "FAKE_AGENT_MODE=hang Stay alive and never call complete_step."
YAML
cat > "$DATA_DIR/workflows/browser-exit.yaml" <<'YAML'
name: browser-exit
steps:
  - id: exit
    agent: claude
    permissions: read-only
    prompt: "FAKE_AGENT_MODE=exit-no-complete Exit without calling complete_step."
YAML

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
  kill "$PID" 2>/dev/null || true
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
STATE_EOF

echo "tatsu-verify $RUN_ID up: pid $PID, $URL" >&2
echo "evidence: $EVIDENCE" >&2
echo "$STATE"
