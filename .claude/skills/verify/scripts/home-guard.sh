#!/usr/bin/env bash
# Read-only fingerprint of the REAL user's harness roots, so a run can prove
# the sandbox held. Never writes anywhere but stdout.
#
# Usage: home-guard.sh snapshot            > before.txt
#        home-guard.sh check <before.txt>   (exit 1 and print a diff if changed)
set -euo pipefail

REAL_HOME="$(dscl . -read "/Users/$(id -un)" NFSHomeDirectory 2>/dev/null | awk '{print $2}')"
REAL_HOME="${REAL_HOME:-$(getent passwd "$(id -un)" 2>/dev/null | cut -d: -f6)}"

snapshot() {
  for root in \
    "$REAL_HOME/.claude/agents" "$REAL_HOME/.claude/skills" "$REAL_HOME/.claude/commands" \
    "$REAL_HOME/.agents/skills" \
    "$REAL_HOME/.config/opencode/agents" "$REAL_HOME/.config/opencode/skills" "$REAL_HOME/.config/opencode/commands"; do
    [ -e "$root" ] || { echo "absent $root"; continue; }
    find "$root" -maxdepth 3 \( -type f -o -type l \) -name '*.md' -print0 2>/dev/null \
      | xargs -0 stat -f '%m %z %N' 2>/dev/null || true
  done
  find "$REAL_HOME/.codex" -maxdepth 1 -type f -name '*.md' -print0 2>/dev/null \
    | xargs -0 stat -f '%m %z %N' 2>/dev/null || true
}

case "${1:-}" in
  snapshot) snapshot | sort ;;
  check)
    if diff <(cat "$2") <(snapshot | sort); then
      echo "real harness roots unchanged"
    else
      echo "REAL harness roots changed during the run (diff above). Check whether this run or another session wrote them." >&2
      exit 1
    fi
    ;;
  *) echo "usage: home-guard.sh snapshot | check <before.txt>" >&2; exit 2 ;;
esac
