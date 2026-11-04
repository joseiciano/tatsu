#!/usr/bin/env bash
# Runs scripts/browser-smoke.mjs (the smoke's browser leg: hang -> close step
# tab -> Cancel step -> Needs you; hang -> palette -> Workflows section run
# card -> Cancel run; exit-no-complete -> overlay -> Mark done;
# repo definition -> trust panel -> Trust -> Start -> step strip; palette
# Run workflow… -> preset sheet; New Worktree with a Workflow -> preset sheet
# on a shell-only worktree; Workflows
# section -> Run workflow… -> New worktree -> Start -> new worktree selected
# with a step strip) against a verify instance. Screenshots and journal go to
# $EVIDENCE/workflow-flows/.
#
# Usage: workflow-flows.sh <state.env>
set -euo pipefail
# shellcheck disable=SC1090
. "$1"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd -P)"
if command -v curl >/dev/null 2>&1; then CURL=yes; else CURL=no; fi
HARNESS_DATA_DIR="$DATA_DIR" node "$REPO/scripts/browser-smoke.mjs" "${URL##*token=}" "$PORT" "$WORKTREE" "$EVIDENCE/workflow-flows" "$CURL"
