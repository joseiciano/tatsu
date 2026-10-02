# Phase 1 — setting and metadata plumbing

## Deliverable

User can toggle and persist feature flag, and shared state can represent
containerized worktrees. No Docker commands run in this phase.

System contracts: [`../System-Design.md`](../System-Design.md).

## Files

- `src/shared/state/settings/types.ts`
  - add `enableWorktreeContainers: boolean` to `SettingsState`.
  - add event `{ type: 'settings/enableWorktreeContainersChanged'; payload: boolean }`.
- `src/shared/state/settings/constants.ts`
  - default `enableWorktreeContainers: false` in `initialSettings`.
- `src/shared/state/settings/settings.ts`
  - reducer case returns `{ ...state, enableWorktreeContainers: event.payload }`.
- `src/shared/state/index.ts`
  - add events to `StateEvent`, route reducer cases, update `initialState`, and
    backfill missing setting/container metadata in `mergeWireSnapshot`.
- `src/main/persistence/types.ts`
  - add `enableWorktreeContainers?: boolean` to `Config`.
  - add `worktreeContainers?: Record<string, PersistedWorktreeContainer>` to `Config`.
- `src/main/build-initial-state/build-initial-state.ts`
  - hydrate with `config.enableWorktreeContainers === true`.
- `src/main/index.ts`
  - add `config:setEnableWorktreeContainers` request handler.
  - persist `true` as config field, delete field on `false` to keep absent = default.
  - dispatch `settings/enableWorktreeContainersChanged` after save.
- `src/renderer/types/types.ts`
  - add `setEnableWorktreeContainers(enabled: boolean): Promise<boolean>`.
- `src/renderer/components/Settings/Settings.tsx`
  - add toggle in Experimental section.
  - read from `useSettings()`; mutate through backend only.
- `src/shared/state/worktrees/types.ts`
  - add optional `Worktree.container` metadata:
    - `id`
    - `name`
    - `image`
    - `workdir`
    - `shell`
    - `status: 'starting' | 'running' | 'stopped' | 'error'`
    - `error?: string`

## Tests

- `src/shared/state/settings/settings.test.ts`
  - reducer handles `enableWorktreeContainersChanged` true and false.
- `src/main/build-initial-state/build-initial-state.test.ts`
  - config `true` hydrates true; missing/false hydrates false.
  - persisted container metadata loads when Docker status is not yet known.
- `src/shared/state/wire-merge.test.ts`
  - old wire snapshot missing setting backfills `false`.
- `src/shared/state/worktrees/worktrees.test.ts`
  - worktree entries with no `container` still reduce unchanged.
  - `worktrees/containerUpdated` patches one worktree and preserves others by reference.

## Verification

- Toggle survives restart.
- Renderer mirror updates from store event with no local duplicate state.
- `pnpm typecheck`
- targeted vitest for files above.

## Outcome

Toggle exists but no behavior change yet if manager is not wired.
