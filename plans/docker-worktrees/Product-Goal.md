# Dockerized Worktrees — Product Goal

## Goal

Add an optional mode where newly created worktrees run setup scripts, terminals, and agent commands inside dedicated Docker containers while the git worktree remains on the host filesystem.

## Benefits

- Isolates each worktree runtime from the host and from other worktrees.
- Preserves existing host-side workflows: git state, changed-file detection, PR polling, editor integration, hooks, and filesystem watches.
- Creates foundation for per-worktree services later without changing first-slice scope.

## Product Approach

Use host git worktrees with companion containers, not container-only worktrees. Container-only worktrees would require a larger remote-filesystem abstraction and would break assumptions across git, editor, watcher, PR, and changed-file flows.

Each new containerized worktree gets one long-lived container. If future infrastructure services are needed, they should be unique to that worktree rather than shared across unrelated worktrees.

## User-Facing Behavior

- Settings exposes **Enable worktree containers** in Experimental.
- Default is off.
- Toggle affects future worktrees only. Existing worktrees remain unchanged.
- Docker availability is validated lazily during worktree creation, not when saving Settings.
- Docker failures surface through existing pending-worktree error UI with actionable guidance.

## First-Slice Non-Goals

- No attempt to run Harness main inside each worktree container.
- No migration of existing worktrees into containers.
- No Docker Compose orchestration UI.
- No automatic image authoring beyond documented defaults.
- No hosted or multi-tenant container scheduler.
- No UI for editing image, Dockerfile, ports, or credential-sharing fields.

## Open Product Follow-ups

- Containerize existing worktree action.
- Share agent credentials with containers setting.
- Dynamic per-worktree port allocation and display.
- Orphan container cleanup UI.
- Docker Compose or multi-container service orchestration.
