# Phase 5 — UX polish

## Status: future / not yet implemented

Current UI has the Settings toggle for enabling worktree containers only.
Container badges, status labels, restart/recreate actions, and the
Open shell action described below are planned but not implemented.

## Deliverable

Container state is visible and recoverable from UI.

System contracts: [`../System-Design.md`](../System-Design.md).

## Files likely touched

- worktree row/detail components under `src/renderer/components/`.
- shared repo config types under `src/shared/state/repo-configs/types.ts`.
- repo config read/write in `src/main/repo-config/repo-config.ts` only when adding editable fields.
- backend API + main handlers for restart/retry actions.

## UI rules

- show small container badge only when `worktree.container` exists.
- use canonical `text-*` sizes and `icon-*` classes.
- status text:
  - running: `Container running`
  - starting: `Container starting`
  - stopped: `Container stopped`
  - error: show short error and retry affordance.

## Actions

- Restart container: stop then start existing container.
- Recreate container: remove old container and create from current config.
- Open shell: create normal terminal pane; existing PTY routing handles Docker.

## Deferred UX

- full repo-config editor for image/dockerfile/ports.
- dynamic port allocation display.
- orphan container cleanup UI.

## Tests

- renderer component test for badge visibility and status labels if existing test harness supports it.
- reducer/request tests for restart/recreate status updates.

## Verification

- Container badge appears only for containerized worktrees.
- Status labels match metadata status.
- Restart/recreate actions update shared state and surface errors.
- `pnpm typecheck`

## Outcome

Users can see and recover containerized worktree state without reading logs.
