# Phase 4 — deletion and recovery

## Deliverable

Container lifecycle is bounded. Deleting worktree removes its container; app
restart recovers container status.

System contracts: [`../System-Design.md`](../System-Design.md).

## Deletion files

- `src/main/worktree-deletion-fsm/worktree-deletion-fsm.ts`
  - current order: optional teardown → `removeWorktree()` → refresh list.
  - new order for containerized worktrees:
    1. optional teardown using container executor if container running.
    2. stop container.
    3. remove container.
    4. remove host worktree.
    5. refresh list.
  - extend `PendingDeletion.phase` union with `removing-container` before
    `removing-worktree`.
- `src/main/index.ts`
  - pass container manager/resolver into deletion FSM construction.

## Failure policy

- teardown fails: preserve current behavior unless existing force semantics say otherwise.
- stop/remove container fails: deletion phase becomes `failed`; host worktree is
  not removed by default.
- `force: true` may remove host worktree after failed container cleanup only if UI
  explicitly calls deletion with force; error text warns about orphan container.
- force does not mean `docker rm -f`; that requires separate explicit container cleanup request.
- host worktree removal fails after container removed: pending deletion failed; no container resurrection.

## Recovery files

- `src/main/worktree-containers/worktree-containers.ts`
  - add `listHarnessContainers()` using Docker label filter.
  - add `inspectContainer(idOrName)` to map running/stopped/error.
- `src/main/index.ts`
  - after initial worktree list is loaded, inspect `harness=true` containers.
  - match by `harness.worktreePath` label.
  - update matching `Worktree.container.status`.
  - log orphan containers with no matching host worktree; no UI action first slice.

## Tests

- create `src/main/worktree-deletion-fsm/worktree-deletion-fsm.test.ts`.
  - containerized deletion stops/removes container before `removeWorktree()`.
  - stop/remove failure blocks host deletion and records pending error.
  - non-container deletion path unchanged.
- container manager tests label filter and inspect parsing.

## Verification

- Delete containerized worktree; `docker ps -a --filter label=harness=true` no longer lists it.
- Kill app while container exists, restart, worktree shows recovered running or stopped status.
- Orphan container is logged, not shown as fake worktree.
- `pnpm typecheck`

## Outcome

Lifecycle is bounded; fewer leaked containers.
