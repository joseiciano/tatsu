#!/usr/bin/env bash
# Start an isolated headless Tatsu server against the fixture repo.
# Usage: launch.sh <run-root>   (run fixture.sh first; build with `pnpm build:headless`)
set -euo pipefail
ROOT="${1:?usage: launch.sh <run-root>}"
REPO_DIR="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
DATA="$ROOT/data"
mkdir -p "$DATA" "$ROOT/evidence"
[ -f "$REPO_DIR/dist-headless/main/index.js" ] || { echo "missing dist-headless; run pnpm build:headless" >&2; exit 1; }
[ ! -f "$ROOT/server.pid" ] || ! kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null || { echo "server already running for $ROOT" >&2; exit 1; }
cat > "$DATA/config.json" <<JSON
{
  "repoRoots": ["$ROOT/fixture/demo-repo"],
  "windowBounds": null,
  "hooksConsent": "declined",
  "onboarding": { "quest": "done" },
  "claudeCommand": "true",
  "autoUpdateEnabled": false
}
JSON
cd "$REPO_DIR"
HARNESS_DATA_DIR="$DATA" nohup node dist-headless/main/index.js --port 0 --host 127.0.0.1 > "$ROOT/server.log" 2>&1 &
echo $! > "$ROOT/server.pid"
for _ in $(seq 1 100); do
  URL="$(grep -oE 'http://127\.0\.0\.1:[0-9]+/\?token=[a-f0-9]+' "$ROOT/server.log" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$(cat "$ROOT/server.pid")" 2>/dev/null || { echo "server exited; see $ROOT/server.log" >&2; exit 1; }
  sleep 0.2
done
[ -n "${URL:-}" ] || { echo "server did not advertise a URL within 20s; see $ROOT/server.log" >&2; exit 1; }
echo "$URL" > "$ROOT/url"
echo "ready $URL"
