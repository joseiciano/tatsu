# Phase 5 — UX polish

## Status: implemented

Container state is visible and recoverable through the sidebar. Status labels, restart/recreate actions, and the Open shell action described below are implemented.

## Deliverable

Container state is visible and recoverable from UI.

System contracts: [`../System-Design.md`](../System-Design.md).

## Request names

- Container restart/recreate: `worktrees:restartContainer`, `worktrees:recreateContainer`
- Renderer backend: `backend.restartWorktreeContainer(path)`, `backend.recreateWorktreeContainer(path)`

## UI rules

- show small container badge only when `worktree.container` exists.
- use canonical `text-*` sizes and `icon-*` classes.
- status text:
  - running: `Container running`
  - starting: `Container starting`
  - stopped: `Container stopped`
  - error: show short error and retry affordance.

## Actions

- Restart container: restart existing container in-place (non-destructive).
- Recreate container: remove old container and create from current `.harness.json` config.
- Open shell: add terminal tab to the worktree (handled by `handleAddTerminalTab`).

## Deferred UX

- full repo-config editor for image/dockerfile/ports.
- dynamic port allocation display.
- orphan container cleanup UI.

## Tests

- `src/main/worktree-containers/worktree-containers.test.ts` — `restartContainer`
- `src/main/worktree-container-actions/worktree-container-actions.test.ts` — `restartWorktreeContainer`, `recreateWorktreeContainer`
- `src/renderer/components/WorktreeTab/container-status.test.ts` — `containerStatusLabel`, `shortContainerError`

## Verification

- Container badge appears only for containerized worktrees.
- Status labels match metadata status.
- Restart/recreate actions update shared state and surface errors.
- `pnpm typecheck`

## Outcome

Users can see and recover containerized worktree state without reading logs.

These actions are wired through the backend as `worktrees:restartContainer` and `worktrees:recreateContainer` requests. The UI shows a compact container status badge below the worktree path, with action buttons (restart, recreate, open shell) appearing on hover. Error states show a truncated message (≤80 chars) with a retry button. Buttons are disabled while the container is in `starting` state.
