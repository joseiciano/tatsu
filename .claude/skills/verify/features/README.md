# Tatsu feature map

One file per user-facing feature. Each file says what the feature is, how a
user reaches it, how to drive it with the `verify` Playwright harness, and
what end state proves it works. Journeys reuse `scripts/browser.mjs`.

| Feature | File | Scripted journey |
|---|---|---|
| Config page inventory | [config-inventory.md](config-inventory.md) | `journeys/prefixed-skill-read.mjs` (proven: a `skills-used` Claude skill lists and opens, and an Opencode agent opens beside it), `journeys/linked-root-path.mjs` (proven: files in a symlinked Opencode agents folder and the symlinked `linked-skill` show at the configured path, save through to the link target, and keep the link), `journeys/linked-command-delete.mjs` (proven: deleting a linked command removes its target and the link, and the name can be created again as a regular file) |
| Skill ↔ command conversion | [skill-command-conversion.md](skill-command-conversion.md) | `journeys/convert-skill-to-command.mjs`, `journeys/convert-command-to-skill.mjs` (proven: both directions for Opencode, Claude "already available" notice) |
| Sync to disk | [config-sync.md](config-sync.md) | `journeys/config-disk-source.mjs`, `journeys/config-edit-and-sync.mjs` (proven: no badges on hand-written files, editor Save, outside edits kept by Sync) |
| Config folders in Settings | [config-folders-settings.md](config-folders-settings.md) | `journeys/config-folders.mjs` (proven: both entry points, relative-path rejection, override, reset) |
| Templates and fragments | [templates.md](templates.md) | `journeys/template-render-sync.mjs`, `journeys/template-fragments.mjs` (proven: create, fragments, reorder, remove, outside-change prompt, deletes, sync), `journeys/inline-fragments.mjs` (proven: `{{fragment:x}}` in a skill expands on Save, a fragment change reaches the file only through Sync, a hand-edited section is resolved with Use fragment) |
| Import existing setup | [import-existing-setup.md](import-existing-setup.md) | `journeys/import-existing-setup.mjs`, `journeys/import-full-setup.mjs` (proven: every folder kind) |

Unless a file says a step was run, its selectors and end states come from
reading the source. Treat them as a starting point, not as proof. The first
run that exercises one should fix the file and mark it as run.

Not yet mapped: worktrees (other than the code diff tool), terminal tabs, Claude chat tabs, PR status, the Command
Center tabs, and browser panes. Add a file here when you first prove one of
them.

## Chat-agent features

These features are driven with `scripts/control.mjs` (see [`../chat-agents.md`](../chat-agents.md)), not the Playwright journeys above. Their recipes follow the rules in this section.

### Baseline preconditions

- `pnpm build:headless` has run since the last code change.
- `RUN=$(node .claude/skills/verify/scripts/control.mjs start)` launched the headless server with a disposable data dir, and `doctor` reported `problems: []`.
- A fixture repo exists at `$RUN/fixture-repo` with one commit, was added with `req repo:addAtPath`, and `$WT` holds its realpath from `worktrees.list`.
- `req panes:ensureInitialized "$WT"` has run.
- `C=.claude/skills/verify/scripts/control.mjs` in the shell.
- Never drive an instance that this verification run did not start.

### Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Use the request and signal names exactly as written; they are the main process's transport handler names.
- Read chat entries with `req jsonClaude:getEntries <id>`; the state snapshot omits them.
- Use `wait <dot.path> <jsExpr>` for every asynchronous step instead of fixed sleeps.
- Send a prompt before asserting anything about the agent process: `jsonClaude:start` registers the session, the first `jsonClaude:send` spawns the agent.
- Pass `--save <name>` on the `req`, `get` or `wait` that captures the proof.

### Proof and skip reporting

- Capture the state before and after a transition, not only the final state.
- A chat journey is proved by the agent's own entries (`kind: "assistant"`, `kind: "error"` with `errorKind`), never by the user entry alone.
- Mutation proof includes a second read: `config.json` in `$RUN/data` for persistence, the file on disk for an agent edit.
- Record the feature ID and the session id used with every artifact.
- Report an unreachable path with the command attempted and the unmet precondition (usually agent credentials).
- Do not report a skipped entry point as verified through a different path.

### Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

### Features

- [Experimental chat-agents flag](./chat-agents-flag.md) covers the default-off gate on OpenCode and Codex chat, the Settings toggle, and persistence.
- [ACP chat session and login](./acp-chat-session.md) covers opening an OpenCode or Codex chat tab, the first prompt, the auth-failure card, and the OpenCode login terminal.
- [Session continuity](./session-continuity.md) covers the agent session id surviving a restart and a terminal-to-chat conversion.
- [Tool approvals](./tool-approvals.md) covers the approval card for an agent tool call, allow, reject, and always-allow.
- [Bundled runtimes and first-use download](./runtime-packaging.md) covers the packaged app's staged runtimes, the download manifest, and the download card.

## Code diff features

These features are driven with the code diff harness in `scripts/code-diff/` (see [`../code-diff.md`](../code-diff.md)), not the Playwright journeys above. It covers the code diff tool: a full-screen view that compares the active worktree (committed, uncommitted, and untracked changes) against a base ref the user chooses.

### Baseline preconditions

- `pnpm build:headless` ran after the last source change.
- `fixture.sh "$RUN"` and `launch.sh "$RUN"` ran for a fresh run root.
- `doctor.sh "$RUN"` prints only `ok` lines.
- Drive only the instance this run started.

### Driving conventions

- Start each journey from the fixture state unless the feature file says otherwise.
- Run journeys through `node .claude/skills/verify/scripts/code-diff/drive.mjs "$RUN" <journey>`.
- Prefer ARIA roles and accessible names, then visible text, then `title` attributes. Use CSS classes only where the Gotchas name the gap.
- The web client runs on macOS Chrome, so `Meta` is the Cmd modifier in hotkeys.

### Proof and skip reporting

- Capture the user action and the resulting state: every journey step logs one line in `steps.log` and takes a screenshot plus an ARIA snapshot at key points.
- Prove side effects outside the browser with a second read (`git rev-parse`, file contents).
- Record the sub-feature ID with every logged step.
- Report an unreachable entry point with the attempted command and the unmet precondition.

### Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs`, `Gotchas`.

### Features

- [Open and close](./open-close.md) covers the Diff button, the Cmd+Shift+C hotkey, the palette command, Escape, and the slot shared with Review.
- [Base ref](./base-ref.md) covers the default base, picking and typing refs, the invalid-ref and no-shared-history errors, and reset.
- [File navigation](./file-navigation.md) covers grouping by type or folder, file selection, the diff pane for each change kind, and j/k/[/] stepping.
- [Fetch](./fetch.md) covers updating the origin base from the summary bar.
- [Live refresh](./live-refresh.md) covers worktree edits appearing in the open tool without a manual refresh.
