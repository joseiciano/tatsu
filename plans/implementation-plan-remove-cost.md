# Implementation Plan: Remove Cost Tracking

## Overview

This is a full removal of the cost-tracking feature, not a UI hide. The plan removes both the live tracking path and the historical aggregation path end-to-end:

- **Shared state and types** — delete the costs slice, pricing constants, and cost-summary helpers.
- **Main-process parsing and wiring** — delete the cost tracker, aggregator, JSONL fold parser, and Claude auth module; remove all construction and IPC handlers.
- **Renderer and backend API** — delete the costs hook, backend methods, and type declarations.
- **UI entry points** — delete the `CostPanel` and `ActivityCosts` components and remove them from all parent layouts.
- **Persisted and right-panel config** — remove costs from persisted config and from the right-panel key set.
- **Cleanup and verification** — search for lingering references, update comments, and run typecheck, build, and tests.

## 1. Remove shared cost domain types/state
- [ ] delete `src/shared/state/costs.ts`
- [ ] delete `src/shared/state/costs.test.ts`
- [ ] remove `CostsState`, `CostsEvent`, `initialCosts`, `costsReducer` from `src/shared/state/index.ts`
- [ ] remove `costs` from `AppState`, `StateEvent`, root reducer, and hydration logic
- [ ] delete `src/shared/pricing.ts`
- [ ] delete `src/shared/cost-summary.ts`

## 2. Remove main-process cost ingestion/parsing
- [ ] delete `src/main/cost-tracker.ts`
- [ ] delete `src/main/cost-tracker.test.ts`
- [ ] delete `src/main/cost-aggregator.ts`
- [ ] delete `src/main/cost-aggregator.test.ts`
- [ ] delete `src/main/jsonl-fold.ts`
- [ ] delete `src/main/claude-auth.ts`

## 3. Remove main-process wiring
- [ ] remove cost-related imports from `src/main/index.ts`
- [ ] remove `CostTracker` construction/start/stop from `src/main/index.ts`
- [ ] remove request handlers for `costs:setInterest`, `costs:getAllSessions`, `claude:getAuthStatus`
- [ ] remove persistence subscriber logic for `costs/*` events in `src/main/index.ts`

## 4. Remove persisted config support
- [ ] remove `costs` from `PersistedConfig` in `src/main/persistence.ts`
- [ ] remove any config hydration/default merging for persisted costs state

## 5. Remove renderer/backend API surface
- [ ] remove `setCostsInterest`, `getAllSessionCosts`, `getClaudeAuthStatus` from `src/renderer/types.ts`
- [ ] remove the same methods from `src/renderer/build-backend.ts`
- [ ] remove `useCosts()` from `src/renderer/store.ts`

## 6. Remove UI components
- [ ] delete `src/renderer/components/CostPanel.tsx`
- [ ] delete `src/renderer/components/ActivityCosts.tsx`

## 7. Remove UI integration points
- [ ] remove `CostPanel` from `src/renderer/components/RightColumn.tsx`
- [ ] remove `CostPanel` from `src/renderer/components/MobileRightPanel.tsx`
- [ ] remove cost label/config from `src/renderer/components/RightColumnToolbar.tsx`
- [ ] remove the costs tab from `src/renderer/components/Activity.tsx`
- [ ] remove `ActivityCosts` import/rendering from `src/renderer/components/Activity.tsx`

## 8. Remove right-panel config support
- [ ] remove `'cost'` from `RightPanelKey` in `src/shared/state/repo-configs.ts`
- [ ] remove `'cost'` from `DEFAULT_RIGHT_PANEL_ORDER`
- [ ] update any logic/tests that assume cost is a valid right-panel key

## 9. Clean up references and comments
- [ ] remove lingering cost-related comments in `src/renderer/components/RightPanel.tsx`
- [ ] search repo for `costs`, `CostPanel`, `ActivityCosts`, `getAllSessionCosts`, `getClaudeAuthStatus`, `setCostsInterest`
- [ ] remove stale plan/doc references if they should not remain

## 10. Verify
- [ ] run `pnpm typecheck`
- [ ] run `npx electron-vite build`
- [ ] run `npx vitest run`

## 11. Regression checks
- [ ] right sidebar still renders and panel ordering works
- [ ] Activity view still works with only remaining tabs
- [ ] app boots with old persisted config containing costs
- [ ] no IPC handler/method mismatch remains
- [ ] no transcript-parsing work still runs for cost purposes
