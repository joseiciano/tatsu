# Phase 3 — terminal execution

## Status: implemented

Currently only setup scripts execute inside containers via `docker exec`.
Terminal and agent panes for containerized worktrees still execute on the host.
This phase documents the planned PTY container routing.

## Deliverable

Terminals and agent panes for containerized worktrees execute inside companion
container.

System contracts: [`../System-Design.md`](../System-Design.md).

## Files

- `src/main/pty-manager/pty-manager.ts`
  - current `create(id, cwd, command, args, extraEnv, isShell, cols, rows)` spawns
    host command with `cwd` and env.
  - inject `WorktreeContainerResolver` dependency that maps host `cwd` to container metadata.
  - when resolver returns container metadata, spawn Docker CLI instead:
    - command: `docker`
    - args: `['exec', '-it', '-e', 'HARNESS_TERMINAL_ID=...', '-e', 'CLAUDE_HARNESS_ID=...', '--workdir', container.workdir, container.name, shell]`
    - host `cwd` remains original worktree path for Docker process.
  - preserve `HARNESS_TERMINAL_ID` and `CLAUDE_HARNESS_ID` env on host Docker process.
  - pass terminal identifiers and minimal terminal vars through `docker exec`.
- `src/main/index.ts`
  - `pty:create` signal receives host `cwd` today; keep renderer contract stable.
  - resolve container from current store by matching worktree path before calling
    `ptyManager.create()`; do not duplicate resolver logic in handler.

## Shell rules

- repo config shell wins.
- else `/bin/sh`.
- if shell is missing, report install/config guidance; do not silently fall back
  to host execution in first slice.
- agent command arguments are not trusted inside container unless image contains
  corresponding agent CLI.

## Failure policy

- missing container metadata: host behavior unchanged for non-container worktrees.
- persisted container metadata without live Docker status still routes to Docker and errors clearly.
- container status not running: terminal status becomes error with restart hint.
- Docker exec fails: terminal receives stderr and exits normally; do not crash main.

## Tests

- PTY manager unit tests or focused spawn-helper tests:
  - non-container worktree spawns original command/args.
  - container worktree spawns `docker exec -it -e HARNESS_TERMINAL_ID=... -e CLAUDE_HARNESS_ID=... --workdir /workspace <name> <shell>`.
  - stopped/missing container produces clear terminal error path.
- If direct `node-pty` mocking is awkward, extract pure command-resolution helper and test that.

## Verification

- Open terminal in containerized worktree; `pwd` returns `/workspace`.
- `touch from-container` in terminal creates file on host worktree.
- Non-container worktree terminal still starts login shell exactly as before.
- `pnpm typecheck`

## Outcome

Terminals and agent panes run inside container.
