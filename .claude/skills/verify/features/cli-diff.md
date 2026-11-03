# CLI diff

`tatsu diff [<worktree>] [--base <ref>] [--file <path> | --patch]` lists what a worktree changed against a base ref, or prints unified patches of it, the same comparison the GUI's code diff tool makes: the worktree's end state (committed, uncommitted and untracked) against the merge base. It resolves the worktree from the argument or the cwd, takes the base from `--base` or the backend's `worktree:defaultCompareRef`, and calls `worktree:codeDiffFiles`. For patches it then calls `worktree:codeDiffFileSides` once per file, in list order, and builds each patch locally with the `diff` package. It never runs git locally.

## Sub-features

- `diff-resolve` the worktree is a positional branch name (wins), else any path equal to or inside a `worktrees.list` path (deepest match; realpath when it exists locally), else `process.cwd()`. Every request sends the stored `worktrees.list` path.
- `diff-base` `--base <ref>` is sent verbatim; without it the CLI asks `worktree:defaultCompareRef` (fixture: `refs/remotes/origin/main`). The output shows the server-resolved ref (`--base main` → `refs/heads/main`).
- `diff-json` `--json` prints `{worktree, baseRef, mergeBase, headRef, dirty, totals: {files, additions, deletions}, files}`; `files` are the server's `CodeDiffFile` objects.
- `diff-human` a header `<branch> vs <baseRef> (merge base <7-char sha>)` with ` · uncommitted changes` when dirty, one row per file (`A M D R ?`, `+N -M` or `-` for binary, path or `old → new`), then `N files changed, +X -Y` (`(showing N)` when the server capped the list); `No changes against <baseRef>.` when nothing differs.
- `diff-patch` `--file <path>` (matches a listed `path` or `previousPath`) or `--patch` (every listed file) prints only patches, no file list. Headers are bare `--- a/<old>` / `+++ b/<new>` (`/dev/null` for added/untracked old side and deleted new side; no `Index:`/`===` lines). Binary: `Binary files <old> and <new> differ`. Large files: the CLI header, then the server's `large.patch` hunks, or `<path>: too large to diff`. A rename with identical content is a header with no hunks. `--json` adds `patch` to each file (`--file` narrows `files` to the matched one; `totals` stay the whole list).
- `diff-patch-errors` `--file` not in the list, `--file` with `--patch`, or an empty `--file` exits 2. A sides `error` makes that file `patch: null, patchError` (JSON); the other patches still print to stdout, then the command exits 1 `command-failed` with `details.failed: [{path, error}]` and stderr `tatsu: <path>: <error>` (several: `tatsu: N files failed to diff:` then one `<path>: <error>` line each). Stdout survives the error through `output.result(..., {keepOnError: true})`.
- `diff-errors` `invalid-ref` exits 1 `invalid base ref '<ref>'`; `no-merge-base` exits 1 `no merge base between <branch> and <ref>`; an unmatched worktree exits 2 `usage` with `details.worktrees` ([{path, branch}]); a second positional or empty `--base` exits 2.

## How to get to it (user POV)

- From a shell anywhere inside a worktree: `tatsu diff` (`pnpm tatsu diff` in this repo, which runs `node dist-headless/cli/index.js`).
- From anywhere: `tatsu diff <branch|path> [--base <ref>] [--json]`.
- It finds the backend the same way as `tatsu status` (see [cli-status.md](cli-status.md)).

## Driving it

Preconditions:

- `pnpm build:headless` ran after the last source change (it builds the CLI too).
- `RUN` is a fresh directory under your scratchpad (a `/private/tmp/...` realpath, so `repoRoots` and `git worktree list` spell paths the same). `ROOT="$PWD"` at the repo root.
- `trap '.claude/skills/verify/scripts/code-diff/cleanup.sh "$RUN"' EXIT`, then `fixture.sh "$RUN"`, `launch.sh "$RUN"`, and `doctor.sh "$RUN"` prints only `ok` lines (see [`../code-diff.md`](../code-diff.md)).
- `launch.sh` sets no sandbox HOME; the server writes `cli-endpoint.json` into `$RUN/data`, so discovery by data dir works:
  `CLI() { env -u TATSU_ENDPOINT_FILE -u TATSU_URL -u TATSU_TOKEN HARNESS_DATA_DIR="$RUN/data" node "$ROOT/dist-headless/cli/index.js" "$@"; }`
- Poll `CLI worktrees --json` until it has a `feature/diff-demo` row; `worktrees.list` fills after boot.

### Steps

- **File set.** `CLI diff feature/diff-demo --base main --json` exits 0. `{path: status}` equals: `modify-me.txt`, `keep.txt` modified; `delete-me.txt` deleted; `renamed.txt` renamed from `rename-me.txt`; `src/added.ts`, `blob.bin`, `tests/added.test.ts`, `config.json`, `src/components/Button.tsx`, `src/api/routes.ts` added; `untracked.txt` untracked. `totals` = `{files: 11, additions: 9, deletions: 3}`, the per-file sums. `dirty: true`, `worktree` = the stored `demo-feature` path.
- **Human.** `CLI diff feature/diff-demo --base main` prints `feature/diff-demo vs refs/heads/main (merge base <sha>) · uncommitted changes`, 11 rows (`A  -      blob.bin`, `R  +0 -0  rename-me.txt → renamed.txt`, …) and `11 files changed, +9 -3`.
- **Default base.** `CLI diff feature/diff-demo` uses `refs/remotes/origin/main`, exit 0.
- **Invalid base.** `CLI diff feature/diff-demo --base nope` exits 1, `tatsu: invalid base ref 'nope'` (JSON: `code: "command-failed"`).
- **No merge base.** `--base unrelated` (the fixture's orphan branch) exits 1, `no merge base between feature/diff-demo and refs/heads/unrelated`.
- **Unknown worktree.** `CLI diff nope --json` exits 2; stderr `{"error":{"code":"usage","message":"no worktree matches 'nope'","details":{"worktrees":[...both fixture worktrees...]}}}`.
- **cwd default.** `(cd "$RUN/fixture/demo-feature/src" && CLI diff --base main --json)` resolves to `demo-feature` (11 files); `(cd "$RUN/fixture/demo-repo" && CLI diff --base main)` prints `No changes against refs/heads/main.`; `(cd / && CLI diff)` exits 2 with `tatsu: current directory is not inside a known worktree; pass <worktree>` (`details.worktrees` kept in JSON).
- **Patch applies.** `CLI diff feature/diff-demo --base main --file modify-me.txt > "$RUN/modify.patch"` exits 0. `git clone -q "$RUN/fixture/demo-repo" "$RUN/clone"`, `git -C "$RUN/clone" checkout -q --detach <mergeBase from --json>`, then `git -C "$RUN/clone" apply --check "$RUN/modify.patch"` exits 0.
- **Rename by old name.** `--file rename-me.txt` prints `--- a/rename-me.txt` / `+++ b/renamed.txt` and nothing else (identical content).
- **All patches.** `CLI diff feature/diff-demo --base main --patch | grep -cE '^(--- |Binary files )'` prints `11`. List order: the `+++ ` paths (`/dev/null` for `delete-me.txt`) and the `Binary files` new name read `blob.bin config.json /dev/null keep.txt modify-me.txt renamed.txt src/added.ts src/api/routes.ts src/components/Button.tsx tests/added.test.ts untracked.txt`, the `--json` files order. The whole output also passes `git apply --check` at the merge base, but without `diff --git` headers git skips the `Binary files` line and the hunkless rename, so that is not proof a rename or binary change applies. Without `--base` (`refs/remotes/origin/main`) and with `--base v0.1.0`, `--patch` also prints 11 headers, matching `--json`.
- **Patch usage errors.** `--file unlisted.txt` exits 2 `tatsu: 'unlisted.txt' is not in the changed files. …`; `--file x --patch` exits 2 `tatsu: --file and --patch cannot be used together. …`.
- **Patch JSON.** `--patch --json` exits 0; all 11 files have a non-empty `patch`, none has `patchError`.
- **Teardown.** `cleanup.sh "$RUN"` (the trap does it).

Last run: ticket diff-02 (tatsu-cli/diff-02-patches), every step above passed.

## Gotchas

- The partial-failure path (a sides `error`) has no fixture trigger; it is unit-tested only (`diff.test.ts`).

- Run the binary with `node`, not `pnpm -s tatsu`: `pnpm -s` collapses every non-zero exit to 1.
- Don't assert `baseRef` is `main`: the server returns the resolved full ref (`refs/heads/main`).
- The server's `isKnownWorktree` uses strict path equality; a request with a `/tmp/...` spelling of a `/private/tmp/...` worktree comes back `unknown-worktree` (and `defaultCompareRef` silently falls back to `HEAD`). The CLI always sends the stored path; a run root outside the scratchpad can still skew `repoRoots` vs `git worktree list` spellings.
- `fixture.sh` prints SHAs; redact 32+ hex runs before saving a transcript (`sed -E 's/[a-f0-9]{32,}/<redacted>/g'`), which also hides the token.
- Inside a Tatsu terminal `TATSU_ENDPOINT_FILE` points at your real backend; `CLI` unsets it.
