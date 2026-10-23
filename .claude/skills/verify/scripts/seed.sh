#!/usr/bin/env bash
# Seed the sandbox HOME with every harness root Tatsu resolves, plus a few
# resources the feature journeys rely on.
#
# Usage: seed.sh <sandbox-home> <scratch-dir>
set -euo pipefail

H="$1"
SCRATCH="$2"

mkdir -p \
  "$H/.claude/agents" "$H/.claude/skills" "$H/.claude/commands" \
  "$H/.codex" "$H/.agents/skills" \
  "$H/.config/opencode/agents" "$H/.config/opencode/skills" "$H/.config/opencode/commands"

skill() {
  mkdir -p "$1/$2"
  printf -- '---\nname: %s\ndescription: %s\n---\n\n%s\n' "$2" "$3" "$4" > "$1/$2/SKILL.md"
}

skill "$H/.claude/skills" hello "Greet the user by name." "Say hello to the user."
skill "$H/.agents/skills" hello "Greet the user by name." "Say hello to the user."
skill "$H/.config/opencode/skills" release-notes "Draft release notes from git log." "Read git log since the last tag and draft release notes."

printf -- '---\ndescription: Run the test suite\n---\n\nRun the project tests and summarize failures.\n' \
  > "$H/.claude/commands/run-tests.md"
printf -- '---\ndescription: Run the test suite\n---\n\nRun the project tests and summarize failures.\n' \
  > "$H/.config/opencode/commands/run-tests.md"
printf -- '---\nname: reviewer\ndescription: Reviews diffs for bugs.\n---\n\nReview the diff for correctness bugs.\n' \
  > "$H/.claude/agents/reviewer.md"

# Symlinked resource: Step 17 shows it read-only and refuses writes to it.
DOTFILES="$SCRATCH/dotfiles/skills"
skill "$DOTFILES" linked-skill "Lives in a dotfiles repo." "Symlinked skill fixture."
ln -s "$DOTFILES/linked-skill" "$H/.claude/skills/linked-skill"

# Import source for Step 22: an existing file-based template setup.
IMPORT="$SCRATCH/import-source"
skill "$IMPORT/skills" deploy-check "Check a deploy is healthy." "Hit the health endpoint and report."
mkdir -p "$IMPORT/commands"
printf -- '---\ndescription: Summarize a PR\n---\n\nSummarize the open pull request.\n' > "$IMPORT/commands/pr-summary.md"
