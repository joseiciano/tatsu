# Phase 4 — deletion and recovery

## Deliverable

Container lifecycle is bounded. Deleting worktree removes its container; app
restart recovers container status.

System contracts: [`../System-Design.md`](../System-Design.md).

## Deletion files

- `src/main/worktree-deletion-fsm/worktree-deletion-fsm.ts`
  - current order: optional teardown → `removeWorktree()` → refresh list.
  - implemented containerized deletion order:
    1. `running-teardown`: optional teardown using container executor if container running.
    2. `removing-worktree`: stop/remove container, then remove host worktree.
    3. `failed`: any step failure.
  - `PendingDeletion.phase` union is `running-teardown | removing-worktree | failed`.
    Container cleanup is folded into `removing-worktree`, not a separate phase.
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

- `src/main/index.ts`
  - boot recovery reads persisted `config.worktreeContainers` metadata.
  - when Docker is available, verifies each entry with `isContainerRunning` to
    set `running`, `stopped`, or `error` status. No `listHarnessContainers` or
    `inspectContainer` methods exist; status is derived from persisted metadata
    plus a lightweight Docker check.
  - log orphan containers with no matching host worktree; no UI action first slice.

## Tests

- create `src/main/worktree-deletion-fsm/worktree-deletion-fsm.test.ts`.
  - containerized deletion stops/removes container before `removeWorktree()`.
  - stop/remove failure blocks host deletion and records pending error.
  - non-container deletion path unchanged.
- container manager tests label filter and inspect parsing.

## Verification

- Delete containerized worktree; `docker ps -a --filter label=tatsu.worktree.id` no longer lists it.
- Kill app while container exists, restart, worktree shows recovered running or stopped status.
- Orphan container is logged, not shown as fake worktree.
- `pnpm typecheck`

## Outcome

Lifecycle is bounded; fewer leaked containers.
