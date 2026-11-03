# Sourced by scripts/smoke-headless.sh and .claude/skills/verify/scripts/launch.sh.
#
# smoke_sandbox <scratch> <repo-dir> <repo-roots:yes|no>
#
# Exports an isolated environment under <scratch>: the server installs agent
# hooks into $HOME, the boot PATH probe and every tab run `$SHELL -ilc`, and
# snapshot commits need a git identity, so HOME/ZDOTDIR/XDG_CONFIG_HOME/
# CODEX_HOME move into scratch and SHELL is bash. Writes the fake `claude`
# shim (scripts/fake-agent.mjs), a git repo at <scratch>/repo, config.json
# (shim as claudeCommand, hooks accepted, Labs workflows on; the repo in
# repoRoots when asked) and the personal workflow definitions. Sets WORKTREE
# and CLAUDE_SHIM.

smoke_sandbox() {
  local scratch="$1" repo_dir="$2" add_root="$3"
  local node_bin
  node_bin="$(command -v node)"

  export HARNESS_DATA_DIR="$scratch/data"
  export HOME="$scratch/home"
  export ZDOTDIR="$HOME"
  export XDG_CONFIG_HOME="$HOME/.config"
  export CODEX_HOME="$HOME/.codex"
  export SHELL=/bin/bash
  export BASH_SILENCE_DEPRECATION_WARNING=1
  export GIT_AUTHOR_NAME="Tatsu Smoke" GIT_AUTHOR_EMAIL="smoke@example.invalid"
  export GIT_COMMITTER_NAME="Tatsu Smoke" GIT_COMMITTER_EMAIL="smoke@example.invalid"
  export FAKE_AGENT_LOG="$scratch/fake-agent.log"
  unset CLAUDE_CONFIG_DIR CLAUDE_CODE_SANDBOXED OPENCODE_CONFIG_DIR
  mkdir -p "$HARNESS_DATA_DIR/workflows" "$HOME" "$scratch/bin"

  # An absolute path, because the login shell may reorder PATH.
  CLAUDE_SHIM="$scratch/bin/claude"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$node_bin" "$repo_dir/scripts/fake-agent.mjs" > "$CLAUDE_SHIM"
  chmod +x "$CLAUDE_SHIM"

  mkdir -p "$scratch/repo"
  git -C "$scratch/repo" init -q -b main
  printf 'smoke\n' > "$scratch/repo/README.md"
  git -C "$scratch/repo" add README.md
  git -C "$scratch/repo" commit -q -m init
  WORKTREE="$(git -C "$scratch/repo" rev-parse --show-toplevel)"

  "$node_bin" -e '
const fs = require("fs")
const [home, dataDir, worktree, shim, addRoot] = process.argv.slice(1)
fs.writeFileSync(`${home}/.claude.json`, JSON.stringify({ projects: { [worktree]: { hasTrustDialogAccepted: true } } }))
fs.writeFileSync(`${dataDir}/config.json`, JSON.stringify({
  repoRoots: addRoot === "yes" ? [worktree] : [],
  claudeCommand: shim,
  hooksConsent: "accepted",
  hooksMigratedToGlobal: true,
  labs: { workflows: true },
  workflowSettings: { maxConcurrentAgents: 1 }
}))
' "$HOME" "$HARNESS_DATA_DIR" "$WORKTREE" "$CLAUDE_SHIM" "$add_root"

  cat > "$HARNESS_DATA_DIR/workflows/smoke.yaml" <<'YAML'
name: smoke
steps:
  - id: plan
    agent: claude
    permissions: read-only
    prompt: "Reply PLAN-OK and call complete_step."
  - id: echo
    kind: shell
    run: echo {{steps.plan.summary}}
YAML
  cat > "$HARNESS_DATA_DIR/workflows/smoke-retry.yaml" <<'YAML'
name: smoke-retry
steps:
  - id: check
    kind: shell
    run: test -f flag
YAML
  cat > "$HARNESS_DATA_DIR/workflows/smoke-full.yaml" <<'YAML'
name: smoke-full
steps:
  - id: plan
    agent: claude
    permissions: full
    prompt: "This must never start without allowFull."
YAML
  cat > "$HARNESS_DATA_DIR/workflows/browser-hang.yaml" <<'YAML'
name: browser-hang
steps:
  - id: hang
    agent: claude
    permissions: read-only
    prompt: "FAKE_AGENT_MODE=hang Stay alive and never call complete_step."
YAML
  cat > "$HARNESS_DATA_DIR/workflows/browser-exit.yaml" <<'YAML'
name: browser-exit
steps:
  - id: exit
    agent: claude
    permissions: read-only
    prompt: "FAKE_AGENT_MODE=exit-no-complete Exit without calling complete_step."
YAML
}
