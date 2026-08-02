# Code-Diff Tool — Implementation Plan

## Goal

Build an integrated code-diff tool that lets users compare a worktree's end-result (committed changes + dirty working tree) against any arbitrary branch or ref. The comparison shows all divergence between the base ref and the worktree's current state. Default base ref: `main` (with automatic fallback chain). Deterministic logical file grouping by change type (directory view switchable), optional semantic walkthrough via active agent (v1.1).

## Non-Goals

- No remote sharing, PR submission, or commit composer.
- No two-arbitrary-refs comparison in v1 (scope is always "worktree vs selected base").
- No persistent shared state for the selected base ref (per-client UI state only).
- No review comments or "send to agent" — that's existing ReviewScreen territory, not this tool's scope.
- No narrative walkthrough in v1 — the codiff-inspired "chapter" concept is an explicit optional enhancement (v1.1), not shipping in the initial implementation.

---

## Product Behavior & UX

### Entry Points

1. **ChangedFilesPanel** — Add a "Compare to…" button (icon: `GitCompareArrows`) alongside the existing "Review" button. Visible when branch files or working files exist. Clicking opens the CodeDiffTool.
2. **Keyboard shortcut** — `Cmd+Shift+D` is taken (perf HUD). Use `Cmd+Shift+C` as the default binding, overridable in hotkeys. Toggles the CodeDiffTool for the active worktree.
3. **Command Palette** — Add a "Code Diff" entry that opens the tool.

### Base-Ref Selector

A combobox/dropdown in the summary bar, populated from `listBranches(repoRoot)`. Shows:
- Local branches (prefixed with nothing)
- Remote branches (prefixed with `origin/`)
- Tags (if any) — optional, via `git tag --list`

**Default resolution order** (on open, if no prior selection for this worktree):
1. `main` — local branch named "main" (literal `refs/heads/main` must exist)
2. `origin/main` — remote tracking ref (literal `refs/remotes/origin/main`)
3. `getDefaultBaseRef(worktreePath)` — existing resolver, which returns `origin/HEAD` → `origin/main` → `origin/master` → `main` → `master` → `HEAD`

Each candidate is validated via `git rev-parse --verify` before use. If none resolve, fall back to `HEAD` with a user-visible note.

The combobox is editable: user can type a ref name (branch, tag, commit hash prefix) and press Enter to validate and apply. Validation: `git rev-parse --verify <ref>` in the worktree.

### Comparison Semantics

The tool compares the worktree's end-result against the merge-base of the selected base ref and HEAD:

```
mergeBase = git merge-base <baseRef> HEAD
```

**Committed divergence** comes from comparing the merge-base tree to the worktree. The merge-base is the last common ancestor — it is *not* `<baseRef>` itself. Using `<baseRef>:path` directly would incorrectly include commits on the base branch that aren't shared ancestors.

**End-state for each file** is the worktree filesystem (for tracked files with local modifications) or the index (for staged changes that haven't been written — but in practice the filesystem reflects the working state). Untracked files are filesystem-only.

Concrete git commands for the file list:

1. `git merge-base <baseRef> HEAD` → `mergeBase` (sha1).
2. `git diff --name-status -z --find-renames --find-copies <mergeBase>` — compares merge-base tree to working tree for tracked files. Reports Added/Modified/Deleted/Renamed/Copied status with old→new paths for renames and copies. `--find-renames` and `--find-copies` ensure these are detected (not silently dropped). The `-z` flag NUL-delimits output for safe path parsing. This single command captures committed + staged + unstaged tracked changes as a unified delta against the merge-base.
3. `git diff --numstat -z <mergeBase>` — line-count stats for the same tracked-file set.
4. `git status --porcelain -uall` — captures untracked files (status `??`) and re-confirms tracked statuses. Used to add untracked entries not covered by `git diff`.

**Merge strategy**: `git diff --name-status` is the authoritative source for tracked files (it compares the worktree filesystem to the merge-base tree, so staged and unstaged changes are already folded in). Untracked files from porcelain are added separately. Dedup by path; for any path appearing in both, the `git diff --name-status` entry takes precedence (it carries correct rename/source info).

**Why not separate committed + staged + unstaged**: Running `git diff <base>...HEAD` for committed, then `git diff --cached` for staged, then `git diff` for unstaged, then merging them requires careful ordering and still produces ambiguous results for files touched in multiple layers (e.g., committed change then partially reverted in working tree). A single `git diff --name-status <mergeBase>` against the worktree gives the net result directly — it compares the merge-base tree to the current working tree, which is the correct end state. The claim that independent `base...HEAD` plus loose status merge accurately gives combined stats or detects a committed diff later reverted in a dirty tree is incorrect; the merge-base approach avoids this entire class of bugs.

**Diff sides for a single file** (`getCodeDiffFileSides`):

1. Original side: `git show <mergeBase>:<previousPath ?? filePath>` — the file at the merge-base tree. `previousPath` comes from the `CodeDiffFile` object populated during NUL-delimited parsing of `--name-status` output for renames/copies.
2. Modified side: read from the worktree filesystem. If the file was deleted (status `D`), modified side is empty with `modifiedExists: false`.
3. Untracked files: original is empty/null; modified is the full file content from disk.
4. Binary detection: check if `git show` output contains NUL bytes; if so, return binary flag instead of content.

Staged/index is subsumed by the filesystem end state — there is no separate "staged" vs "unstaged" distinction in the comparison output. The user sees one unified diff per file.

### Source Session Identity

Each CodeDiffTool instance is identified by `worktreePath + baseRef`. The cache key for `useWatchedQuery` is `codeDiff:<worktreePath>:<baseRef>`. Changing the base ref triggers a full re-fetch.

### States

| State | Behavior |
|---|---|
| **Empty (no diff)** | "No changes between `<baseRef>` and this worktree" |
| **Loading** | Skeleton/spinner while file list + counts load |
| **Error (invalid ref)** | "Ref `<ref>` not found. Check the ref name." with a "Reset to default" button |
| **Binary file selected** | "Binary file — cannot display diff" (same as existing ReviewDiffPane) |
| **Large file** | Show diff with a warning banner: "File is large (N lines). Performance may be reduced." |
| **Renamed file** | Show status badge "R" + `previousPath → path` in file tree |
| **Copied file** | Show status badge "C" + `previousPath → path` in file tree |
| **Deleted file** | Show in file tree with "D" badge; diff pane shows full deletion |
| **Untracked file** | Show in file tree with "U" badge; diff pane shows full addition |

---

## Logical Grouping Approach

### Change-Type Groups (Baseline — v1)

Files are grouped by deterministic change-type classification. Each file is classified into one category based on path patterns:

- **API / Routing** — files matching `*api*`, `*route*`, `*controller*`, `*handler*`
- **UI / Views** — files matching `*component*`, `*view*`, `*page*`, `*.css`, `*.scss`, `*.tsx`, `*.jsx`
- **Data / Models** — files matching `*model*`, `*schema*`, `*migration*`, `*types*`, `*.ts` (in model dirs)
- **Config** — files matching `*.json`, `*.yaml`, `*.toml`, `*.env*`, `wrangler.*`
- **Tests** — files matching `*.test.*`, `*.spec.*`, `__tests__/`
- **Other** — everything else

Each group has a header with aggregate stats and a collapsible list of files. The classification is pure pattern-matching on file paths — deterministic, no agent involvement.

A **Directory** view mode is available as a toggle in the file tree header, grouping files by directory path exactly like the existing `ReviewFileTree.groupAndSortFiles()`. The user switches between "Change Type" and "Directory" grouping via a button.

### Semantic Walkthrough (Optional Enhancement — v1.1)

After the initial release, optionally add agent-generated narrative "chapter" groupings inspired by codiff. This requires an active agent session and is a separate feature — not part of the initial implementation.

---

## Implementation Phases

### Phase 1: Backend — New Git Commands (src/main/worktree/)

#### 1.1 Expand `src/main/worktree/types.ts`

Add new types:

```typescript
export type CompareMode = 'working' | 'branch' | 'arbitrary'

export interface CompareRefOptions {
  baseRef: string          // The ref to compare against
  includeWorkingTree: boolean  // Include dirty working tree changes
}

/**
 * Code-diff–specific file entry. Extends ChangedFile with rename/copy
 * metadata that `ChangedFile` does not carry. `previousPath` is set for
 * renames (status R) and copies (status C) — it is the source path in
 * the merge-base tree. `copied` distinguishes copies from renames.
 *
 * `path` always holds the destination (new) path regardless of status.
 * For deleted files, `path` is the path that was removed.
 */
export interface CodeDiffFile extends ChangedFile {
  /** Source path at merge-base for renames/copies. Undefined for A/M/D/U. */
  previousPath?: string
  /** True when the file was copied (status C). False or absent for renames. */
  copied?: boolean
}

export interface CodeDiffFileList {
  files: CodeDiffFile[]
  baseRef: string
  mergeBase: string        // Resolved merge-base sha1
  headRef: string
  isWorktreeDirty: boolean
}

export interface ValidateRefResult {
  valid: boolean
  ref: string
  type: 'branch' | 'tag' | 'commit' | 'unknown'
  error?: string
}
```

#### 1.2 Expand `src/main/worktree/worktree.ts`

Add new functions:

```typescript
/** Validate a ref exists in the worktree. Returns resolution info. */
export async function validateRef(
  worktreePath: string,
  ref: string
): Promise<ValidateRefResult>

/** Get the full list of branches (local + remote) for the base-ref combobox. */
export async function listBranchesForCompare(
  worktreePath: string
): Promise<string[]>

/** Get changed files between an arbitrary baseRef and the worktree's
 *  current state. Uses merge-base semantics for committed divergence,
 *  filesystem for end-state, and porcelain for untracked. */
export async function getCodeDiffFiles(
  worktreePath: string,
  baseRef: string
): Promise<CodeDiffFileList>

/** Get diff sides for a single file against an arbitrary base ref.
 *  Original from merge-base tree, modified from worktree filesystem.
 *  `previousPath` is the source path for renames/copies (from CodeDiffFile). */
export async function getCodeDiffFileSides(
  worktreePath: string,
  baseRef: string,
  filePath: string,
  previousPath?: string
): Promise<FileDiffSides>
```

**Implementation of `getCodeDiffFiles`:**
1. Validate baseRef exists via `validateRef`.
2. `git merge-base <baseRef> HEAD` → `mergeBase` sha1.
3. `git diff --name-status -z --find-renames --find-copies <mergeBase>` — tracked file statuses against merge-base tree. The `--find-renames` flag ensures renames are detected even when the similarity threshold is below the default; `--find-copies` ensures copies are reported (not silently merged into renames). The `-z` flag NUL-delimits output so paths with special characters are safe.
4. `git diff --numstat -z <mergeBase>` — line-count stats for the same set.
5. `git status --porcelain -uall` — untracked files (status `??`) plus confirmation of tracked statuses.
6. Merge: `git diff --name-status` is authoritative for tracked files (rename old/new paths, Added/Modified/Deleted/Copied status). Untracked files from porcelain (`??`) are appended. Dedup by path; `git diff` entry wins on collision.
7. Return `CodeDiffFileList` with resolved `mergeBase` sha1.

**NUL-delimited name-status parsing** (`git diff --name-status -z`):

The `-z` flag changes the output format. For non-rename/copy entries:
```
A\0path\0M\0path\0D\0path\0
```

For renames (R) and copies (C), the output includes a similarity percentage and both old and new paths:
```
R100\0old-path\0new-path\0M\0path\0C075\0old-path\0new-path\0
```

Parse algorithm:
1. Split the entire stdout buffer on `\0` (NUL byte).
2. Walk the resulting array with an index pointer:
   - If the token matches `^[AMD]$` → status-only entry. Read the next token as `path`. Push `{ path, status }`.
   - If the token matches `^R\d{3}$` → rename entry. Read next token as `previousPath`, next token as `path`. Push `{ path, previousPath, status: 'renamed', copied: false }`.
   - If the token matches `^C\d{3}$` → copy entry. Read next token as `previousPath`, next token as `path`. Push `{ path, previousPath, status: 'renamed', copied: true }`. (We reuse `status: 'renamed'` since `ChangedFile.status` has no `'copied'` variant; the `copied` boolean disambiguates.)
   - Skip any trailing empty token from the final `\0`.
3. The similarity percentage (`R100`, `C075`) is discarded — it's not surfaced in the UI in v1.

**`getCodeDiffFileSides` API design — explicit `previousPath` argument:**

The renderer already has the `CodeDiffFile` object (with `previousPath` populated) when the user selects a file. Passing it explicitly avoids a redundant lookup on the main side:

```typescript
export async function getCodeDiffFileSides(
  worktreePath: string,
  baseRef: string,
  filePath: string,
  previousPath?: string   // Pass the source path for renames/copies
): Promise<FileDiffSides>
```

1. Resolve `mergeBase` via `git merge-base <baseRef> HEAD`.
2. Original side: `git show <mergeBase>:<previousPath ?? filePath>` — use `previousPath` for renames/copies, `filePath` otherwise.
3. Modified side: read from worktree filesystem (`fs.readFile`). If file was deleted (`D`), modified is empty with `modifiedExists: false`.
4. Untracked files: original is empty/null; modified is full file from disk.

This design is applied consistently across:
- **Transport handler** (Phase 2.1): `worktree:codeDiffFileSides` accepts `(worktreePath, baseRef, filePath, previousPath?)`.
- **Renderer types** (Phase 2.2): `getCodeDiffFileSides(worktreePath, baseRef, filePath, previousPath?)`.
- **Renderer call site** (Phase 3): `getCodeDiffFileSides(worktreePath, baseRef, selectedFile.path, selectedFile.previousPath)`.
- **Tests**: renamed-file test case passes `previousPath` and asserts `git show <mergeBase>:<old-path>` for the original side.

### Phase 2: Transport Layer

#### 2.1 Add IPC handlers in `src/main/index.ts`

```typescript
transport.onRequest('worktree:codeDiffFiles', async (_ctx, worktreePath: string, baseRef: string) => {
  return getCodeDiffFiles(worktreePath, baseRef)
})

transport.onRequest('worktree:codeDiffFileSides', async (_ctx, worktreePath: string, baseRef: string, filePath: string, previousPath?: string) => {
  return getCodeDiffFileSides(worktreePath, baseRef, filePath, previousPath)
})

transport.onRequest('worktree:validateRef', async (_ctx, worktreePath: string, ref: string) => {
  return validateRef(worktreePath, ref)
})

transport.onRequest('worktree:branchesForCompare', async (_ctx, worktreePath: string) => {
  return listBranchesForCompare(worktreePath)
})
```

#### 2.2 Add to `src/renderer/types/types.ts`

Add to the `ElectronAPI` interface:

```typescript
getCodeDiffFiles(worktreePath: string, baseRef: string): Promise<CodeDiffFileList>
getCodeDiffFileSides(worktreePath: string, baseRef: string, filePath: string, previousPath?: string): Promise<FileDiffSides>
validateRef(worktreePath: string, ref: string): Promise<ValidateRefResult>
listBranchesForCompare(worktreePath: string): Promise<string[]>
```

Re-export the new types (`CodeDiffFileList`, `CodeDiffFile`, `ValidateRefResult`, etc.).

#### 2.3 Add to `src/renderer/build-backend/build-backend.ts`

Add the four new request methods to the `req()` calls.

### Phase 3: Renderer — CodeDiffTool Component

#### 3.1 Create `src/renderer/components/CodeDiffTool/`

Package structure:

```
src/renderer/components/CodeDiffTool/
├── index.ts                    # Public export
├── CodeDiffTool.tsx            # Smart container (manages state, fetches data)
├── CodeDiffSummaryBar.tsx      # Dumb view — summary bar with base-ref combobox
├── CodeDiffFileTree.tsx        # Dumb view — file tree with change-type groups
├── CodeDiffDiffPane.tsx        # Dumb view — Monaco diff pane for selected file
└── CodeDiffTool.test.ts        # Component behavior tests
```

#### 3.2 `CodeDiffTool.tsx` (Smart Container)

Props:
```typescript
interface CodeDiffToolProps {
  worktreePath: string
  repoRoot: string
  branchName: string
  repoLabel: string
  onClose: () => void
}
```

State (all `useState` — this is per-client UI state, not shared):
- `baseRef: string` — currently selected base ref (seeded from default resolution on mount, local to this component instance)
- `branches: string[]` — available branches (fetched once on mount)
- `files: CodeDiffFile[]` — result of comparison (extends ChangedFile with `previousPath` and `copied` for rename/copy metadata)
- `selectedFile: CodeDiffFile | null` — the selected entry, carries `previousPath` for rename-side lookup
- `loading: boolean`
- `error: string | null`
- `groupMode: 'changeType' | 'directory'` — grouping toggle (default: `'changeType'`)

Uses `useWatchedQuery` with cache key `codeDiff:<worktreePath>:<baseRef>` for the file list. Uses `getCodeDiffFileSides` for individual file diffs, passing `selectedFile.previousPath` when present.

Fetches branches via `listBranchesForCompare` on mount. Validates typed refs via `validateRef`.

The base ref is entirely local to the CodeDiffTool component. `App.tsx` only manages the open/close boolean (`showCodeDiff`); it does not hold or persist the base ref. If the user reopens the tool, the default resolution chain runs again.

#### 3.3 `CodeDiffSummaryBar.tsx` (Dumb View)

Renders:
- Back button (close)
- Repo label / branch name / "vs" / base-ref combobox
- File count, +/-
- No "send to agent" — this is a diff viewer, not a review tool

#### 3.4 `CodeDiffFileTree.tsx` (Dumb View)

Extends the existing `ReviewFileTree` pattern:
- Collapsible groups: change-type categories (default) or directory tree (toggle)
- Status badges (A/M/D/R/C/U)
- For renames/copies: show `previousPath → path` in the file tree label
- Line count stats
- Keyboard navigation (j/k, [/])
- No "reviewed" tracking — that's ReviewScreen territory

#### 3.5 `CodeDiffDiffPane.tsx` (Dumb View)

Reuses the existing `MonacoDiffEditor` component. Fetches diff sides via `getCodeDiffFileSides`. Shows:
- File header with status badge and line counts
- Monaco diff editor
- Binary file fallback message
- Error state

### Phase 4: Integration

#### 4.1 Entry in `ChangedFilesPanel`

Add a new button in the `actions` slot:

```tsx
<Tooltip label="Compare to base branch">
  <button onClick={onOpenCodeDiff} className="...">
    <GitCompareArrows className="icon-2xs" />
    Diff
  </button>
</Tooltip>
```

The `onOpenCodeDiff` callback is threaded through from `App.tsx`.

#### 4.2 `App.tsx` State

Add to `DesktopApp` — only the open/close boolean, no base ref:
```typescript
const [showCodeDiff, setShowCodeDiff] = useState(false)
```

Add the full-screen view rendering block, following the same pattern as `showReview`:

```tsx
{showCodeDiff && activeWorktreeId && (() => {
  const wt = worktrees.find((w) => w.path === activeWorktreeId)
  return (
    <div className="flex-1 min-w-0 flex">
      <CodeDiffTool
        worktreePath={activeWorktreeId}
        repoRoot={wt?.repoRoot ?? ''}
        branchName={wt?.branch ?? ''}
        repoLabel={wt ? (wt.repoRoot.split('/').pop() || wt.repoRoot) : ''}
        onClose={() => setShowCodeDiff(false)}
      />
    </div>
  )
})()}
```

`CodeDiffTool` resolves its own default base ref on mount. App does not pass or persist a base ref.

#### 4.3 Keyboard Shortcut

Add `Cmd+Shift+C` binding in `src/renderer/hotkeys/` that calls `setShowCodeDiff(true)`. Add to the hotkey handler map in `useHotkeyHandlers`.

#### 4.4 Command Palette

Add a "Code Diff" entry in `CommandPalette.tsx` that opens the tool.

### Phase 5: Watch Semantics & Refresh

The existing `WorktreeWatcher` monitors `.git/index`, `HEAD`, and `MERGE_HEAD` via `fs.watch`. It detects branch switches, commits, merges, and staged changes (index writes). It fires `changedFilesInvalidated` which triggers `useWatchedQuery` re-fetches.

**Limitation**: The watcher does *not* detect unstaged working-file writes (edits to tracked files that aren't staged, or new untracked files). These are the common case while a user is actively editing.

**CodeDiffTool refresh strategy** (two layers):

1. **Watcher-driven invalidation** (existing): The `WorktreeWatcher` detects HEAD/index changes and fires `changedFilesInvalidated`. The CodeDiffTool's `useWatchedQuery` listens for this and re-fetches the file list. This handles commits, branch switches, and staging.

2. **Active-view working-file polling** (new, scoped to CodeDiffTool): While the CodeDiffTool is open and active, a debounced poll or path-level watcher detects working-file changes that the index watcher misses. Two options (design choice during implementation):

   - **Option A — Shorter active-view poll**: A `setInterval` (e.g., 2–3 s) that runs `git status --porcelain` and compares to the last-known status. If changed, trigger re-fetch. Paused when the tool is not the active view. Low overhead; simple cleanup on close.
   - **Option B — Ref-counted directory watcher**: A lightweight `fs.watch` on the worktree directory (recursive, excluding `.git/`, `node_modules/`, and gitignore-patterned paths). Reference-counted so multiple consumers share one watcher. On any change, debounce 500 ms then fire `changedFilesInvalidated`. More responsive but requires careful exclusion filtering and cleanup.

   Recommendation: Option A for v1 (simpler, no new watcher infra). Option B as a follow-up if responsiveness needs improve.

**Resource cleanup**: Any polling interval or watcher created by CodeDiffTool is cleaned up in the component's `useEffect` return (close/unmount). The ref-counted watcher (Option B) decrements a reference count and tears down the `fs.watch` handle when the count hits zero.

---

## Test Plan

### Unit Tests

#### Git Command Args (`src/main/worktree/code-diff.test.ts`)

| Test | Expected Command |
|---|---|
| `getCodeDiffFiles` basic | `git merge-base <base> HEAD` + `git diff --name-status -z --find-renames --find-copies <mergeBase>` + `git status --porcelain -uall` |
| `getCodeDiffFiles` with dirty tree | merge-base + diff --name-status --find-renames --find-copies + numstat + porcelain |
| `getCodeDiffFiles` empty diff | Empty file list, no error |
| `getCodeDiffFiles` invalid ref | `validateRef` returns `valid: false` |
| `getCodeDiffFiles` parses rename | NUL-delimited `R100\0old\0new` → `CodeDiffFile { path: 'new', previousPath: 'old', status: 'renamed', copied: false }` |
| `getCodeDiffFiles` parses copy | NUL-delimited `C075\0old\0new` → `CodeDiffFile { path: 'new', previousPath: 'old', status: 'renamed', copied: true }` |
| `getCodeDiffFileSides` committed file | `git show <mergeBase>:<path>` + worktree read |
| `getCodeDiffFileSides` dirty file | Base from merge-base, modified from disk read |
| `getCodeDiffFileSides` untracked file | Original empty, modified from disk |
| `getCodeDiffFileSides` renamed file | `git show <mergeBase>:<previousPath>` for original, modified from new path (disk) |
| `getCodeDiffFileSides` deleted file | Original from merge-base, modified empty + `modifiedExists: false` |
| `validateRef` branch | `git rev-parse --verify refs/heads/<ref>` |
| `validateRef` tag | `git rev-parse --verify refs/tags/<ref>` |
| `validateRef` commit hash | `git rev-parse --verify <hash>` |
| `validateRef` nonexistent | Returns `valid: false, error: "..."` |
| `listBranchesForCompare` | `git branch -a --format=%(refname:short)` |

#### Status Overlay

| File Status | Badge | Diff Side Behavior |
|---|---|---|
| Added (vs merge-base) | `A` | Original empty, modified from disk |
| Modified | `M` | Original from merge-base, modified from disk |
| Deleted | `D` | Original from merge-base, modified empty |
| Renamed | `R` | Original from `previousPath` (merge-base), modified from `path` (disk) |
| Copied | `C` | Original from `previousPath` (merge-base), modified from `path` (disk) |
| Untracked | `U` | Original empty, modified from disk |

### Component Tests (`CodeDiffTool.test.ts`)

| Test | What |
|---|---|
| Renders file list on mount | Calls `getCodeDiffFiles`, displays files |
| Selects file → shows diff | Calls `getCodeDiffFileSides(worktreePath, baseRef, file.path, file.previousPath)`, renders MonacoDiffEditor |
| Changes base ref → re-fetches | Combobox change triggers new fetch |
| Invalid ref → shows error | `validateRef` returns false, error banner shown |
| Empty diff → shows message | "No changes between..." message |
| Binary file → shows fallback | "Binary file" message instead of diff editor |
| Close button → calls onClose | Escape key and back button work |
| Keyboard navigation | j/k moves selection, [/] navigates files |

### Transport Contract Tests

| Test | What |
|---|---|
| `worktree:codeDiffFiles` roundtrip | Renderer calls → main returns `CodeDiffFileList` |
| `worktree:codeDiffFileSides` roundtrip | Renderer calls with `(path, previousPath?)` → main returns `FileDiffSides` |
| `worktree:validateRef` roundtrip | Renderer calls → main returns `ValidateRefResult` |
| `worktree:branchesForCompare` roundtrip | Renderer calls → main returns `string[]` |

### No Reducer Changes

All CodeDiffTool state is per-client UI state (base ref selection, selected file, loading/error, group mode). No new slice or reducer needed. The tool reads existing slices (worktrees, settings) via hooks.

### Verification Commands

```bash
pnpm typecheck        # Type check all files
pnpm build            # Build desktop + renderer + web client
npx vitest run        # Run all tests
```

---

## Performance Approach

1. **File metadata first**: `getCodeDiffFiles` returns only the file list with status and line counts. No diff content. This is fast — three git commands (merge-base + diff --name-status + status --porcelain).

2. **Lazy side loading**: `getCodeDiffFileSides` is called only when the user selects a file in the tree. Not on initial load.

3. **Cache key**: `codeDiff:<worktreePath>:<baseRef>` in the `useWatchedQuery` module-level cache. Changing base ref evicts the old cache entry.

4. **Cancellation**: Every `useEffect` sets a `cancelled` flag on cleanup. Stale responses are discarded.

5. **Stale response safety**: The `useWatchedQuery` hook already handles this — it checks `currentPathRef` before setting state.

6. **Watch — two layers**: The existing `WorktreeWatcher` handles HEAD/index changes (commits, staging). Working-file changes while the tool is active are caught by a debounced active-view poll (v1) or a ref-counted directory watcher (follow-up). See Phase 5 for details.

7. **Large file guard**: Files exceeding a configurable read-size threshold get a warning banner but are still shown. Binary files get the fallback message. The exact threshold is defined as a constant in the implementation and verified against existing read-size guards in the codebase, not assumed.

---

## Migration / Backward Compatibility

- **No existing APIs changed**: All new functions are additive. Existing `getChangedFiles`, `getFileDiffSides`, etc. remain unchanged.
- **No shared state added**: No new slice, no new events, no persistence. Everything is renderer-local UI state.
- **No preload changes needed**: The preload exposes a generic `request()` method; new IPC channel names are auto-routed.
- **Existing ReviewScreen untouched**: The CodeDiffTool is a separate component. The existing ReviewScreen continues to work for its working/branch/commit modes.
- **Feature flag (optional)**: If desired, gate behind `ENABLE_CODE_DIFF` constant (set to `true` by default). Add to `src/shared/constants.ts`.

---

## Acceptance Criteria

1. User can open the CodeDiffTool from ChangedFilesPanel or keyboard shortcut.
2. Default base ref is local `main` → `origin/main` → existing resolver, validated before use.
3. User can type or select any valid ref in the combobox.
4. Invalid refs show a clear error with a "Reset" button.
5. File tree shows all divergent files grouped by change type (directory view switchable).
6. Selecting a file shows a Monaco diff editor with the correct comparison (merge-base vs worktree filesystem).
7. Dirty working tree changes are included in the diff.
8. Binary files show a fallback message.
9. Renamed and deleted files are handled correctly (using parsed old/new paths from merge-base diff).
10. Performance is acceptable: file list loads in <500ms, individual diffs load on-demand.
11. `pnpm typecheck` passes.
12. `pnpm build` passes.
13. `npx vitest run` passes.

---

## Ordered Implementation / Verification Commands

```bash
# Phase 1: Backend types and git commands
# Edit src/main/worktree/types.ts
# Edit src/main/worktree/worktree.ts
pnpm typecheck

# Phase 2: Transport layer
# Edit src/main/index.ts (add 4 handlers)
# Edit src/renderer/types/types.ts (add 4 methods + types)
# Edit src/renderer/build-backend/build-backend.ts (add 4 request methods)
pnpm typecheck

# Phase 3: Renderer components
# Create src/renderer/components/CodeDiffTool/ (5 files)
pnpm typecheck
pnpm build

# Phase 4: Integration
# Edit src/renderer/components/ChangedFilesPanel/ChangedFilesPanel.tsx
# Edit src/renderer/App/App.tsx
# Edit src/renderer/hotkeys/ (add binding)
# Edit src/renderer/components/CommandPalette/CommandPalette.tsx
pnpm typecheck
pnpm build

# Phase 5: Tests
# Create src/main/worktree/code-diff.test.ts
# Create src/renderer/components/CodeDiffTool/CodeDiffTool.test.ts
npx vitest run

# Final verification
pnpm typecheck
pnpm build
npx vitest run
```
