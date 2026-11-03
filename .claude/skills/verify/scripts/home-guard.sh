#!/usr/bin/env bash
# Read-only fingerprint of the REAL user's agent config files that Tatsu's
# hook installer writes, so a run can prove the sandbox held.
#
# Usage: home-guard.sh snapshot            > before.txt
#        home-guard.sh check <before.txt>   (exit 1 and print a diff if changed)
set -euo pipefail

REAL_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
REAL_HOME="${REAL_HOME:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)}"

snapshot() {
  for f in \
    "$REAL_HOME/.claude/settings.json" \
    "$REAL_HOME/.codex/hooks.json" \
    "$REAL_HOME/.pi/agent/extensions/harness-status.ts" \
    "$REAL_HOME/.config/opencode/plugins/harness-status.js"; do
    if [ -e "$f" ]; then stat -f '%m %z %N' "$f"; else echo "absent $f"; fi
  done
}

case "${1:-}" in
  snapshot) snapshot | sort ;;
  check)
    if diff <(cat "$2") <(snapshot | sort); then
      echo "real agent config files unchanged"
    else
      echo "REAL agent config files changed during the run (diff above). Check whether this run or another session wrote them." >&2
      exit 1
    fi
    ;;
  *) echo "usage: home-guard.sh snapshot | check <before.txt>" >&2; exit 2 ;;
esac
