# Tatsu chat-agent verification map

This directory is the maintained source for verifying the OpenCode and Codex chat-agent work in Tatsu. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- `pnpm build:headless` has run since the last code change.
- `RUN=$(node .claude/skills/verify/scripts/control.mjs start)` launched the headless server with a disposable data dir, and `doctor` reported `problems: []`.
- A fixture repo exists at `$RUN/fixture-repo` with one commit, was added with `req repo:addAtPath`, and `$WT` holds its realpath from `worktrees.list`.
- `req panes:ensureInitialized "$WT"` has run.
- `C=.claude/skills/verify/scripts/control.mjs` in the shell.
- Never drive an instance that this verification run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Use the request and signal names exactly as written; they are the main process's transport handler names.
- Read chat entries with `req jsonClaude:getEntries <id>`; the state snapshot omits them.
- Use `wait <dot.path> <jsExpr>` for every asynchronous step instead of fixed sleeps.
- Send a prompt before asserting anything about the agent process: `jsonClaude:start` registers the session, the first `jsonClaude:send` spawns the agent.
- Pass `--save <name>` on the `req`, `get` or `wait` that captures the proof.

## Proof and skip reporting

- Capture the state before and after a transition, not only the final state.
- A chat journey is proved by the agent's own entries (`kind: "assistant"`, `kind: "error"` with `errorKind`), never by the user entry alone.
- Mutation proof includes a second read: `config.json` in `$RUN/data` for persistence, the file on disk for an agent edit.
- Record the feature ID and the session id used with every artifact.
- Report an unreachable path with the command attempted and the unmet precondition (usually agent credentials).
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control.mjs` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Experimental chat-agents flag](./chat-agents-flag.md) covers the default-off gate on OpenCode and Codex chat, the Settings toggle, and persistence.
- [ACP chat session and login](./acp-chat-session.md) covers opening an OpenCode or Codex chat tab, the first prompt, the auth-failure card, and the OpenCode login terminal.
- [Session continuity](./session-continuity.md) covers the agent session id surviving a restart and a terminal-to-chat conversion.
- [Tool approvals](./tool-approvals.md) covers the approval card for an agent tool call, allow, reject, and always-allow.
- [Bundled runtimes and first-use download](./runtime-packaging.md) covers the packaged app's staged runtimes, the download manifest, and the download card.
