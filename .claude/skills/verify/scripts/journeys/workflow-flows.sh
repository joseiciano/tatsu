#!/usr/bin/env bash
# Runs scripts/browser-smoke.mjs (the smoke's browser leg: hang -> close step
# tab -> Cancel step -> Needs you; exit-no-complete -> overlay -> Mark done;
# repo definition -> trust panel -> Trust -> Start -> step strip) against a verify instance. Screenshots and journal go to
# $EVIDENCE/workflow-flows/.
#
# Usage: workflow-flows.sh <state.env>
set -euo pipefail
# shellcheck disable=SC1090
. "$1"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd -P)"
if command -v curl >/dev/null 2>&1; then CURL=yes; else CURL=no; fi
node "$REPO/scripts/browser-smoke.mjs" "${URL##*token=}" "$PORT" "$WORKTREE" "$EVIDENCE/workflow-flows" "$CURL"
