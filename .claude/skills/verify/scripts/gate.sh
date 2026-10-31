#!/usr/bin/env bash
# Staged verification of the ACP chat-agent work (OpenCode + Codex chat,
# bundled runtimes, first-use download, experimental flag).
#
#   gate.sh            static invariants + typecheck + build + tests
#   gate.sh --pack     ... then pnpm run pack (unsigned arm64 app + desktop smoke)
#   gate.sh --download ... then the first-use download smoke (needs network)
#   gate.sh --all      everything above
#
# Prints one PASS/FAIL line per stage and exits non-zero if any stage failed.
set -u
cd "$(git rev-parse --show-toplevel)"

RUN_PACK=0; RUN_DOWNLOAD=0
for arg in "$@"; do
  case "$arg" in
    --pack) RUN_PACK=1 ;;
    --download) RUN_DOWNLOAD=1 ;;
    --all) RUN_PACK=1; RUN_DOWNLOAD=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

LOG_DIR="${VERIFY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/verify-acp-support.XXXXXX")}"
mkdir -p "$LOG_DIR"
RESULTS=()
FAILED=0

stage() {
  local name="$1"; shift
  local log="$LOG_DIR/${name// /-}.log"
  echo "==> $name"
  if "$@" >"$log" 2>&1; then
    RESULTS+=("PASS  $name")
  else
    RESULTS+=("FAIL  $name  (log: $log)")
    FAILED=1
    tail -n 25 "$log" | sed 's/^/    /'
  fi
}

invariants() {
  local ok=0
  check() { if (eval "$2"); then echo "ok    $1"; else echo "BAD   $1"; ok=1; fi; }

  check "experimentalChatAgentsEnabled defaults to false" \
    "grep -q 'experimentalChatAgentsEnabled: false' src/shared/state/settings/constants.ts"
  check "every chat entry point gates on chatRuntimeAvailable" \
    "for f in src/main/index.ts src/renderer/components/TerminalPanel/TerminalPanel.tsx src/renderer/components/MobileApp/MobileApp.tsx src/renderer/components/WorkspaceView/WorkspaceView.tsx; do grep -q chatRuntimeAvailable \"\$f\" || exit 1; done"
  check "PanesFSM takes the gate from main (chatEnabledFor) and Settings reads the flag" \
    "grep -q chatEnabledFor src/main/panes-fsm/panes-fsm.ts && grep -q experimentalChatAgentsEnabled src/renderer/components/Settings/Settings.tsx"
  check "asarUnpack carries no agent runtime packages" \
    "! node -e 'const p=require(\"./package.json\").build.asarUnpack.join(\"\\n\"); process.exit(/opencode|codex|claude-agent-sdk-/.test(p)?0:1)'"
  check "afterPack hook is wired" \
    "grep -q '\"afterPack\": \"scripts/electron-after-pack.mjs\"' package.json"
  check "runtime manifest is gitignored" \
    "grep -qx 'resources/runtime-manifest.json' .gitignore"
  check "build regenerates the runtime manifest first" \
    "node -e 'process.exit(require(\"./package.json\").scripts.build.startsWith(\"node scripts/gen-runtime-manifest.mjs\")?0:1)'"
  check "mac, linux and release workflows run both smokes" \
    "for w in build-mac build-linux release; do grep -q smoke-packed-desktop.mjs .github/workflows/\$w.yml && grep -q smoke-runtime-download.mjs .github/workflows/\$w.yml || exit 1; done"
  check "runtime manifest regenerates offline from lockfile hashes" \
    "RUNTIME_MANIFEST_OFFLINE=1 node scripts/gen-runtime-manifest.mjs && node -e 'const m=require(\"./resources/runtime-manifest.json\"); const ps=Object.keys(m.runtimes); if(ps.length!==4) throw new Error(\"platforms: \"+ps); for(const p of ps) for(const k of [\"opencode\",\"codex\"]) if(!/^sha512-/.test(m.runtimes[p][k].integrity)) throw new Error(p+\" \"+k)'"
  return $ok
}

stage "static invariants" invariants
stage "typecheck" pnpm typecheck
stage "build" pnpm build
stage "unit tests" npx vitest run
if [ "$RUN_PACK" = 1 ]; then
  stage "pack + desktop runtime smoke" pnpm run pack
fi
if [ "$RUN_DOWNLOAD" = 1 ]; then
  stage "first-use download smoke" node scripts/smoke-runtime-download.mjs
fi

echo
echo "Results (logs in $LOG_DIR):"
printf '  %s\n' "${RESULTS[@]}"
exit $FAILED
