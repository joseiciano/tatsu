---
goal: Add shared harness configuration inventory and comparison state
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, shared-state, harness-config, sync]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

 This plan adds the shared `harnessConfig` state slice that mirrors lightweight harness resource inventory, scoped non-authorizing comparisons, request status, and scan/sync timestamps between Tatsu's main process and every renderer client. It implements Step 4 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md) using the product contract in [implementation-details.md](./implementation-details.md); actionable synchronization plans remain request-scoped and main-bound, while filesystem discovery, file content, Tatsu-config persistence, transport handlers, and editor drafts remain owned by other steps.

## 1. Requirements & Constraints

- **REQ-001**: Create `src/shared/state/harness-config/` with exactly `index.ts`, `harness-config.ts`, `types.ts`, and `harness-config.test.ts`; consumers outside the package MUST import through the package barrel.
- **REQ-002**: Define `HarnessConfigState` with exactly `resources`, `comparisons`, `loading`, `error`, `lastScannedAt`, and `lastSyncedAt`. Initialize the three resource arrays and the comparison map empty, `loading` false, and the error and timestamps null.
- **REQ-003**: `resources` MUST be `Record<HarnessConfigResourceType, HarnessConfigFileRef[]>` with the exact keys `agents`, `skills`, and `commands`. Each array represents one logical view and MAY contain multiple managed harnesses.
- **REQ-004**: `comparisons` MUST be `Partial<Record<HarnessConfigScopeKey, HarnessConfigComparison>>`, keyed by the full `${agentKind}:${resourceType}` scope. Define `HarnessConfigScopeKey` as the corresponding template-literal type and export `harnessConfigScopeKey(scope)` so producers and the reducer cannot accidentally key comparisons by resource type alone.
- **REQ-005**: Define `ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>` and `HarnessConfigScope { agentKind: ManagedHarnessKind; resourceType: HarnessConfigResourceType }`. `pi` MUST NOT be accepted as a managed scope in this first implementation.
- **REQ-006**: Reuse the canonical `HarnessConfigResourceType` exported by `src/shared/agent-registry`; do not declare another `agents | skills | commands` union in the slice.
- **REQ-007**: Place renderer-safe public file-reference, comparison, and synchronization-plan contracts in `src/shared/state/harness-config/types.ts`. `src/main/harness-config/` MUST import or re-export these shared contracts rather than maintaining structurally duplicated main-only wire types. `HarnessConfigSyncPlan` remains a request/response DTO and MUST NOT be a `HarnessConfigState` field or state-event payload.
- **REQ-008**: `HarnessConfigFileRef` MUST contain `id`, `agentKind`, current logical `resourceType`, `canonicalResourceType`, `aliasResourceTypes`, `label`, root-relative POSIX `relativePath`, normalized `absolutePath`, SHA-256 `hash`, `existsOnDisk`, `managed`, and `updatedAt`. It MUST NOT contain file content.
- **REQ-009**: `HarnessConfigComparison` MUST be serializable and contain exactly `scope`, `status`, `diskOnly`, `configOnly`, `changed`, and `comparedAt`. Define status as `synced | disk-only | config-only | conflict`, and each changed entry as an explicit `{ disk, config }` pair of file refs. A comparison MUST NOT contain `planId`, `direction`, `generatedAt`, `fingerprint`, executable operations, content, or apply authority.
- **REQ-010**: `HarnessConfigSyncPlan` MUST be serializable and contain exactly `planId`, required `scope`, `direction`, `status`, `diskOnly`, `configOnly`, `changed`, `generatedAt`, and opaque `fingerprint`. Define direction as `sync-to-disk | adopt-from-disk`. Executable operations and content MUST remain main-process-only, and the shared state MUST never mirror a plan as renderer authorization.
- **REQ-011**: Define exactly seven event variants: `harnessConfig/loadingChanged`, `harnessConfig/resourcesLoaded`, `harnessConfig/comparisonLoaded`, `harnessConfig/syncApplied`, `harnessConfig/resourceUpserted`, `harnessConfig/resourceDeleted`, and `harnessConfig/errorChanged`.
- **REQ-012**: `resourcesLoaded` MUST carry `{ scope, resources, scannedAt }` and replace only the selected harness within the selected logical resource array. Loading Claude Skills MUST leave Codex/OpenCode Skills and every Agents/Commands array untouched.
- **REQ-013**: `comparisonLoaded` MUST carry one `HarnessConfigComparison`, store it at `harnessConfigScopeKey(comparison.scope)`, and leave `lastSyncedAt` unchanged. The event MUST NOT accept a plan, `planId`, `direction`, `fingerprint`, `syncedAt`, or any other authorization-bearing field.
- **REQ-014**: `syncApplied` MUST carry only `{ scope, syncedAt }`, update `lastSyncedAt` to `syncedAt`, and be dispatched only after successful confirmed `sync-to-disk` or `adopt-from-disk` application. Read-only comparison, plan generation, scan/read, direct create/update/delete, failed or partial apply, cancellation, and dismissal MUST NOT dispatch it. The event records domain success only; it MUST NOT contain or confer plan authorization.
- **REQ-015**: `resourceUpserted` MUST carry one `HarnessConfigFileRef` and match within its logical resource array by `agentKind + id`. `resourceDeleted` MUST carry `{ agentKind, resourceType, id }` so deletion cannot remove another harness or a same-ID alias from a different logical view.
- **REQ-016**: `loadingChanged` MUST carry a boolean, `errorChanged` MUST carry `string | null`, and neither event may discard inventory, comparisons, or timestamps.
- **REQ-017**: The reducer MUST return the original slice object for semantic no-ops. Single-item upsert and delete paths MUST use `findIndex + slice`, preserve untouched entry references, and avoid `map` or `filter` for those mutations.
- **REQ-018**: Scoped inventory replacement MUST preserve references for resources belonging to other harnesses. If the scoped resource sequence is already the same object sequence, retain the existing array reference even when `lastScannedAt` advances.
- **REQ-019**: Resource arrays MUST remain deterministic by managed harness order `claude`, `codex`, `opencode`, then `relativePath`, then `id`. A new upsert MUST be inserted at its sorted position without rebuilding unchanged entries.
- **REQ-020**: Live editor drafts and file content MUST NOT enter `HarnessConfigState`, state events, initial snapshots, comparisons, or sync plans. The Config page owns drafts locally and loads content on demand through transport requests.
- **REQ-021**: Wire the slice into `src/shared/state/index.ts`: imports, public type exports, `AppState`, `StateEvent`, `initialState`, the `harnessConfig/` reducer branch, and `mergeWireSnapshot` MUST all include the new slice.
- **REQ-022**: `mergeWireSnapshot` MUST shallow-merge a received harness-config slice over `initialHarnessConfig`, preserving defaults for an older server that omits the entire slice or a recently added top-level field.
 - **REQ-023**: This step MUST NOT add main-process request handlers, filesystem access, Tatsu-config persistence, migrations, initial-state hydration from config, renderer components, or renderer-local drafts.
- **CON-001**: Shared slice files MUST remain browser-safe and MUST NOT import Node.js, Electron, main-process packages, or filesystem APIs.
- **CON-002**: No new runtime or development dependency is permitted.
- **GUD-001**: Follow existing slice conventions: contracts in `types.ts`, reducer and `initialHarnessConfig` in `harness-config.ts`, public `export *` statements in `index.ts`, exhaustive event handling, and package-local tests importing from `.`.
- **PAT-001**: Follow the identity-preserving single-entry pattern in `src/shared/state/worktrees/worktrees.ts`: locate the entry once, return state when absent or unchanged, and rebuild only the affected array with prefix and suffix slices.

## 2. Implementation Steps

### Implementation Phase 1: Define shared contracts

- **GOAL-001**: Establish one browser-safe domain contract for harness scopes, resource references, non-authorizing comparisons, request-scoped synchronization plans, state, and events.

- [ ] **TASK-001**: Create `src/shared/state/harness-config/types.ts` and import `HarnessConfigResourceType` from `src/shared/agent-registry` plus `AgentKind` from the terminals slice barrel.
  - Define `ManagedHarnessKind`, `HarnessConfigScope`, `HarnessConfigScopeKey`, `HarnessConfigFileRef`, `HarnessConfigSyncDirection`, `HarnessConfigSyncStatus`, `HarnessConfigChangedRef`, `HarnessConfigComparison`, `HarnessConfigSyncPlan`, `HarnessConfigState`, and `HarnessConfigEvent` exactly as required by REQ-002 through REQ-016.
  - Type `comparisons` as a scope-keyed partial record of `HarnessConfigComparison`; keep `HarnessConfigSyncPlan` available only as a request/response DTO, never as a state field or state-event payload.
  - Use mutable arrays in state to match existing slice contracts, but use only serializable primitive/object/array fields.
- [ ] **TASK-002**: Define the seven-event discriminated union in `types.ts` with exact payloads.
  - `loadingChanged`: `boolean`.
  - `resourcesLoaded`: `{ scope: HarnessConfigScope; resources: HarnessConfigFileRef[]; scannedAt: number }`.
  - `comparisonLoaded`: `HarnessConfigComparison`.
  - `syncApplied`: `{ scope: HarnessConfigScope; syncedAt: number }`.
  - `resourceUpserted`: `HarnessConfigFileRef`.
  - `resourceDeleted`: `{ agentKind: ManagedHarnessKind; resourceType: HarnessConfigResourceType; id: string }`.
  - `errorChanged`: `string | null`.
  - Do not add a sync-plan-loaded event; a comparison carries no optional success timestamp.
- [ ] **TASK-003**: Create `src/shared/state/harness-config/index.ts` and export every public type and reducer helper through `export * from './types'` and `export * from './harness-config'`.
  - Do not expose a second deep-import path from `src/shared/state/index.ts`; that root may re-export the package types only through `./harness-config`.

### Implementation Phase 2: Implement the identity-safe reducer

- **GOAL-002**: Apply scoped inventory, comparison, and confirmed-success events without cross-harness leakage, renderer authorization state, or avoidable reference churn.

- [ ] **TASK-004**: Create `src/shared/state/harness-config/harness-config.ts` with `initialHarnessConfig` and `harnessConfigScopeKey(scope)`.
  - Initialize `resources` to `{ agents: [], skills: [], commands: [] }`, `comparisons` to `{}`, `loading` to `false`, `error` to `null`, and both timestamps to `null`.
  - Return keys in the exact `${scope.agentKind}:${scope.resourceType}` format.
- [ ] **TASK-005**: Implement `harnessConfigReducer` branches for `loadingChanged` and `errorChanged`.
  - Return the original state when the incoming primitive equals the stored value.
  - Change only the targeted field and preserve all other references.
- [ ] **TASK-006**: Implement scoped `resourcesLoaded` replacement.
  - Validate behavior by scope rather than trusting that the map is globally replaced: remove only entries whose `agentKind` matches `scope.agentKind` from `resources[scope.resourceType]`, merge the supplied scoped resources, and leave the other two resource arrays untouched.
  - Keep unaffected ref objects, apply the deterministic ordering from REQ-019, reuse the existing target array when its ordered object sequence is unchanged, and set `lastScannedAt` to `scannedAt`.
- [ ] **TASK-007**: Implement `comparisonLoaded` using `harnessConfigScopeKey(comparison.scope)`.
  - Replace only that comparison-map entry and retain all other harness/resource comparisons.
  - Reuse `comparisons` and return the original state when the stored comparison is the same object.
  - Never change `lastSyncedAt` from comparison status or `comparedAt`; the event has no plan ID, fingerprint, direction, or success timestamp.
- [ ] **TASK-008**: Implement `syncApplied` as the sole reducer path that records sync/adopt success.
  - Update only `lastSyncedAt` from `payload.syncedAt`, retain resources and comparisons by reference, and return the original state when the timestamp is unchanged.
  - Consume the required scope only as success-event context; do not derive, retain, or expose plan authority from it.
- [ ] **TASK-009**: Implement `resourceUpserted` with `findIndex + slice`.
  - Select the array from `payload.resourceType` and match by `payload.agentKind + payload.id`.
  - Return state when the existing entry is the same object; replace only the matched slot when present; otherwise insert at the deterministic sorted position.
  - Preserve both sibling entry references and the other resource-array references.
- [ ] **TASK-010**: Implement `resourceDeleted` with `findIndex + slice`.
  - Search only `resources[payload.resourceType]` for the matching `agentKind + id`.
  - Return the original state when absent; otherwise remove the one matching slot while preserving every untouched ref and unrelated array.
- [ ] **TASK-011**: Add exhaustive default handling for `HarnessConfigEvent` and ensure no reducer event clears `error` implicitly.
  - Error clearing remains an explicit `harnessConfig/errorChanged` event so transport handlers control request lifecycle deterministically.

### Implementation Phase 3: Integrate the root state and wire merge

- **GOAL-003**: Make the new slice part of the authoritative main state, renderer mirror, event union, and version-skew-safe snapshot contract.

- [ ] **TASK-012**: Update `src/shared/state/index.ts` to import `initialHarnessConfig`, `harnessConfigReducer`, `HarnessConfigEvent`, and `HarnessConfigState` from `./harness-config` and re-export all public harness-config contracts needed by main, preload, and renderer consumers.
  - Add `harnessConfig: HarnessConfigState` to `AppState`.
  - Add `HarnessConfigEvent` to `StateEvent`.
  - Add `harnessConfig: initialHarnessConfig` to `initialState`.
- [ ] **TASK-013**: Add the `harnessConfig/` route to `rootReducer`.
  - Invoke only `harnessConfigReducer(state.harnessConfig, event as HarnessConfigEvent)`.
  - If the slice reducer returns the current slice object, return the current root state; otherwise replace only `state.harnessConfig`.
- [ ] **TASK-014**: Add `harnessConfig: { ...initialState.harnessConfig, ...state.harnessConfig }` to `mergeWireSnapshot`.
  - Preserve the existing per-slice shallow-merge strategy and do not deep-merge inventory or comparison maps.

### Implementation Phase 4: Prove behavior and deliver

- **GOAL-004**: Verify every event, scoping invariant, authority boundary, reference-identity guarantee, and snapshot-skew path before committing the slice.

- [ ] **TASK-015**: Create `src/shared/state/harness-config/harness-config.test.ts` with typed file-ref, comparison, plan, scope, and state fixture builders; import the package API from `.`.
  - Keep fixtures content-free and use stable timestamps, hashes, IDs, and paths.
  - Use plan fixtures only to prove the distinct public DTO shape; never place them in state or a state event.
- [ ] **TASK-016**: Add at least one reducer test for each of the seven event variants.
  - Assert the exact target-field change and prove unrelated fields, resource arrays, comparison entries, and timestamps remain unchanged.
  - Prove `comparisonLoaded` cannot change `lastSyncedAt`, while a distinct `syncApplied` updates only `lastSyncedAt` after the producer's successful confirmed sync/adopt path.
- [ ] **TASK-017**: Add scoped inventory and comparison isolation tests.
  - Prove loading one Claude resource scope preserves Codex and OpenCode rows in the same logical array and preserves the other two logical arrays by reference.
  - Prove Skills and Commands comparisons for the same harness occupy different keys, and the same resource type for two harnesses occupies different keys.
  - Prove a same-ID Claude alias in another logical view is not removed by a scoped delete.
- [ ] **TASK-018**: Add reducer identity and ordering tests.
  - Prove missing deletes, identical loading/error values, same-object comparisons, unchanged success timestamps, and same-object upserts return the original state.
  - Prove upsert and delete preserve untouched sibling object references, use deterministic harness/path/id ordering, and do not allocate unrelated resource arrays.
  - Prove a repeated `resourcesLoaded` event with the same scoped object sequence preserves the resource-array reference while updating `lastScannedAt`.
- [ ] **TASK-019**: Update `src/shared/state/wire-merge.test.ts` with one missing-slice case and one partial-slice case.
  - Assert an older snapshot with no `harnessConfig` receives `initialHarnessConfig`.
  - Assert a snapshot carrying inventory, comparisons, and loading but omitting `lastSyncedAt` preserves sent values and fills `lastSyncedAt` from the initial default.
- [ ] **TASK-020**: Run `npx vitest run src/shared/state/harness-config/harness-config.test.ts src/shared/state/wire-merge.test.ts`, then run `pnpm typecheck` and `pnpm build`; resolve every failure without weakening scoping, comparison/plan separation, serializability, or identity assertions.
- [ ] **TASK-021**: Update `src/main/harness-config/types.ts` and `src/main/harness-config/index.ts` to remove duplicate public file-ref, scope, resource-type, changed-ref, comparison, and sync-plan declarations in favor of imports and re-exports from `src/shared/state/harness-config` and `src/shared/agent-registry`.
  - Keep actionable plans request-scoped, keep private executable operations, content snapshots, fingerprints used for apply validation, and filesystem-only error internals in main, and never route an actionable plan through shared state.
  - Do not implement transport or persistence behavior in this step.
- [ ] **TASK-022**: Commit the slice, root integration, and tests as one focused change with message `feat: add harness config shared state`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Do not include unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Key `comparisons` only by `resourceType`. Rejected because Claude Skills and Codex Skills would overwrite each other and show one harness's conflict state in another harness's UI.
- **ALT-002**: Store resources under nested `agentKind -> resourceType` maps. Rejected for this step because the required public state shape groups the three Config-page logical views directly; scoped reducer payloads still preserve harness isolation inside each view.
- **ALT-003**: Store file contents and editor drafts beside resource refs. Rejected because contents are potentially large and sensitive, would inflate every snapshot/event, and drafts are per-client UI state rather than shared world state.
- **ALT-004**: Import `HarnessConfigFileRef`, `HarnessConfigComparison`, and `HarnessConfigSyncPlan` from `src/main/harness-config`. Rejected because shared state is bundled into renderer and web clients and may not depend on main-process code.
- **ALT-005**: Replace resources with `filter`/`map` for each single-item mutation. Rejected because missing IDs still allocate arrays and notify selectors; `findIndex + slice` provides an explicit no-op path and preserves untouched references.
- **ALT-006**: Infer `lastSyncedAt` whenever a comparison reports `status: 'synced'`, or attach `syncedAt` to `comparisonLoaded`. Rejected because a read-only comparison can discover an already-synced scope without any sync/adopt action; the separate `syncApplied` success event makes successful confirmed application the only timestamp authority.
- **ALT-007**: Mirror `HarnessConfigSyncPlan` records in shared state for later renderer confirmation. Rejected because plan IDs and fingerprints are actionable, process-local bindings; plans must remain request-scoped and main-bound, while the store mirrors only non-authorizing `HarnessConfigComparison` records for conflict UI.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk inventory versus Tatsu-config distinction, explicit confirmation boundary, and the requirement to keep editor content request-scoped.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the first-version managed harness set, `${agentKind}:${resourceType}` isolation, Claude alias identity, and no-automatic-mutation rules.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) defines `HarnessConfigComparison = { scope, status, diskOnly, configOnly, changed, comparedAt }` as non-authorizing output and `HarnessConfigSyncPlan = { planId, scope, direction, status, diskOnly, configOnly, changed, generatedAt, fingerprint }` as the directional actionable DTO. The implementation must converge on the shared definitions from REQ-007 while keeping private operations and apply bindings in main.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) owns the canonical `HarnessConfigResourceType` export in `src/shared/agent-registry` and the exact supported harness/resource matrix.
- **DEP-005**: `src/shared/state/terminals/types.ts` owns `AgentKind`; this slice narrows it to the three managed harnesses without changing terminal support for Pi.
- **DEP-006**: `src/shared/state/index.ts` is the canonical `AppState`, `StateEvent`, reducer, initial-state, and wire-snapshot integration point.
- **DEP-007**: [Step 6](./step-06-transport-request-handlers.md) publishes successful read-only compare results through `comparisonLoaded`, records successful confirmed sync/adopt application through the separate `syncApplied` event, and keeps actionable directional plans and their bindings out of shared state.
- **DEP-008**: [Step 7](./step-07-config-page-shell.md) consumes inventory and non-authorizing comparisons from the mirrored slice while keeping selected resources, modal state, and editor drafts local to the renderer client.
- **DEP-009**: [Step 9](./step-09-sync-conflict-ux.md) uses the mirrored comparison for conflict review, then requests a fresh direction-bound `HarnessConfigSyncPlan` for the selected action; it must never treat a stored comparison as apply authority or retrieve an actionable plan from shared state.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/types.ts` — scope, key, file-ref, comparison, request-scoped plan DTO, state, and seven-event contracts.
- **FILE-002**: `src/shared/state/harness-config/harness-config.ts` — initial state, scope-key helper, ordering logic, comparison storage, success timestamp handling, and reducer.
- **FILE-003**: `src/shared/state/harness-config/index.ts` — package public exports.
- **FILE-004**: `src/shared/state/harness-config/harness-config.test.ts` — event, comparison/plan separation, scope isolation, ordering, timestamp, and reference-identity tests.
- **FILE-005**: `src/shared/state/index.ts` — root state/event/reducer/initial-state/wire-merge integration and public type exports.
- **FILE-006**: `src/shared/state/wire-merge.test.ts` — older-server missing/partial harness-config snapshot coverage.
- **FILE-007**: `src/main/harness-config/types.ts` — replace duplicate public file-ref, comparison, and plan DTO contracts with imports from the shared package while retaining main-only service, operation, dependency, fingerprint-validation, and error types.
- **FILE-008**: `src/main/harness-config/index.ts` — re-export the canonical shared public contracts alongside main-only service exports.

## 6. Testing

- **TEST-001**: Initial-state coverage proves exact resource keys, empty comparison map, false loading, null error, and null timestamps.
- **TEST-002**: Seven event-variant tests prove each event's observable mutation and preservation of unrelated fields.
- **TEST-003**: Scope-isolation coverage proves inventory replacement and comparison insertion cannot cross either `agentKind` or `resourceType`.
- **TEST-004**: Alias coverage proves identical physical IDs in Skills and Commands remain isolated by the event's logical view.
- **TEST-005**: Identity coverage proves semantic no-ops return the original state, scoped loads retain unchanged arrays when possible, and single-item changes preserve sibling references.
- **TEST-006**: Ordering coverage proves arrays remain ordered by managed harness, relative path, and ID after loads and upserts.
- **TEST-007**: Authority and timestamp coverage proves comparisons contain no plan ID, direction, or fingerprint; comparison loads never update `lastSyncedAt`; and only the explicit successful-confirmed-sync/adopt `syncApplied` event can update it.
- **TEST-008**: Wire-merge coverage proves missing slices and missing top-level fields receive defaults without clobbering server-sent inventory, comparisons, or request status.
- **TEST-009**: `npx vitest run src/shared/state/harness-config/harness-config.test.ts src/shared/state/wire-merge.test.ts` exits successfully.
- **TEST-010**: `pnpm typecheck` exits successfully across main, preload, renderer, and web-client project references.
- **TEST-011**: `pnpm build` exits successfully for desktop and web-client bundles, proving the shared package remains browser-safe.
- **TEST-012**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL declarations and duplicate bullet-style declaration identifiers MUST both produce zero results.

## 7. Risks & Assumptions

- **RISK-001**: The required `resources` shape groups by logical type rather than scope; a whole-array replacement would silently erase other harness inventories. REQ-012 makes every load a scoped replacement.
- **RISK-002**: Claude aliases reuse a physical ID across Skills and Commands. Matching only by ID could update or delete the wrong view; REQ-015 includes both the logical resource array and harness in mutation identity.
- **RISK-003**: Main-only duplicates of public comparison, plan, or ref contracts can drift from renderer expectations. REQ-007 makes shared DTO types authoritative while leaving executable operations, fingerprints used for validation, and apply bindings private to main.
- **RISK-004**: A global boolean `loading` cannot accurately represent arbitrary concurrent per-scope requests. This plan preserves the required state shape; Step 6 must use its request counter to emit correct slice-level loading transitions.
- **RISK-005**: `absolutePath` is needed for read-only display but is sensitive host metadata. It must never be accepted back from a renderer as mutation authority; Step 2 resolves IDs against a fresh recognized inventory.
- **RISK-006**: Shallow wire merging does not repair malformed nested `resources` or `comparisons` objects. This matches the existing snapshot strategy and covers version skew at the slice-field boundary, not arbitrary corrupted server data.
- **RISK-007**: A mirrored comparison can become stale after either disk or Tatsu config changes. It remains review data only; Step 9 must request and validate a fresh direction-bound actionable plan before confirmed application.
- **ASSUMPTION-001**: Steps 2 and 3 are implemented before or alongside this step so the service and slice can converge on one canonical shared wire model without compatibility aliases.
- **ASSUMPTION-002**: Main-process scan and comparison results are already validated and deterministic; the reducer preserves safe scoped state but is not a filesystem/path validation boundary.
- **ASSUMPTION-003**: `lastScannedAt` and `lastSyncedAt` are slice-wide summary timestamps, as required by the supplied state shape, rather than per-scope timestamps.
- **ASSUMPTION-004**: A resource's `resourceType` is its current logical view, while `canonicalResourceType` and `aliasResourceTypes` preserve physical identity semantics for Claude aliases.
- **ASSUMPTION-005**: Step 6 dispatches `syncApplied` only after the service reports successful confirmed sync/adopt application; the shared reducer does not independently authenticate transport actions.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)
- [Step 6: Transport request handlers](./step-06-transport-request-handlers.md)
- [Step 7: Config page shell](./step-07-config-page-shell.md)
- [Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)
- [Repository shared-state architecture](../../AGENTS.md)
