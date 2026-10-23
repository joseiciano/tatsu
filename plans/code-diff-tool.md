# Code diff tool plan

## Goal

Add a built-in code diff tool. It compares one worktree's end state (commits + staged + unstaged + untracked) against a base ref that the user selects. The default base is a freshly fetched `origin/main`.

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
- `readWorktreeFile` (`:1243`) — rejects paths that escape the worktree, caps reads at `MAX_FILE_READ_BYTES` (2 MiB, `constants.ts:1`), sniffs the first 8 KiB for NUL. Returns `{content, size, binary, truncated, error}`.

### Types

- `ChangedFile` (`src/main/worktree/types.ts:28`, copy in `src/renderer/types/types.ts`) — `path`, `status`, `staged`, `additions?`, `deletions?`. Status union: `added | modified | deleted | renamed | untracked`.
- `FileDiffSides` (`src/main/worktree/types.ts:62`) — only `modifiedBinary`. No `originalBinary`, size, or truncation fields.
- `src/shared/code-diff/` (new, uncommitted) — `CodeDiffFile`, `CodeDiffFileList`, `ValidateRefResult`, `BranchForCompare`, `CodeDiffSides`. `index.ts` and `code-diff.ts` define the types twice and disagree. Fix in Phase 1.

### Watching

- `WorktreeWatcher` (`src/main/worktree-watcher/worktree-watcher.ts`) — watches `join(worktreePath, '.git')` for `index`, `HEAD`, `MERGE_HEAD`. **Bug:** in a linked worktree `.git` is a file (`gitdir: <common>/worktrees/<name>`), so nothing fires. Every Tatsu-created worktree falls back to the 60 s poll.
- `main/index.ts:1185` — `worktree:watchChangedFiles` signal subscribes the client; the watcher emits `worktree:changedFilesInvalidated`.
- `useWatchedQuery` (`src/renderer/hooks/useWatchedQuery/useWatchedQuery.ts:57`) — options `{worktreePath, cacheKey, fetcher, fallbackPollMs = 60000}`. Module-level cache `Map<cacheKey, Map<worktreePath, T>>`, LRU 100 per key. Refetches on `changedFilesInvalidated` and on the fallback interval. Discards stale responses with `currentPathRef`.

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
2. **Default base: fetch, then `origin/main`.** Local `main` is often stale (this worktree's local `main` is 121 commits behind `origin/main`). On open:
   1. Resolve a candidate without network: `origin/main` → `getDefaultBaseRef` chain. Render with it at once.
   2. In the background, run `git fetch --no-tags origin <branch>` for that remote-tracking ref (timeout 15 s, `GIT_TERMINAL_PROMPT=0`).
   3. On success, refetch the file list. On failure (offline, no remote, auth), keep the result and show "Could not fetch origin — comparing against last fetched `origin/main`".
   A fetch runs at most once per worktree + ref per open. Typed local refs and tags are never fetched.
3. **Types live in `src/shared/code-diff/`.** The renderer cannot import from `src/main`. `src/main/worktree/types.ts` re-exports them. `CodeDiffFile` is a separate type, not `extends ChangedFile`, because `staged` has no meaning against a merge-base.
4. **Reuse `readWorktreeFile` for the modified side.** It already gives path containment, the 2 MiB cap, binary sniffing, and truncation.
5. **Original side uses a size-capped `git show`.** Same 2 MiB cap and NUL sniff as the modified side, so both sides report `binary`, `truncated`, `size` the same way.
6. **Refresh = fixed watcher + active-view poll.** The fixed `WorktreeWatcher` covers commit, stage, checkout, merge. While the tool is open, `useWatchedQuery` runs with `fallbackPollMs: 3000`. The file list carries `additions`/`deletions`, and the open diff pane reloads its sides after every list refresh, so edits to an already-modified file show up. The poll stops on close.
7. **Refs are untrusted input.** Reject refs that start with `-` or contain `..`, whitespace, or control characters before they reach git. Put `--end-of-options` before refs where git supports it.
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
| Fetching base | Small "Fetching origin…" note; list stays usable |
| Fetch failed | Note from decision 2 |
| Empty | "No changes between `<baseRef>` and this worktree" |
| Invalid ref | "Ref `<ref>` not found." + "Reset to default" |
| No merge-base | "`<baseRef>` and this branch share no history." + "Reset to default" |
| Too many files | List capped at 2000 entries + "Showing 2000 of N files" |
| Binary file | "Binary file — cannot display diff" (same text as `ReviewDiffPane`) |
| Truncated file | Diff of the first 2 MiB + banner "File is larger than 2 MB; showing the first 2 MB" |
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

1. Resolve the real git dir before watching. If `<worktreePath>/.git` is a file, read `gitdir: <path>` and resolve it relative to the worktree. Watch that directory.
2. Test: linked worktree created with `git worktree add`; staging a file fires the listener.

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
   }

   export interface CodeDiffFileList {
     files: CodeDiffFile[]
     totalFiles: number
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
2. `validateRef(worktreePath, ref)` — reject unsafe input (decision 7), then `git rev-parse --verify --quiet <ref>^{commit}`. Type: `refs/heads/<ref>` or `refs/remotes/<ref>` → `branch`, `refs/tags/<ref>` → `tag`, else `commit`. Return the full ref name for branches and tags.
3. `listBranchesForCompare(worktreePath)` — `git for-each-ref --format=%(refname) refs/heads refs/remotes refs/tags`, map to `BranchForCompare`, drop `refs/remotes/*/HEAD`.
4. `resolveDefaultCompareRef(worktreePath)` — `origin/main` → `getDefaultBaseRef`. Returns `{ref, fetchable: boolean}`.
5. `fetchCompareRef(worktreePath, ref)` — only for `origin/<branch>`. `git fetch --no-tags origin <branch>` with `timeout: 15000` and `GIT_TERMINAL_PROMPT=0`. Returns `{ok, error?}`; never throws.
6. `getCodeDiffFiles(worktreePath, baseRef)`:
   1. `validateRef`; on failure return `error: 'invalid-ref'`.
   2. `git merge-base <ref> HEAD`; exit 1 → `error: 'no-merge-base'`.
   3. `git diff --name-status -z --find-renames --find-copies <mergeBase>`.
   4. `git diff --numstat -z --find-renames --find-copies <mergeBase>`.
   5. `git ls-files --others --exclude-standard -z` for untracked files.
   6. Merge by `path`; diff entries win. Untracked entries have no line counts.
   7. Sort, cap at 2000, set `totalFiles`.
7. `getCodeDiffFileSides(worktreePath, baseRef, filePath, previousPath?)`:
   - Original: size-capped `git show <mergeBase>:<previousPath ?? filePath>` (decision 5). Missing in tree → `originalExists: false`.
   - Modified: `readWorktreeFile`. Missing on disk → `modifiedExists: false`.
   - Fill all `CodeDiffSides` fields from both reads.
8. Parsers in `code-diff-parse.ts`:
   - name-status `-z`: tokens `A|M|D|T` + path; `R\d+` / `C\d+` + old path + new path. `T` (type change) maps to `modified`.
   - numstat `-z`: `add\tdel\tpath\0`, or for renames/copies `add\tdel\t\0old\0new\0`. `-\t-` (binary) → counts undefined.

Tests:

- Existing `code-diff.test.ts` cases.
- Parser cases: renames, copies, type change, binary numstat, paths with spaces/newlines/unicode, trailing NUL.
- `validateRef` rejects `--output=/tmp/x`, `a..b`, empty string.
- `getCodeDiffFiles`: committed change reverted in the working tree → not listed; no merge-base → `error: 'no-merge-base'`; more than the cap → `totalFiles` > `files.length`.
- `getCodeDiffFileSides`: `filePath` of `../outside.txt` → `error`, no read.

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

- `src/renderer/components/CodeDiffTool/` — `index.ts`, `CodeDiffTool.tsx` (smart), `CodeDiffSummaryBar.tsx`, `CodeDiffFileTree.tsx`, `CodeDiffDiffPane.tsx` (dumb)
- `src/renderer/components/CodeDiffTool/grouping.ts` + `grouping.test.ts` (pure)
- `src/renderer/components/ReviewFileTree/ReviewFileTree.tsx` — export `groupAndSortFiles`

Changes:

1. `CodeDiffTool` props: `worktreePath`, `branchName`, `repoLabel`, `onClose`.
2. State (`useState`): `baseRef`, `fetchState` (`idle | fetching | failed`), `selectedFile`, `groupMode`.
3. On mount: `getDefaultCompareRef` → set `baseRef` → if `fetchable`, `fetchCompareRef` → on success call the query's `refresh`.
4. File list via `useWatchedQuery({cacheKey: \`codeDiff:${baseRef}\`, fallbackPollMs: 3000, …})`. Sides reload when the selected file changes and after every list refresh.
5. `CodeDiffSummaryBar` — back button, repo / branch / "vs" / combobox, file count, `+N −M`, fetch note.
6. `CodeDiffFileTree` — groups, badges `A M D R C U`, `previousPath → path`, counts, j/k and [/] (next/prev group). Keydown handler is scoped to the tool container, not `window`, so it does not fight `ReviewFileTree`.
7. `CodeDiffDiffPane` — header, `MonacoDiffEditor`, binary / truncated / error states.
8. All text and icon sizes from the canonical `text-*` / `icon-*` sets.

Tests:

- `grouping.test.ts`: precedence (`api.test.ts` → Tests, `src/api/types.ts` → API), every group, Other.

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
- Default ref is `origin/main`; fetch note appears and clears.
- With network off: fetch-failed note, list still shows.
- Edit an already-modified file in a terminal tab; list counts and open diff update within ~3 s.
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

- [ ] `src/main/worktree-watcher/worktree-watcher.ts` — resolve gitdir
- [ ] `src/main/worktree-watcher/worktree-watcher.test.ts` — linked-worktree test
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
- [ ] `src/renderer/components/CodeDiffTool/` — five files + `grouping.ts` + test
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

### `git fetch` hangs or prompts

- `timeout: 15000`, `GIT_TERMINAL_PROMPT=0`, `GIT_SSH_COMMAND` unchanged.
- Fetch runs in the background; the list never waits on it.

### 3 s poll cost on large repos

- Poll only while the tool is open and visible.
- If `[git-op]` shows > 300 ms per poll, raise the interval or switch to a recursive `fs.watch` (Future work).

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
