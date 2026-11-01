#!/usr/bin/env bash
# Build a disposable repo whose feature worktree differs from main in every way the code diff tool classifies.
# Usage: fixture.sh <run-root>
set -euo pipefail
ROOT="${1:?usage: fixture.sh <run-root>}"
FX="$ROOT/fixture"
mkdir -p "$FX"
export GIT_AUTHOR_NAME=verify GIT_AUTHOR_EMAIL=verify@example.invalid
export GIT_COMMITTER_NAME=verify GIT_COMMITTER_EMAIL=verify@example.invalid
g() { git -c init.defaultBranch=main -c commit.gpgsign=false "$@"; }

g init -q --bare "$FX/origin.git"
g init -q "$FX/demo-repo"
cd "$FX/demo-repo"
printf 'line one\nline two\nline three\n' > keep.txt
printf 'old content\n' > modify-me.txt
printf 'going away\n' > delete-me.txt
printf 'alpha\nbeta\ngamma\ndelta\nepsilon\n' > rename-me.txt
mkdir -p src && printf 'export const a = 1\n' > src/index.ts
g add -A && g commit -qm "base"
g remote add origin "$FX/origin.git"
g push -q -u origin main
g remote set-head origin main

g worktree add -q -b feature/diff-demo "$FX/demo-feature" main
cd "$FX/demo-feature"
printf 'new content\nsecond line\n' > modify-me.txt
g rm -q delete-me.txt
g mv rename-me.txt renamed.txt
printf 'export const b = 2\n' > src/added.ts
printf '\x00\x01\x02binary' > blob.bin
mkdir -p tests src/components src/api
printf 'test("x", () => {})\n' > tests/added.test.ts
printf '{"name":"demo"}\n' > config.json
printf 'export const Button = () => null\n' > src/components/Button.tsx
printf 'export const routes = []\n' > src/api/routes.ts
g add -A && g commit -qm "feature work"
printf 'line one\nline two CHANGED\nline three\n' > keep.txt
printf 'scratch\n' > untracked.txt

# Advance origin/main from a second clone so the Fetch button has something to pull.
g clone -q "$FX/origin.git" "$FX/upstream-clone"
cd "$FX/upstream-clone"
printf 'upstream\n' > upstream.txt
g add -A && g commit -qm "upstream change" && g push -q origin main
g -C "$FX/demo-repo" tag v0.1.0 main

# A branch with no shared history, for the "share no history" error state.
cd "$FX/demo-repo"
g checkout -q --orphan unrelated
g rm -rq --cached . && printf 'orphan\n' > orphan.txt && g add orphan.txt && g commit -qm "orphan root"
g checkout -q -f main
git clean -fdq

echo "repo=$FX/demo-repo"
echo "worktree=$FX/demo-feature"
echo "upstream_sha=$(git -C "$FX/upstream-clone" rev-parse HEAD)"
