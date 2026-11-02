# Code diff tool plan

## Goal

Add a built-in code diff tool. It compares one worktree's end state (commits + staged + unstaged + untracked) against a base ref that the user selects. The default base is `origin/main`. A "Fetch" button updates it on demand.

First ship:

- open from `ChangedFilesPanel`, a hotkey, and the command palette
- base-ref combobox (local branches, remote branches, tags, typed refs)
- one file list: every file that differs between the merge-base and the worktree
- grouping by change type, switchable to grouping by directory
- Monaco side-by-side diff for the selected file
- live refresh while the user or an agent edits files
- gated behind `ENABLE_CODE_DIFF` until Phase 5 ships

## Non-goals

- No comparison of two arbitrary refs. The modified side is always the worktree.
- No shared state for the selected base ref. It is per-client UI state.
- No review comments, "reviewed" tracking, or "send to agent". That is `ReviewScreen`.
- No commit composer, PR submission, or remote sharing.
- No agent-generated walkthrough ("chapters"). Possible v1.1, see Future work.

## Current codebase map

Facts checked against the code on 2026-10-23.

### Git helpers (`src/main/worktree/worktree.ts`)

- `listBranches(repoRoot)` (`:171`) — `git branch -a --format=%(refname:short)`. Local + remote, no tags.
- `getDefaultBaseRef(worktreePath)` (`:330`) — `origin/HEAD` symbolic ref → `origin/main` → `origin/master` → `main` → `master` → `HEAD`.
- `fetchPullRequestRef` (`:123`) — only existing `git fetch` call. No timeout, no `GIT_TERMINAL_PROMPT=0`.
- `getChangedFiles` (`:528`) / `getFileDiffSides` (`:870`) — existing working/branch modes used by `ReviewScreen`. Branch mode hard-codes `modifiedBinary: false`.
- `getFileAtRef` (`:840`, private) — `git show <ref>:<path>`, `maxBuffer` 16 MiB. Throws above that; callers treat it as "file missing".
- `readWorktreeFile` (`:1243`) — rejects paths that escape the worktree, caps reads at `MAX_FILE_READ_BYTES` (2 MiB, `constants.ts:1`), sniffs the first 8 KiB for NUL. Returns `{content, size, binary, truncated, error}`. Uses `statSync`, so it follows symlinks: a symlink is read as its target's contents, and a symlink that points outside the worktree passes the path check.

### Types

- `ChangedFile` (`src/main/worktree/types.ts:28`, copy in `src/renderer/types/types.ts`) — `path`, `status`, `staged`, `additions?`, `deletions?`. Status union: `added | modified | deleted | renamed | untracked`.
- `FileDiffSides` (`src/main/worktree/types.ts:62`) — only `modifiedBinary`. No `originalBinary`, size, or truncation fields.
- `src/shared/code-diff/` (new, uncommitted) — `CodeDiffFile`, `CodeDiffFileList`, `ValidateRefResult`, `BranchForCompare`, `CodeDiffSides`. `index.ts` and `code-diff.ts` define the types twice and disagree. Fix in Phase 1.

### Watching

- `WorktreeWatcher` (`src/main/worktree-watcher/worktree-watcher.ts`) — watches `join(worktreePath, '.git')` for `index`, `HEAD`, `MERGE_HEAD`. **Bug:** in a linked worktree `.git` is a file (`gitdir: <common>/worktrees/<name>`), so nothing fires. Every Tatsu-created worktree falls back to the 60 s poll.
- `main/index.ts:1185` — `worktree:watchChangedFiles` signal subscribes the client; the watcher emits `worktree:changedFilesInvalidated`.
- `useWatchedQuery` (`src/renderer/hooks/useWatchedQuery/useWatchedQuery.ts:57`) — options `{worktreePath, cacheKey, fetcher, fallbackPollMs = 60000}`. Module-level cache `Map<cacheKey, Map<worktreePath, T>>`, LRU 100 per key. Refetches on `changedFilesInvalidated` and on the fallback interval. Discards stale responses with `currentPathRef`, which compares the worktree path only. `fetcher` is a dependency of `refresh`, so an unmemoized fetcher refetches and re-subscribes on every render. The interval does not wait for an in-flight request and keeps running while the window is hidden.

### Transport

- Handlers in `src/main/index.ts` (e.g. `worktree:changedFiles` at `:1181`). They do not check that `worktreePath` is a known worktree.
- `src/renderer/build-backend/build-backend.ts:95` — `api` object is written by hand (`req('worktree:branches', …)`) and typed `any`. A method missing here fails only at runtime.
- `src/renderer/types/types.ts` — `ElectronAPI` interface.

### Renderer

- `ReviewScreen` — modes `working`, `branch`, `commit`. No base-ref selector.
- `ReviewFileTree` — `groupAndSortFiles()` (`:45`, not exported); j/k and [/] on a global `window` keydown handler (`:159`).
- `ReviewDiffPane` — binary text `Binary file — cannot display diff` (`:425`).
- `MonacoDiffEditor` — `src/renderer/components/MonacoDiffEditor/`.
- `ChangedFilesPanel` — Review button (`:65`), `actions` slot on `RightPanel` (`:94`).
- `App.tsx` — `showReview` state (`:231`), full-screen `ReviewScreen` block (`:1537`). Same `App` runs in the web client (`src/web-client/main.tsx:92`).
- Hotkeys — `src/renderer/hotkeys/constants.ts`, user-overridable through the settings slice. `Cmd+Shift+D` = split pane down, `Cmd+Alt+P` = perf HUD, `Cmd+Shift+C` free.
- Feature flags — `src/shared/constants/constants.ts:11`.
- `lucide-react` 1.17.0 exports `GitCompareArrows`.

### Tests

- Vitest runs in the default `node` environment. No jsdom. Renderer tests only cover pure modules.

## Architecture decisions

1. **Merge-base vs working tree, in one diff.** `mergeBase = git merge-base <baseRef> HEAD`, then `git diff <mergeBase>` (no second ref) compares the merge-base tree to the working tree. This folds committed, staged, and unstaged changes into one net result. Separate committed/staged/unstaged diffs give wrong results when a committed change is reverted in the working tree.
2. **Default base: `origin/main`, fetch on demand.** Local `main` is often stale (this worktree's local `main` is 121 commits behind `origin/main`), so it is last in the chain: `origin/main` → `getDefaultBaseRef` chain. No network call on open. A fetch rarely changes the result: new commits on `origin/main` after the branch point do not move the merge-base. It also shares the common `.git` with agents in other worktrees and can hit ref-lock errors. So fetching is a "Fetch" button in the summary bar, shown only when the base is a remote-tracking ref:
   - `git fetch --no-tags origin <branch>`, `timeout: 15000`, `GIT_TERMINAL_PROMPT=0`, and `GIT_SSH_COMMAND` set to `ssh -o BatchMode=yes` unless the user already set `GIT_SSH_COMMAND` / `core.sshCommand`.
   - One in-flight fetch per `repoRoot + branch` in main; a second call joins the first.
   - Any failure (offline, no remote, auth, `cannot lock ref`) returns `{ok: false, error}`. The UI shows "Fetch failed — comparing against last fetched `<ref>`" and keeps the current list.
   - On success, refresh the file list.
3. **Types live in `src/shared/code-diff/`.** The renderer cannot import from `src/main`. `src/main/worktree/types.ts` re-exports them. `CodeDiffFile` is a separate type, not `extends ChangedFile`, because `staged` has no meaning against a merge-base.
4. **Modified side: `lstat` first, then `readWorktreeFile`.** `readWorktreeFile` gives path containment, the 2 MiB cap, binary sniffing, and truncation, but follows symlinks. For a symlink, the modified side is the `readlink` output (what git stores as the blob), and the target is never read.
5. **Original side: `git cat-file`, size-capped.** `git cat-file -s <mergeBase>:<path>` gives the size. At or below 2 MiB, read it with `git cat-file blob`. Above, stream `git cat-file blob` with `spawn`, stop after 2 MiB, kill the process, and set `truncated: true`. Same 8 KiB NUL sniff as the modified side, so both sides report `binary`, `truncated`, `size` the same way. This replaces the 16 MiB `maxBuffer` behavior, which reports large files as missing.
   - **Large files show hunks, not truncated sides.** When either side is over 2 MiB or over `CODE_DIFF_MAX_EDITOR_LINES` (20,000 lines), `original` and `modified` are sent empty and `large.patch` carries `git diff -U3 <mergeBase> -- [previousPath] <path>` from its first `@@`, read with `maxBuffer` `CODE_DIFF_MAX_PATCH_BYTES` (512 KiB). Over that cap, or when one side is missing (added, untracked, deleted), `large.patch` is `null`. Truncating each side separately hid changes past the cut and showed a fake change on the last line.
6. **Refresh = fixed watcher + active-view poll.** The fixed `WorktreeWatcher` covers commit, stage, checkout, merge (a commit rewrites `<gitdir>/index`, tested on git 2.52). While the tool is open and the window is visible, `useWatchedQuery` runs with `fallbackPollMs: 3000`. Rules:
   - The fetcher is wrapped in `useCallback` keyed on `baseRef`, so it is stable between renders.
   - `refresh` skips a call while the previous one is in flight (hook change).
   - The poll pauses while `document.visibilityState === 'hidden'` (hook change).
   - `CodeDiffTool` drops any result whose `baseRef` is not the current `baseRef`; the hook's path check cannot catch a base-ref switch.
   - Each `CodeDiffFile` carries `mtimeMs` from `lstat`. The open diff pane reloads its sides only when the selected file's `mtimeMs`, `additions`, or `deletions` changes. This catches edits to an already-modified file without re-sending up to 4 MiB every 3 s.
7. **Refs are untrusted input, and only full refs reach git.** Reject refs that start with `-` or contain `..`, whitespace, or control characters. Put `--end-of-options` before refs where git supports it. `validateRef` returns the full ref name it resolved (`refs/tags/x`, `refs/heads/x`, `refs/remotes/origin/x`, or a full sha), and every later command uses that string. When a name is both a branch and a tag, git picks the tag (tested), so a short name could make the label and the diff disagree.
8. **No new slice.** Base ref, selected file, group mode, and loading state are per-client UI state (a second client may compare against a different base).
9. **Logic in pure modules.** Name-status parsing, numstat parsing, grouping, and default-ref selection live in pure functions with node-environment tests. No jsdom setup for this feature.

## Product behavior

### Entry points

1. `ChangedFilesPanel` — "Diff" button with `GitCompareArrows` next to Review. Shown when branch files or working files exist.
2. Hotkey `toggleCodeDiff`, default `Cmd+Shift+C` (see Open questions). Toggles the tool for the active worktree.
3. Command palette entry "Code diff".

### Base-ref combobox

- Options from `listBranchesForCompare`: local branches, remote branches, tags, each with its `source`.
- Editable. Enter validates through `validateRef`; invalid input shows the error inline and keeps the previous ref.
- "Reset to default" re-runs decision 2.
- Keyboard accessible: arrow keys, Enter, Escape closes the list only.

### Grouping

Change-type groups, first match wins, in this order:

1. **Tests** — `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/`
2. **Config** — `*.json`, `*.yaml`, `*.yml`, `*.toml`, `.env*`, `*.config.*`, dotfiles at repo root
3. **API / routing** — path segment contains `api`, `route`, `controller`, `handler`
4. **Data / models** — path segment contains `model`, `schema`, `migration`, or file named `types.ts` / `types.d.ts`
5. **UI / views** — `*.tsx`, `*.jsx`, `*.css`, `*.scss`, or path segment contains `component`, `view`, `page`
6. **Other**

Directory mode reuses `groupAndSortFiles()` from `ReviewFileTree` (export it).

### States

| State | Behavior |
|---|---|
| Loading | Skeleton while the file list loads |
| Fetching | Fetch button shows a spinner; list stays usable |
| Fetch failed | "Fetch failed — comparing against last fetched `<ref>`" |
| Empty | "No changes between `<baseRef>` and this worktree" |
| Invalid ref | "Ref `<ref>` not found." + "Reset to default" |
| No merge-base | "`<baseRef>` and this branch share no history." + "Reset to default" |
| Too many files | List capped at 2000 entries + "Showing 2000 of N files" |
| Binary file | "Binary file — cannot display diff" (same text as `ReviewDiffPane`) |
| Large file (over 2 MiB or 20,000 lines) | Changed hunks with old/new line numbers + banner "Large file (`<size>`) — showing changed hunks only" |
| Large file, hunks over 512 KiB or file added/deleted | "Large file (`<size>`) — diff too large to display" |
| Renamed / copied | Badge `R` / `C`, label `previousPath → path` |
| Deleted | Badge `D`, full deletion |
| Untracked | Badge `U`, full addition |

### Interaction rules

- Code diff and `ReviewScreen` are mutually exclusive. Opening one closes the other.
- Switching the active worktree while open keeps the tool open and re-runs default resolution for the new worktree (component keyed by `worktreePath`).
- Escape closes the tool only when focus is not inside Monaco, the combobox, or a terminal.

## Implementation phases

Each phase ends with `pnpm typecheck`, `pnpm build`, the listed tests, one commit, and `git push origin code-diff`.

### Phase 0 — prerequisites and checks

Files:

- `src/main/worktree-watcher/worktree-watcher.ts`
- `src/main/worktree-watcher/worktree-watcher.test.ts` (new)

Changes:

1. Add pure `resolveGitDir(worktreePath)`: if `<worktreePath>/.git` is a folder, return it; if it is a file, read `gitdir: <path>` and resolve it relative to the worktree. Watch the returned directory.
2. Unit-test `resolveGitDir` for a normal repo, a linked worktree (`git worktree add`), a relative `gitdir:` path, and a missing `.git`. Do not assert real `fs.watch` events in vitest: macOS event latency makes that flaky. The manual checks cover the real watch.

Manual checks:

- In a linked worktree, `git commit`, `git add`, and `git checkout` each fire `changedFilesInvalidated` (watch `pnpm log`).
- `git --version` on the CI image and a dev machine supports `--end-of-options` for `diff`, `merge-base`, and `show` (git ≥ 2.24).

Acceptance:

- `ChangedFilesPanel` refreshes within 1 s of `git add` in a Tatsu-created worktree.

Commit: `fix(worktree-watcher): resolve gitdir for linked worktrees`

### Phase 1 — backend git functions

Files:

- `src/shared/code-diff/code-diff.ts`, `src/shared/code-diff/index.ts`
- `src/main/worktree/types.ts`
- `src/main/worktree/worktree.ts`
- `src/main/worktree/code-diff-parse.ts` (new, pure parsers + grouping-free helpers)
- `src/main/worktree/code-diff.test.ts`, `src/main/worktree/code-diff-parse.test.ts` (new)

Changes:

1. Make `code-diff.ts` the only definition; `index.ts` only re-exports. Final types:

   ```ts
   export type CodeDiffStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked'

   export interface CodeDiffFile {
     path: string
     status: CodeDiffStatus
     previousPath?: string
     copied?: boolean
     additions?: number
     deletions?: number
     /** Worktree file mtime from lstat; undefined for deleted files. */
     mtimeMs?: number
   }

   export interface CodeDiffFileList {
     files: CodeDiffFile[]
     totalFiles: number
     totalAdditions: number
     totalDeletions: number
     baseRef: string
     mergeBase: string
     headRef: string
     isWorktreeDirty: boolean
     error?: 'invalid-ref' | 'no-merge-base'
   }

   export interface BranchForCompare {
     name: string
     source: 'local' | 'remote' | 'tag'
   }
   ```

   `ValidateRefResult` and `CodeDiffSides` stay as they are.
2. `validateRef(worktreePath, ref)` — reject unsafe input (decision 7), then find the full ref in git's own lookup order: `<ref>` if it starts with `refs/`, else the first of `refs/<ref>`, `refs/tags/<ref>`, `refs/heads/<ref>`, `refs/remotes/<ref>`, `refs/remotes/<ref>/HEAD` that `git show-ref --verify --quiet` accepts. Confirm it with `git rev-parse --verify --quiet <fullRef>^{commit}`. If no candidate matches, try `git rev-parse --verify --quiet <ref>^{commit}` (sha, `HEAD~2`) and use the full sha. Type: `refs/heads/` or `refs/remotes/` → `branch`, `refs/tags/` → `tag`, sha → `commit`. (`rev-parse --symbolic-full-name` is not usable: it errors on a name that is both a branch and a tag — tested.) Callers use the returned `ref` for every later command.
3. `listBranchesForCompare(worktreePath)` — `git for-each-ref --format=%(refname) refs/heads refs/remotes refs/tags`, map to `BranchForCompare`, drop `refs/remotes/*/HEAD`.
4. `resolveDefaultCompareRef(worktreePath)` — `origin/main` → `getDefaultBaseRef`. Returns `{ref, fetchable}`; `fetchable` is true for `refs/remotes/origin/*`.
5. `fetchCompareRef(worktreePath, ref)` — only for `refs/remotes/origin/<branch>`. Runs the fetch from decision 2 (timeout, no prompts, SSH `BatchMode`, one in-flight fetch per repo + branch). Returns `{ok, error?}`; never throws.
6. `getCodeDiffFiles(worktreePath, baseRef)`:
   1. `validateRef`; on failure return `error: 'invalid-ref'`. Use the returned full ref from here on.
   2. `git merge-base <fullRef> HEAD`; exit 1 → `error: 'no-merge-base'`.
   3. `git diff --name-status -z --find-renames --find-copies <mergeBase>`.
   4. `git diff --numstat -z --find-renames --find-copies <mergeBase>`.
   5. `git ls-files --others --exclude-standard -z` for untracked files.
   6. Merge by `path`; diff entries win.
   7. `lstat` every listed file that exists on disk → `mtimeMs`. For untracked regular text files ≤ 2 MiB, count lines → `additions`.
   8. `headRef` = `git rev-parse --abbrev-ref HEAD` (`HEAD` when detached). `isWorktreeDirty` = any untracked file, or `git diff --quiet HEAD` exits 1.
   9. Sort, compute `totalAdditions` / `totalDeletions` over all files, cap the list at 2000, set `totalFiles`.
7. `getCodeDiffFileSides(worktreePath, baseRef, filePath, previousPath?)`:
   - Resolve the full ref through `validateRef`, then the merge-base.
   - Original: `git cat-file` read of `<mergeBase>:<previousPath ?? filePath>` with the 2 MiB cap (decision 5). Missing in tree → `originalExists: false`.
   - Modified: `lstat`; symlink → `readlink` output; else `readWorktreeFile` (decision 4). Missing on disk → `modifiedExists: false`.
   - Fill all `CodeDiffSides` fields from both reads.
8. Parsers in `code-diff-parse.ts`:
   - name-status `-z`: tokens `A|M|D|T` + path; `R\d+` / `C\d+` + old path + new path. `T` (type change) maps to `modified`.
   - numstat `-z`: `add\tdel\tpath\0`, or for renames/copies `add\tdel\t\0old\0new\0`. `-\t-` (binary) → counts undefined.

Tests:

- Existing `code-diff.test.ts` cases.
- Parser cases: renames, copies, type change, binary numstat, paths with spaces/newlines/unicode, trailing NUL.
- `validateRef` rejects `--output=/tmp/x`, `a..b`, empty string.
- `validateRef` with a name that is both a branch and a tag → `type: 'tag'`, `ref: 'refs/tags/<name>'`.
- `validateRef` with `HEAD~1` → `type: 'commit'`, `ref` = full sha.
- `getCodeDiffFiles`: committed change reverted in the working tree → not listed; no merge-base → `error: 'no-merge-base'`; more than the cap → `totalFiles` > `files.length` and totals cover all files; untracked text file → `additions` = line count; `mtimeMs` set for existing files.
- `getCodeDiffFileSides`: `filePath` of `../outside.txt` → `error`, no read.
- `getCodeDiffFileSides`: symlink pointing outside the worktree → modified side is the link text, target not read.
- `getCodeDiffFileSides`: file over 2 MiB edited past the 2 MiB offset → `large.patch` holds that edit, sides empty; over 20,000 lines → `large.patch` set; full rewrite over 512 KiB, or large untracked file → `large.patch: null`.
- `fetchCompareRef`: repo with no `origin` → `{ok: false}`, no throw; two concurrent calls → one `git fetch` process.

Commit: `feat(code-diff): git functions for worktree vs base-ref diff`

### Phase 2 — transport

Files:

- `src/main/index.ts`
- `src/renderer/types/types.ts`
- `src/renderer/build-backend/build-backend.ts`

Changes:

1. Handlers: `worktree:codeDiffFiles`, `worktree:codeDiffFileSides`, `worktree:validateRef`, `worktree:branchesForCompare`, `worktree:defaultCompareRef`, `worktree:fetchCompareRef`. Each returns an error result if `worktreePath` is not in `store.getState().worktrees.list`.
2. Add the six methods to `ElectronAPI` and re-export the `src/shared/code-diff` types.
3. Add the six `req(...)` entries to `build-backend.ts`. The `api` object is `any`, so check each name by hand against `ElectronAPI`.

Acceptance:

- From the renderer devtools console, `window.api.getCodeDiffFiles(<path>, 'origin/main')` returns a list in desktop mode and in `pnpm build:headless` web mode.

Commit: `feat(code-diff): transport handlers`

### Phase 3 — renderer components

Files:

- `src/renderer/hooks/useWatchedQuery/useWatchedQuery.ts` — in-flight guard, hidden-window pause
- `src/renderer/components/CodeDiffTool/` — `index.ts`, `CodeDiffTool.tsx` (smart), `CodeDiffSummaryBar.tsx`, `CodeDiffFileTree.tsx`, `CodeDiffDiffPane.tsx` (dumb)
- `src/renderer/components/CodeDiffTool/grouping.ts` + `grouping.test.ts` (pure)
- `src/renderer/components/CodeDiffTool/should-reload-sides.ts` + test (pure)
- `src/renderer/components/ReviewFileTree/ReviewFileTree.tsx` — export `groupAndSortFiles`

Changes:

1. `useWatchedQuery`: `refresh` returns early while a request is in flight; the interval skips ticks while `document.visibilityState === 'hidden'`. Both are safe for current callers.
2. `CodeDiffTool` props: `worktreePath`, `branchName`, `repoLabel`, `onClose`.
3. State (`useState`): `baseRef`, `fetchState` (`idle | fetching | failed`), `selectedFile`, `groupMode`.
4. On mount: `getDefaultCompareRef` → set `baseRef`. No fetch.
5. File list via `useWatchedQuery({cacheKey: \`codeDiff:${baseRef}\`, fallbackPollMs: 3000, fetcher})`, with `fetcher` from `useCallback([baseRef])`. Ignore `data` whose `baseRef` is not the current `baseRef`.
6. Sides reload when the selected file changes, or when `shouldReloadSides(prev, next)` is true (`mtimeMs`, `additions`, or `deletions` changed).
7. `CodeDiffSummaryBar` — back button, repo / branch / "vs" / combobox, Fetch button (remote-tracking bases only), file count, `+totalAdditions −totalDeletions`, fetch-failed note.
8. `CodeDiffFileTree` — groups, badges `A M D R C U`, `previousPath → path`, counts, j/k and [/] (next/prev group). Keydown handler is scoped to the tool container, not `window`, so it does not fight `ReviewFileTree`.
9. `CodeDiffDiffPane` — header, `MonacoDiffEditor`, binary / large-file hunks (`CodeDiffHunks`) / too-large / symlink / error states.
10. All text and icon sizes from the canonical `text-*` / `icon-*` sets.

Tests:

- `grouping.test.ts`: precedence (`api.test.ts` → Tests, `src/api/types.ts` → API), every group, Other.
- `should-reload-sides.test.ts`: same values → false; each of `mtimeMs`, `additions`, `deletions` changed → true; file gone from list → false.

Commit: `feat(code-diff): CodeDiffTool components`

### Phase 4 — integration

Files:

- `src/shared/constants/constants.ts` — `ENABLE_CODE_DIFF = false`
- `src/renderer/components/ChangedFilesPanel/ChangedFilesPanel.tsx`
- `src/renderer/App/App.tsx`
- `src/renderer/hotkeys/constants.ts`, `src/renderer/hooks/useHotkeyHandlers/`
- `src/renderer/components/CommandPalette/CommandPalette.tsx`

Changes:

1. `showCodeDiff` in `DesktopApp`; full-screen block next to the `showReview` block; opening one closes the other.
2. Diff button, hotkey `toggleCodeDiff` (label + category), and palette entry — all hidden when the flag is off.

Manual checks (flag on):

- Open from each entry point.
- Default ref is `origin/main`; opening makes no network call.
- Fetch button: spinner, then the list refreshes. With network off: fetch-failed note, list still shows.
- SSH remote with a locked key: fetch fails within 15 s, no prompt appears.
- Edit an already-modified file in a terminal tab; the open diff updates within ~3 s. Leave the file alone; `[ipc-slow]` and network traffic stay flat (no side reloads).
- Hide the window; the poll stops (`[git-op]` lines stop in `perf.log`).
- Create a branch and a tag with the same name; select it; the label says tag and the diff matches the tag.
- Add a symlink to a file outside the worktree; the pane shows the link text.
- Rename, delete, add untracked, add a binary file; each shows the right badge and pane.
- Type `-x`, `does-not-exist`, and a tag; check error / success.
- Repeat in the web client.

Commit: `feat(code-diff): entry points behind ENABLE_CODE_DIFF`

### Phase 5 — ship

1. Set `ENABLE_CODE_DIFF = true` (or remove the flag).
2. `AGENTS.md`: add `src/shared/code-diff/` to the shared package list, the flag to the feature-flag table, and fix the stale "Cmd+Shift+D perf HUD" text (it is `Cmd+Alt+P`).

Commit: `feat(code-diff): enable code diff tool`

## Detailed file checklist

### Main / shared

- [ ] `src/main/worktree-watcher/worktree-watcher.ts` — `resolveGitDir`, watch the resolved dir
- [ ] `src/main/worktree-watcher/worktree-watcher.test.ts` — `resolveGitDir` tests
- [ ] `src/shared/code-diff/code-diff.ts` — single type definition
- [ ] `src/shared/code-diff/index.ts` — re-export only
- [ ] `src/main/worktree/types.ts` — re-export shared types
- [ ] `src/main/worktree/code-diff-parse.ts` + test — parsers
- [ ] `src/main/worktree/worktree.ts` — six functions
- [ ] `src/main/worktree/code-diff.test.ts` — integration tests
- [ ] `src/main/index.ts` — six handlers with worktree check
- [ ] `src/shared/constants/constants.ts` — `ENABLE_CODE_DIFF`

### Renderer

- [ ] `src/renderer/types/types.ts` — six methods + types
- [ ] `src/renderer/build-backend/build-backend.ts` — six `req` entries
- [ ] `src/renderer/hooks/useWatchedQuery/useWatchedQuery.ts` — in-flight guard, hidden-window pause
- [ ] `src/renderer/components/CodeDiffTool/` — five files + `grouping.ts` + `should-reload-sides.ts` + tests
- [ ] `src/renderer/components/ReviewFileTree/ReviewFileTree.tsx` — export `groupAndSortFiles`
- [ ] `src/renderer/components/ChangedFilesPanel/ChangedFilesPanel.tsx` — Diff button
- [ ] `src/renderer/App/App.tsx` — `showCodeDiff`, mutual exclusion
- [ ] `src/renderer/hotkeys/constants.ts` — `toggleCodeDiff`
- [ ] `src/renderer/hooks/useHotkeyHandlers/` — handler
- [ ] `src/renderer/components/CommandPalette/CommandPalette.tsx` — entry

### Docs

- [ ] `AGENTS.md` — package list, flag table, HUD hotkey

### Verification

- [ ] `npx vitest run src/main/worktree src/main/worktree-watcher src/renderer/components/CodeDiffTool`
- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `pnpm build:headless && bash scripts/smoke-headless.sh`
- [ ] Phase 4 manual checks

## Performance targets

Measured on this repo with a dirty working tree, `[git-op]` lines in `perf.log`:

- `getCodeDiffFiles` < 500 ms.
- `getCodeDiffFileSides` < 200 ms for files under 2 MiB.
- The 3 s poll adds no `[ipc-slow]` lines while idle.

## Risks and mitigations

### `git fetch` hangs, prompts, or collides with agents

- Fetch runs only from the button, never on open.
- `timeout: 15000`, `GIT_TERMINAL_PROMPT=0`, SSH `BatchMode=yes` unless the user set their own SSH command.
- One in-flight fetch per repo + branch; `cannot lock ref` from a parallel agent `git` call is a normal "fetch failed".

### 3 s poll cost on large repos

- Poll only while the tool is open and the window is visible; no overlapping requests.
- Diff sides reload only when the selected file's `mtimeMs` or counts change.
- If `[git-op]` shows > 300 ms per poll, raise the interval or switch to a recursive `fs.watch` (Future work).

### `useWatchedQuery` change affects existing callers

- The in-flight guard and hidden-window pause only skip redundant work. Check `ChangedFilesPanel` and the other callers still refresh after a commit.

### Huge untracked folders

- `--exclude-standard` drops ignored files; the 2000-entry cap bounds the payload.

### Ref injection

- Decision 7 plus tests with `--output=…`.

### Watcher change affects every worktree

- Phase 0 ships as its own commit with its own test, so it can be reverted alone.

### Hotkey conflict in the web client

- `Cmd+Shift+C` opens Chrome's element inspector. See Open questions.

## Open questions

1. Default hotkey: keep `Cmd+Shift+C` (desktop only conflict-free) or pick a key that is free in Chrome too?
2. Should `ReviewScreen`'s branch mode later reuse the base-ref combobox, or stay fixed to the default base?

## Future work

- Agent-generated walkthrough grouping (v1.1).
- Recursive `fs.watch` with ignore filtering, shared by `ChangedFilesPanel` and the code diff tool.
- `--find-copies-harder` toggle for repos that copy files often.
