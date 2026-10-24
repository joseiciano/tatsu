---
goal: Add a read-only main-side helper that reports whether a worktree path is trusted by Claude Code (~/.claude.json) and by Codex (~/.codex/config.toml), without ever writing either file
date_created: 2026-10-02
status: 'Planned'
tags: [feature, trust, claude, codex, milestone-1, dynamic-workflows]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

Milestone 1, Item 7 (closes gap 8 in `plans/dynamic-workflows/dynamic-workflows.md` "Gaps found"). Size M. No dependencies.

Deviation from goal.md Item 7: "or one of its parents" is implemented as each CLI resolves it (canonical repo root, then parents up to the git toplevel for Claude; exact path then root git project for Codex). A trusted parent does not make a nested git repo trusted, which is the safe direction.

In a folder Claude has not trusted, interactive `claude` opens "Quick safety check: Is this a project you created or one you trust?" before it runs any prompt. A workflow step spawned there waits on that dialog forever. Codex keeps a per-project `trust_level` in `config.toml` and behaves differently when a folder is not trusted. Phase 2's runner must check trust before spawning a step and pause the run with `pausedReason: trust` instead of stalling (plan, "Permissions & trust"). Nothing in `src/main/` reads either trust store today.

### How trust actually resolves (verified 2026-10-02)

**Claude Code 2.1.286+ (2.1.288 present locally).** Global config file is `$CLAUDE_CONFIG_DIR/.claude.json` when `CLAUDE_CONFIG_DIR` is set, otherwise `~/.claude.json`. A legacy `<config home>/.config.json` takes precedence if it exists (`~/.claude/.config.json` here; absent on this machine). Trust is `projects["<abs path>"].hasTrustDialogAccepted === true`. Other per-project keys (`allowedTools`, `mcpServers`, `lastSessionId`, cost counters, …) are irrelevant and must not be read. The top level also holds `oauthAccount`, `userID` and caches; the helper reads only `projects`.

Resolution, read from the shipped binary and confirmed by launching interactive `claude` in four folders (TEST-011 repeats this):

| Probe | Path | Result |
|---|---|---|
| A | untracked subdir inside a worktree of a trusted repo | no dialog |
| B | a new `git init` repo nested inside a trusted worktree | **dialog** |
| C | `git worktree add` of the trusted repo placed in an unrelated temp dir | no dialog |
| D | plain temp dir, no git | **dialog** |
| E | non-git `outer/inner/leaf`, only `outer` trusted (scratch `CLAUDE_CONFIG_DIR`) | no dialog |
| F | `git init` repo `outer/nested`, only `outer` trusted (same scratch config) | **dialog** |

A–D re-run and E–F added on 2026-10-02 (Claude 2.1.286, tmux, no dialog accepted): all as listed.

So Claude, in order:
1. `CLAUDE_CODE_SANDBOXED` set (truthy) → trusted.
2. The **canonical repo root** of the cwd (the main checkout for a linked worktree; for a bare repo, the bare directory itself) has `hasTrustDialogAccepted: true` → trusted (probe C).
3. Walk from the cwd up through its parents; the first key with `hasTrustDialogAccepted: true` wins (probe A). The walk **stops at the cwd's git toplevel** when the cwd is inside a git work tree (probe B: the trusted parent above the nested repo is not consulted). Outside git it runs to `/`.
4. Otherwise untrusted.

On this machine the live worktree `…/tatsu/dynamic-workflows` has no `projects` entry; it is trusted through step 2 via the bare repo `…/tatsu`. Tatsu's default worktree location is `<repo>/../<repo>-worktrees/<branch>` (`src/main/worktree/worktree.ts:64-67`), a sibling of the repo, so step 2 is what normally covers Tatsu worktrees; parent inheritance alone would not.

**Codex** (not installed here; behaviour from the plan and the Codex source, `get_active_project` / `resolve_root_git_project_for_trust` in `codex-rs/core`). Config is `$CODEX_HOME/config.toml`, default `~/.codex/config.toml`. Codex canonicalizes `$CODEX_HOME` when it is set (`find_codex_home`, `utils/home-dir/src/lib.rs`) and builds the default `~/.codex` from the home dir without canonicalizing; `resolveCodexHome` (REQ-004) follows the same rule. Entries look like this (real file on this machine):

```toml
[projects."/Users/joseiciano/Documents/workspace"]
trust_level = "trusted"
```

`trust_level` is `"trusted"` or `"untrusted"`. Lookup: exact resolved cwd first, then the **root git project** of the cwd, computed as the *parent of the git common dir* (for a linked worktree of a normal repo that is the main checkout; for a bare repo at `/x/tatsu` it is `/x`). No general parent walk. This is unverified against a binary (TASK-001).

Source check (2026-10-02, `openai/codex` tags `rust-v0.129.0` and `rust-v0.160.0`; `codex-rs/config/src/config_toml.rs` `get_active_project`, `config/src/project_trust.rs`, `core/src/config/mod.rs:3459-3466`, `git-utils/src/trust.rs`): the order above is confirmed, with two corrections.
- Each candidate (cwd, then repo root) is tried as its canonical path first, then its original spelling. Nothing else is walked; the only upward search is finding the nearest ancestor with a `.git` entry, so a subdirectory of a normal repo resolves to its toplevel. From 0.149 on, a `.git` directory without `HEAD` is skipped and the search keeps going up.
- **From `rust-v0.149.0` on, the repo-root fallback is validated** (`git-utils/src/trust.rs` `resolve_root`). The worktree's gitdir must sit under a dir named `worktrees`, and its `gitdir`/`commondir` files must point back to this checkout and the same common dir. Then `<dirname(commonDir)>/.git` (a directory, or a `gitdir:` file) must canonicalize to `commonDir`. If any check fails, there is no repo-root fallback and only the exact cwd counts. A **bare** repo at `/x/tatsu` has no `/x/.git`, so on Codex ≥ 0.149 its worktrees are trusted **only** by an exact entry for the worktree path. `/x` no longer covers them. This machine is affected: worktrees of the bare `…/workspace/tatsu`, with only `[projects."…/workspace"]` trusted, are untrusted on current Codex. 0.129–0.148 return `dirname(commonDir)` without these checks.
- The session's default approval policy also comes from this lookup (`core/src/config/mod.rs:3737-3745`): `trusted` → `on-request`, `untrusted` → the internal `untrusted` policy, no entry → `on-request`.

This ticket adds the helper and its tests only. Consumers (Phase 2 runner pause, launch-sheet readiness check) are later work; this ticket fixes the API shape they will call.

## 1. Requirements & Constraints

- **REQ-001**: New package `src/main/folder-trust/` with `index.ts` (`export * from './folder-trust'`), `folder-trust.ts`, `folder-trust.test.ts`. No `types.ts` / `constants.ts` (types are few and live in `folder-trust.ts`).
- **REQ-002**: Public API, exported from `folder-trust.ts` exactly:
  ```ts
  export type TrustAgent = 'claude' | 'codex'
  export type TrustStatus = 'trusted' | 'untrusted' | 'unknown'
  export type TrustVia = 'env' | 'exact' | 'ancestor' | 'repo-root'
  export type TrustReason =
    | 'no-entry'
    | 'explicitly-untrusted'
    | 'config-missing'
    | 'config-unreadable'
    | 'config-malformed'

  export interface FolderTrustResult {
    agent: TrustAgent
    path: string
    status: TrustStatus
    via: TrustVia | null
    matchedKey: string | null
    reason: TrustReason | null
    configPath: string
  }

  export interface FolderTrustOptions {
    env?: NodeJS.ProcessEnv
    homeDir?: string
    claudeConfigPath?: string
    codexConfigPath?: string
  }

  export function claudeGlobalConfigPath(env?: NodeJS.ProcessEnv, homeDir?: string): string
  export function resolveCodexHome(env?: NodeJS.ProcessEnv, homeDir?: string): string
  export function codexConfigPath(env?: NodeJS.ProcessEnv, homeDir?: string): string
  export function checkClaudeFolderTrust(path: string, opts?: FolderTrustOptions): Promise<FolderTrustResult>
  export function checkCodexFolderTrust(path: string, opts?: FolderTrustOptions): Promise<FolderTrustResult>
  export function checkFolderTrust(
    path: string,
    opts?: FolderTrustOptions
  ): Promise<Record<TrustAgent, FolderTrustResult>>
  ```
  - `env` defaults to `process.env`, `homeDir` to `os.homedir()`. `claudeConfigPath` / `codexConfigPath` override path resolution entirely (tests use them).
  - `path` in the result is the resolved real path (REQ-005). `matchedKey` is the config key that decided the result (`null` when none). `via` is set only when `status === 'trusted'`. `reason` is set only when `status !== 'trusted'`.
  - `checkFolderTrust` runs both checks with `Promise.all`.
- **REQ-003**: `claudeGlobalConfigPath`: let `dir = env.CLAUDE_CONFIG_DIR?.trim()`. If `join(dir || join(homeDir, '.claude'), '.config.json')` exists (`existsSync`), return it. Otherwise return `join(dir || homeDir, '.claude.json')`.
- **REQ-004**: Codex home and config path.
  - `resolveCodexHome(env, homeDir)` is pure apart from one `realpathSync`: let `dir = env.CODEX_HOME?.trim()`. Non-empty → `realpathSync(dir)`, falling back to `dir` as given when `realpathSync` throws (does not exist yet). Empty, whitespace-only or unset → `join(homeDir, '.codex')`, **not** realpath'd (canonicalizing the default would change existing `~/.codex` trust keys, ticket 08 CON-002).
  - `codexConfigPath(env, homeDir) = join(resolveCodexHome(env, homeDir), 'config.toml')`.
  - `resolveCodexHome` lives here because `folder-trust` cannot import `../agents` (cycle). `src/main/agents/codex.ts` `codexHomeDir()` (ticket 08 REQ-010) imports it from `../folder-trust`; this is the only place the rule lives.
- **REQ-005**: Path normalization. `resolvePath(p)` = `await realpath(resolve(p))`, falling back to `resolve(p)` when `realpath` throws (path does not exist yet). All keys compared against config entries are the resolved path and its parents. A config key matches when it equals the candidate either as-is or after `.normalize('NFC')` on both sides, and after stripping one trailing `/` (except for `/`). Config keys are never realpath'd (they may point at deleted folders).
- **REQ-006**: Git layout resolution without spawning git, `findGitLayout(realPath)`:
  - Walk from `realPath` up through parents; the first directory containing a `.git` entry (file or directory, via `lstat`; a symlinked `.git` counts as not found, matching Claude) is `toplevel`.
  - `.git` is a directory → `commonDir = join(toplevel, '.git')`.
  - `.git` is a file → parse the first line `gitdir: <p>` (`p` resolved against `toplevel` when relative) → `gitDir`. If `join(gitDir, 'commondir')` exists, `commonDir = resolve(gitDir, <its trimmed content>)`, else `commonDir = gitDir`. Unparseable `.git` file → treat as not in git.
  - No `.git` entry found up to `/` → `null`. A path inside a bare repo's own git dir (no `.git` entry) is not special-cased.
  - Returns `{ toplevel, commonDir } | null`. All returned paths go through `resolvePath`.
- **REQ-007**: Claude canonical root = `basename(commonDir) === '.git' ? dirname(commonDir) : commonDir`. Codex repo root = `dirname(commonDir)`. They differ only for bare repos (CON-005).
- **REQ-008**: `checkClaudeFolderTrust(path)` order (first hit wins):
  1. `isTruthyEnv(env.CLAUDE_CODE_SANDBOXED)` (non-empty and not `'0'`/`'false'`, case-insensitive) → `trusted`, `via: 'env'`, `matchedKey: null`. Config is not read.
  2. Read and parse the config (REQ-010). On failure return the failure result.
  3. `layout = findGitLayout(real)`. If `layout`, let `root = canonicalRoot`. If `projects[root]?.hasTrustDialogAccepted === true` → `trusted`, `via: root === real ? 'exact' : 'repo-root'`.
  4. Walk `cur = real` upward. At each step, if `projects[cur]?.hasTrustDialogAccepted === true` → `trusted`, `via: cur === real ? 'exact' : 'ancestor'`. Stop after checking `layout.toplevel` when `layout` is non-null; otherwise stop after `/`.
  5. Else `untrusted`, `reason: 'no-entry'`.
  - Only the literal boolean `true` counts. `hasTrustDialogAccepted: false` on an entry does not stop the walk (Claude continues past it).
- **REQ-009**: `checkCodexFolderTrust(path)` order:
  1. Read and parse the config (REQ-010).
  2. `projects[real]?.trust_level`: `'trusted'` → `trusted`, `via: 'exact'`; `'untrusted'` → `untrusted`, `reason: 'explicitly-untrusted'`, `matchedKey: real`. Any other value is ignored.
  3. If `layout`, same two checks on `dirname(layout.commonDir)` with `via: 'repo-root'`, **only when** `basename(layout.commonDir) === '.git'` or `<dirname(commonDir)>/.git` is a `gitdir:` file that resolves to `commonDir`. This matches the validated lookup in Codex ≥ 0.149. For a bare repo, skip this step.
  4. Else `untrusted`, `reason: 'no-entry'`.
  - If TASK-001 finds the installed Codex also walks parents, add that walk as step 3b with `via: 'ancestor'` and a test; otherwise do not.
- **REQ-010**: Config reading, both agents. `readFile(configPath, 'utf8')`:
  - `ENOENT` → `untrusted`, `reason: 'config-missing'` (the CLI would show its first-run trust prompt).
  - Any other read error → `unknown`, `reason: 'config-unreadable'`.
  - Claude: `JSON.parse`; not a plain object → `config-malformed`. `projects` missing or not an object → treat as `{}`.
  - Codex: `parse` from `smol-toml`; throws → `config-malformed`. `projects` missing or not a table → `{}`.
  - `config-malformed` → `unknown`. Log once per call with `log('folder-trust', '<agent> config malformed', { configPath })` from `../debug`. Never log file contents.
- **REQ-011**: Each call re-reads the file. No cache, no watcher (a user accepting the dialog must be seen on the next check).
- **SEC-001**: The helper never writes, creates, chmods or locks `~/.claude.json`, `.config.json` or Codex `config.toml`. Only `readFile`, `realpath`, `lstat`, `stat`, `existsSync`, `realpathSync` are imported from `fs` / `fs/promises`. TEST-010 asserts the files are byte-identical and mtime-unchanged after a check.
- **SEC-002**: Only `projects` is read from the parsed object; nothing else (OAuth account, user IDs, MCP server env) is copied into the result, logged or returned.
- **CON-001**: No store slice, transport request, renderer change or runner wiring in this ticket. The helper is a plain async module.
- **CON-002**: Do not touch `src/main/claude-auth/` (it also reads `~/.claude.json` but always at `~/.claude.json`; aligning it with `CLAUDE_CONFIG_DIR` is out of scope).
- **CON-003**: Do not touch `src/main/agents/codex.ts` (`ensureCodexHooksEnabled` string-edits `config.toml`; Item 8 owns it).
- **CON-004**: No Claude `bypassPermissions` acceptance check here (ticket 06 RISK-002). It is a separate readiness item: Claude stores it as `skipDangerousModePermissionPrompt: true` in user/local/flag/policy settings (`~/.claude/settings.json` etc.; accepting the dialog writes the user settings file, verified 2026-10-02), and managed `disableBypassPermissionsMode` can forbid it. A later ticket can add `checkClaudeBypassAccepted()` alongside this helper with the same result shape.
- **CON-005**: Claude's and Codex's repo-root rules differ for bare repos (REQ-007). Keep both; do not unify.
- **GUD-001**: Follow AGENTS.md: package dir with barrel, imports through barrels, no comments beyond a one-line `why` if strictly needed. Run `pnpm typecheck`, `pnpm build`, `npx vitest run` before committing. One code commit, push; the gap-8 plan edit is a separate commit, push.
- **PAT-001**: Filesystem tests use real temp dirs (`mkdtemp(join(tmpdir(), 'folder-trust-'))`), like `src/main/fs-listing/fs-listing.test.ts`, and pass config paths through `FolderTrustOptions`. Because `tmpdir()` on macOS is a symlink (`/var` → `/private/var`), every key written into a fixture config is built from `await realpath(dir)`. Mock `../debug` with `vi.mock('../debug', () => ({ log: vi.fn() }))` as `src/main/agents/codex.test.ts:25-27` does.

## 2. Implementation Steps

### Implementation Phase 1: Verify Codex rules

- GOAL-001: The Codex lookup in REQ-009 matches a real binary, or the ticket records why it couldn't be checked.

- [x] **TASK-001**: Reuse the Codex install from ticket 05 TASK-001 (the milestone's single install); do not install separately. If that install has not happened, use the fallback below. With `codex` (≥ 0.129.0) available:
  - In a scratch dir, create `main/` (`git init`, one commit) and `git -C main worktree add ../wt`. With `CODEX_HOME` pointing at a temp copy of `~/.codex` (never edit the real one), set `[projects."<real main>"] trust_level = "trusted"` and start `codex` in `wt/`; record whether it asks to trust the folder. Repeat with only the scratch dir's parent trusted (tests parent inheritance), and with `trust_level = "untrusted"` on `wt`.
  - Record results in the commit message. If behaviour differs from REQ-009, change REQ-009's implementation and tests to match and note it in the gap-8 closing line.
  - If Codex can't be run, implement REQ-009 as written and note "Codex rules from source, unverified" in the commit and the gap-8 line.
  Result (2026-10-24): Codex is not installed on the dev machine (ticket 05 TASK-001 has not run). Fallback taken: REQ-009 is implemented as written from the `openai/codex` source read above; the rules table is "Codex rules from source, unverified" and is re-checked after ticket 06 Phase 0 (Task 21) once Codex is installed.

### Implementation Phase 2: Helper

- GOAL-002: `src/main/folder-trust/` implements REQ-001 to REQ-011.

- [ ] **TASK-002**: Works in either landing order with ticket 08 (its TASK-002 may have done part of this). Check the current base branch and do only what is missing: `smol-toml` not in `package.json` `dependencies` → `pnpm add smol-toml@^1.9.0` (zero dependencies; ships CJS `dist/index.cjs` and ESM). `'smol-toml'` not in `RUNTIME_PACKAGES` in `scripts/pack-headless.mjs` (`:139`) → add it, because the headless build externalizes runtime deps and only that list is copied into the tarball. The Electron build needs nothing extra (`externalizeDepsPlugin` + electron-builder ship `dependencies`).
- [ ] **TASK-003**: If `src/main/folder-trust/folder-trust.ts` already exists holding only `resolveCodexHome` / `codexConfigPath` (created by ticket 08 TASK-002), extend that file and its test in place, keeping one definition of each function. Otherwise create `src/main/folder-trust/folder-trust.ts` with the exports in REQ-002 (`env` and `homeDir` stay injectable parameters on `resolveCodexHome`, `codexConfigPath` and `claudeGlobalConfigPath`; only the defaults read `process.env` / `homedir()`) and private helpers `resolvePath`, `findGitLayout`, `claudeCanonicalRoot`, `codexRepoRoot`, `parentChain(start, stopAt | null)`, `keyLookup(map, candidate)` (REQ-005 matching), `isTruthyEnv`, `readClaudeProjects`, `readCodexProjects`. Imports: `readFile, realpath, lstat` from `fs/promises`; `existsSync, realpathSync` from `fs`; `homedir` from `os`; `dirname, basename, join, resolve` from `path`; `parse` from `smol-toml`; `log` from `../debug`.
  - Read helpers return `{ ok: true; projects: Record<string, unknown> } | { ok: false; status: 'untrusted' | 'unknown'; reason: TrustReason }`.
- [ ] **TASK-004**: Create `src/main/folder-trust/index.ts`: `export * from './folder-trust'`.

### Implementation Phase 3: Tests

- GOAL-003: `folder-trust.test.ts` covers TEST-001 to TEST-010.

- [ ] **TASK-005**: Fixture helpers inside the test file:
  - `makeRepo(root, name)`: creates `<root>/<name>/.git/` directory (contents irrelevant beyond existence) and returns its realpath.
  - `makeWorktree(mainGitDir, wtPath, id)`: creates `<mainGitDir>/worktrees/<id>/commondir` containing `../..\n`, and `<wtPath>/.git` file containing `gitdir: <mainGitDir>/worktrees/<id>\n`.
  - `makeBare(root, name)`: creates `<root>/<name>/` with `HEAD` and `worktrees/`; a worktree of it uses `commondir` `../..` from `<bare>/worktrees/<id>`.
  - `writeClaude(path, projects)`: writes `{ numStartups: 1, oauthAccount: { emailAddress: 'x@example.com' }, projects }`.
  - `writeCodex(path, entries: Record<string, string>)`: writes `[projects."<key>"]\ntrust_level = "<v>"\n` per entry, preceded by an unrelated `[features]\nhooks = true\n` table.
- [ ] **TASK-006**: Implement TEST-001 to TEST-010 with `describe('checkClaudeFolderTrust')`, `describe('checkCodexFolderTrust')`, `describe('config paths')`. Each test passes `env: {}` unless it is testing env.

### Implementation Phase 4: Verify and commit

- GOAL-004: CI-equivalent checks pass and the real machine agrees with the helper.

- [ ] **TASK-007**: Run `pnpm typecheck`, `pnpm build`, `npx vitest run`, and `pnpm build:headless && bash scripts/smoke-headless.sh` (TASK-002 touched the headless tarball list). All pass.
- [ ] **TASK-008**: Run TEST-011 (manual; needs the dev machine with tmux and an interactive, logged-in `claude`). An unattended implementer may skip it and write `TEST-011 not run` in the commit message.
- [ ] **TASK-009**: Commit (`Add read-only Claude/Codex folder-trust helper`), push.

### Implementation Phase 5: Close gap 8 in the plan

- GOAL-005: The plan records gap 8 as closed and states the verified trust rules.

- [ ] **TASK-010**: After the TASK-009 code commit, edit `plans/dynamic-workflows/dynamic-workflows.md` (re-grep the lines; numbers below are from 2026-10-03). `<hash>` is the hash from TASK-009 (the code commit).
  - Gap 8 (line starting `8. **Claude folder trust blocks unattended spawns.**`, ~69): replace `Trust carries down from a trusted parent folder.` with `Claude trusts a path when its canonical repo root, or the path or a parent up to its git toplevel, is trusted; a trusted parent does not cover a nested git repo.` Then append `Closed in <hash>: \`src/main/folder-trust\` reports read-only whether a path is trusted for Claude (\`projects[...].hasTrustDialogAccepted\` on the canonical repo root, or the path and its parents up to the git toplevel) and Codex (\`[projects."<path>"] trust_level\` on the path or its root git project). Tatsu never writes either file. Codex rules <verified on <ver> | from source, unverified>.`
  - "Harness research" table, row `Folder trust prompt` (~249): Claude cell becomes `yes; trusted if the canonical repo root (main checkout for worktrees) or the cwd/its parents up to the git toplevel is trusted (gap 8)`; Codex cell becomes `per-project \`trust_level\` in \`config.toml\`, checked on the cwd then its root git project`.
  - "Permissions & trust", bullet `**Claude folder trust**` (~372): replace `whether the worktree path or one of its parents is trusted` with `whether the worktree path is trusted, using each CLI's own rule (\`src/main/folder-trust\`)`.
  - Commit separately (`Mark workflows gap 8 closed`), push.

## 3. Alternatives

- **ALT-001**: Spawn `git rev-parse --show-toplevel --git-common-dir` instead of reading `.git` files. Rejected: a subprocess per check, and both CLIs resolve this from the filesystem themselves; the `.git` file format (`gitdir:` + `commondir`) is stable.
- **ALT-002**: Write a minimal regex reader for `[projects."…"] trust_level` instead of adding `smol-toml`. Rejected: quoted keys can contain escapes, Codex may write inline tables, and Item 8 needs to read `[hooks.state."<key>"] trusted_hash` from the same file. One real TOML parser serves both.
- **ALT-003**: Ask the CLIs (`claude` has no trust query; Codex only via `codex app-server`). Rejected: slow, needs the binary present, and the result is the same data.
- **ALT-004**: Pre-trust folders by writing `hasTrustDialogAccepted: true` / `trust_level = "trusted"`. Rejected by the plan: Tatsu never edits either file (SEC-001). The runner pauses with a "Trust folder" action instead.
- **ALT-005**: Cache parsed configs keyed by mtime. Rejected for now: `~/.claude.json` is ~90 KB and checks happen once per step spawn, not in a hot path (REQ-011).
- **ALT-006**: Return a plain boolean. Rejected: the launch sheet needs to distinguish "missing config" / "malformed" from "not trusted" and show which key granted trust.

## 4. Dependencies

- **DEP-001**: None on other milestone items. Can land in any order.
- **DEP-002**: New runtime dependency `smol-toml@^1.9.0` (MIT, no transitive deps).

## 5. Files

- **FILE-001**: `src/main/folder-trust/folder-trust.ts` (new). Helper implementation.
- **FILE-002**: `src/main/folder-trust/index.ts` (new). Barrel.
- **FILE-003**: `src/main/folder-trust/folder-trust.test.ts` (new). Unit tests.
- **FILE-004**: `package.json`, `pnpm-lock.yaml`. Add `smol-toml`.
- **FILE-005**: `scripts/pack-headless.mjs`. Add `'smol-toml'` to `RUNTIME_PACKAGES`.
- **FILE-006**: `plans/dynamic-workflows/dynamic-workflows.md`. Gap 8 and research row (separate commit).

## 6. Testing

All in `src/main/folder-trust/folder-trust.test.ts` unless noted. `T` = realpath of a fresh temp dir.

- **TEST-001** (Claude, trusted path): repo `T/app`; config `{ "<T/app>": { hasTrustDialogAccepted: true } }`; check `T/app` → `trusted`, `via: 'exact'`, `matchedKey: T/app`.
- **TEST-002** (Claude, trusted parent):
  - (a) non-git dir `T/outer/inner/leaf`, config trusts `T/outer` → `trusted`, `via: 'ancestor'`, `matchedKey: T/outer`.
  - (b) untracked subdir `T/app/sub` of repo `T/app`, config trusts `T/app` → `trusted` (`repo-root` from step 3, since `T/app` is also the canonical root).
  - (c) linked worktree `T/app-worktrees/feat` of repo `T/app`, config trusts `T/app` only → `trusted`, `via: 'repo-root'`.
  - (d) worktree of bare repo `T/bare` at `T/bare/wt`, config trusts `T/bare` → `trusted`, `via: 'repo-root'`.
- **TEST-003** (Claude, untrusted path):
  - (a) `T/plain` with config trusting only `T/other` → `untrusted`, `reason: 'no-entry'`.
  - (b) nested repo `T/outer/nested` (own `.git/`) with config trusting `T/outer` → `untrusted` (walk stops at the git toplevel; matches probe B).
  - (c) entry `{ hasTrustDialogAccepted: false }` on the path and `true` on a non-git parent → `trusted`, `via: 'ancestor'`.
  - (d) entry with `hasTrustDialogAccepted: 'true'` (string) → `untrusted`.
- **TEST-004** (Claude, missing config): config path points at a non-existent file → `untrusted`, `reason: 'config-missing'`, `configPath` echoed.
- **TEST-005** (Claude, malformed): config contains `{not json` → `unknown`, `reason: 'config-malformed'`; `log` mock called once with category `'folder-trust'` and no file contents. Config `[]` → `unknown`, `config-malformed`. Config `{}` → `untrusted`, `no-entry`.
- **TEST-006** (Claude, symlink and normalization):
  - (a) `T/link` symlinks to repo `T/app`; config trusts `T/app`; check `T/link` → `trusted`, result `path` is `T/app`.
  - (b) config key `T/app/` (trailing slash) matches `T/app`.
  - (c) config key in NFD for a folder named `café` matches the NFC path.
  - (d) `CLAUDE_CODE_SANDBOXED: '1'` with a missing config → `trusted`, `via: 'env'`; `'0'` → falls through to `config-missing`.
- **TEST-007** (Codex): trusted path (`via: 'exact'`); worktree `T/app-worktrees/feat` of `T/app` with only `T/app` trusted (`via: 'repo-root'`, `matchedKey: T/app`); bare worktree `T/bare/wt` is **not** trusted through `T` or `T/bare` (`untrusted`, `no-entry`; Codex ≥ 0.149 skips the repo-root fallback for bare repos), only by an exact `T/bare/wt` entry; `trust_level = "untrusted"` on the exact path → `untrusted`, `reason: 'explicitly-untrusted'`, even when the repo root is trusted; non-git dir under a trusted parent → `untrusted`, `no-entry` (unless TASK-001 adds ancestor walk).
  - Optional: worktree of a submodule (commonDir `T/super/.git/modules/x`, so `basename` is not `.git`) with `T/super/.git/modules` trusted → falls through to the second clause of REQ-009 step 3, which fails (no `T/super/.git/modules/.git`) → `untrusted`, `no-entry`.
  - Not implemented: Codex ≥ 0.149 also checks that the worktree's gitdir sits under a dir named `worktrees` and that its `gitdir`/`commondir` files point back. Known approximation; it can only err toward `trusted` if those gitdir files are forged.
- **TEST-008** (Codex, missing/malformed): missing file → `untrusted`, `config-missing`; `[projects."x"` (unterminated) → `unknown`, `config-malformed`; file with only `[features]` → `untrusted`, `no-entry`.
- **TEST-009** (config paths): `claudeGlobalConfigPath({}, '/h')` → `/h/.claude.json`; with `CLAUDE_CONFIG_DIR: '/c'` → `/c/.claude.json`; when `<dir>/.config.json` exists in a temp `CLAUDE_CONFIG_DIR` → that path. `codexConfigPath({}, '/h')` → `/h/.codex/config.toml`. `resolveCodexHome`: `{}` → `/h/.codex`; `CODEX_HOME: '   '` → `/h/.codex` (whitespace-only counts as unset); `CODEX_HOME` = a non-existent `T/nope` → `T/nope` as given; `CODEX_HOME` = `T/link`, a symlink to temp dir `T/real` → `T/real` (resolved spelling), and `codexConfigPath` → `T/real/config.toml`; `CODEX_HOME` = `tmpdir()`-based path passed unresolved (`/var/…` on macOS) → its `realpath` spelling. `checkFolderTrust` returns both keys `claude` and `codex`.
- **TEST-010** (read-only): after running every check above against a fixture config, the config files' bytes and `mtimeMs` are unchanged and no new files exist in the config dir.
- **TEST-011** (manual, required before merge): on the dev machine, call the helper from a temporary, uncommitted vitest file that uses the default options (real `~/.claude.json`, real `~/.codex/config.toml`) for: this worktree (expect Claude `trusted` via `repo-root` key `…/tatsu`); a fresh `mktemp -d` (expect `untrusted`); a fresh `git init` inside this worktree (expect `untrusted`). Then launch interactive `claude` in the latter two with `tmux new-session -d … claude` and confirm the "Quick safety check" dialog appears, and does not appear in this worktree. Do **not** accept any dialog; kill the sessions and delete the probe dirs. Record results in the commit message, or `TEST-011 not run` if skipped (TASK-008). The temporary vitest file must not be committed; delete it afterwards.
- **TEST-012**: `pnpm typecheck`, `pnpm build`, `npx vitest run`, headless smoke all pass.

## 7. Risks & Assumptions

- **RISK-001**: Claude's trust rules come from a minified binary (2.1.286) plus four probes; a later Claude version may change them (e.g. widen parent inheritance). A false `untrusted` only pauses a run that would have worked (safe direction); a false `trusted` stalls a step on the dialog. TEST-011 should be re-run when bumping the bundled Claude.
- **RISK-002**: Codex rules are checked against source but not against a binary (TASK-001). Codex 0.129–0.148 used the bare dir's parent as the root git project for bare-repo worktrees, so a broad key (e.g. `workspace/`) could decide. ≥ 0.149 drops that fallback (REQ-009 step 3). On an old Codex the helper can then report `untrusted` where the CLI would trust; that is the safe direction.
- **RISK-003**: Claude also accepts trust for a session only (in-memory, e.g. home-directory acceptance is not persisted). The helper cannot see it and reports `untrusted`. Acceptable: workflow steps spawn new processes.
- **RISK-004**: Terminal tabs use the user's PATH `claude` while chat tabs use the bundled SDK binary; both share `~/.claude.json`, but the env that decides `CLAUDE_CONFIG_DIR` is the PTY's login shell env, which may set it in `.zshrc` while main's `process.env` does not. Consumers that care can pass `env` explicitly.
- **ASSUMPTION-001**: The worktree path passed in is absolute or resolvable from main's cwd; consumers pass `WorktreeInfo.path`.
- **ASSUMPTION-002**: `smol-toml` parses Codex's `config.toml` (TOML 1.0, written by `toml_edit`).

## 8. Related Specifications / Further Reading

- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/goal.md`, Item 7
- `plans/dynamic-workflows/dynamic-workflows.md`: "Gaps found" (gap 8), "Permissions & trust" ("Claude folder trust", "Codex hook trust"), "Harness research" (row "Folder trust prompt"), Run `pausedReason: trust`
- `plans/dynamic-workflows/milestones/milestone-1-prerequisites/tickets/06-permission-levels.md` RISK-002 (bypassPermissions acceptance; see CON-004)
- Item 8 (Codex hook trust): will reuse `smol-toml`, `resolveCodexHome()` (as `codexHomeDir()` in `agents/codex.ts`) and `codexConfigPath()` from this package to read `[hooks.state."<key>"] trusted_hash`
- `src/main/claude-auth/claude-auth.ts` (existing read-only `~/.claude.json` reader), `src/main/worktree/worktree.ts:64-67` (`defaultWorktreeDir`)
- smol-toml: https://github.com/squirrelchat/smol-toml
