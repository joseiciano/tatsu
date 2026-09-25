---
goal: Add safe harness configuration transport request handlers
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, transport, harness-config, ipc, websocket]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 6 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It connects the main-process harness configuration service and persisted Tatsu config to Electron and WebSocket clients through the existing compound transport, publishes successful disk inventory and comparison changes through the shared store, and exposes a typed renderer API without allowing renderer-supplied paths or unconfirmed mutations. The request surface separates read-only scan/read/compare requests, non-mutating plan-generation requests, and mutating apply requests. Mutation authority follows the [source-of-truth operation matrix](./implementation-details.md): sync to disk and adopt from disk accept only a previously generated, still-current confirmed plan, while direct create/update/delete additionally require their explicit Create/Save/Delete action on the matching action-specific channel. Missing, stale, mismatched, reused, or unconfirmed plans are rejected rather than applied. The Config page, conflict modal, and conversion controls remain follow-up work in Steps 7 through 10.

## 1. Requirements & Constraints

- **REQ-001**: Register exactly these fifteen active-backend request channels, grouped by authority: read-only observation channels `harnessConfig:scan`, `harnessConfig:readFile`, and `harnessConfig:compare`; non-mutating plan-generation channels `harnessConfig:prepareCreate`, `harnessConfig:prepareUpdate`, `harnessConfig:prepareDelete`, `harnessConfig:planSyncToDisk`, and `harnessConfig:planAdoptFromDisk`; mutating channels `harnessConfig:createFile`, `harnessConfig:updateFile`, `harnessConfig:deleteFile`, `harnessConfig:syncToDisk`, and `harnessConfig:adoptFromDisk`; and prepare-only conversion channels `harnessConfig:prepareCommandFromSkill` and `harnessConfig:prepareSkillFromCommand`.
- **REQ-002**: Every channel MUST accept one JSON-serializable object argument. Main-process handlers MUST treat the argument as `unknown`, validate its complete shape, reject extra authority-bearing fields, and never trust TypeScript types at the transport boundary.
- **REQ-003**: Every request that identifies a scope MUST carry `{ agentKind, resourceType }`. `agentKind` MUST be a string for which `toAgentKind(agentKind) === agentKind` and MUST additionally belong to `claude | codex | opencode`; the permissive `toAgentKind()` fallback MUST NOT authorize an unknown value or `pi` as `claude`. `resourceType` MUST match the canonical `HarnessConfigResourceType` allowlist `agents | skills | commands`.
- **REQ-004**: Add shared, browser-safe request and response contracts to `src/shared/state/harness-config/types.ts`; main and renderer code MUST import those contracts through `src/shared/state/harness-config`. Do not duplicate transport DTOs in main and renderer packages.
- **REQ-005**: Define `HarnessConfigRequestResult<T>` as `{ ok: true; value: T } | { ok: false; error: HarnessConfigRequestError }`. `HarnessConfigRequestError` MUST contain a stable `code` and safe `message`; it MUST NOT contain file content, executable operations, stack traces, backup bytes, or arbitrary Node error text.
- **REQ-006**: Reuse the stable service error codes defined by Step 2 and add only transport-owned `invalid-request` and `internal-error` codes. If the Step 2 implementation declared service codes only in main, move the safe code union to the shared harness-config contract and make the main package import and re-export it; do not retain two unions.
- **REQ-007**: Define exact, separate request contracts. Scan and compare accept `{ scope }`; read accepts `{ scope, id }`. Direct plan generation accepts `{ scope, name, content }` for `prepareCreate`, `{ scope, id, content }` for `prepareUpdate`, and `{ scope, id }` for `prepareDelete`. Directional plan generation accepts `{ scope }` on its direction-specific `planSyncToDisk` or `planAdoptFromDisk` channel. Every mutation channel accepts only `{ scope, planId, confirmed }`; create/update/delete draft fields MUST NOT be repeated on apply. Conversion accepts a single-phase `{ scope, id }` request and has no apply phase: a generated draft is user-editable and is saved through the separately prepared and confirmed direct-create flow.
- **REQ-008**: IDs, names, plan IDs, and content MUST be validated as strings, with non-empty IDs, names, and plan IDs. No request accepts an absolute path, relative path, root override, target harness, executable operation, hash override, fingerprint override, public file ref, Tatsu config resource object, or renderer-constructed plan. All filesystem paths are resolved and normalized in the main process inside known harness configuration roots per the path-safety rule in `implementation-details.md`; renderer input MUST NOT supply trusted absolute paths.
- **REQ-009**: Observation and plan-generation requests are read-only. `scan`, `readFile`, and `compare` MUST NOT create mutation authority. `compare` MUST call Step 2's read-only `planSync(scope)` comparison wrapper and create no apply binding. Its `HarnessConfigComparison` result is exactly `{ scope, status, diskOnly, configOnly, changed, comparedAt }` and excludes `planId`, `direction`, `fingerprint`, operations, and apply authority. The direct plan channels MUST call `prepareCreate`, `prepareUpdate`, or `prepareDelete`; the directional plan channels MUST call `planSyncToDisk` or `planAdoptFromDisk`. Those five plan-generation channels return a serializable public plan and record a main-only binding from `planId` to the originating generation channel, its one allowed mutation channel, exact `${agentKind}:${resourceType}` scope, direction when applicable, and affected logical resource types. Conversion channels call only `prepareCommandFromSkill` or `prepareSkillFromCommand`, return `HarnessConfigConversionResult`, and create no plan binding.
- **REQ-010**: Every mutation request MUST locate the main-only binding, verify that its allowed mutation channel and exact `${agentKind}:${resourceType}` scope key match the request, require `confirmed === true`, and only then call `HarnessConfigService.applyPlan({ planId, confirmed: true })`. A plan generated for another action, harness, resource type, or direction MUST NOT be usable. Plans remain process-local, single-use, and subject to Step 2 fingerprint revalidation.
- **REQ-010a**: Sync to disk and adopt from disk are authorized only by their matching previously generated, still-current confirmed plan. A direct create, update, or delete is authorized only when its matching prepared plan is submitted through the action-specific mutation channel after the explicit Create action, Save confirmation, or Delete confirmation defined by the operation matrix in `implementation-details.md`. A bare `confirmed: true`, a plan ID without its main-only binding, or a renderer-supplied path/ref/plan is never sufficient authority.
- **REQ-011**: `harnessConfig:compare` MUST call Step 2's `planSync(scope)` wrapper, dispatch `harnessConfig/comparisonLoaded` with the returned `HarnessConfigComparison`, return the same comparison, and record no apply binding. The comparison event carries no `syncedAt`. The main-owned comparison map MUST key this value by `${agentKind}:${resourceType}`. `harnessConfig:planSyncToDisk` and `harnessConfig:planAdoptFromDisk` MUST call the matching Step 2 plan generator and return `HarnessConfigSyncPlan = { planId, scope, direction, status, diskOnly, configOnly, changed, generatedAt, fingerprint }`; each records the exact direction-bound apply binding without mutating disk or Tatsu config. Actionable directional plans remain request-scoped and MUST NOT be mirrored into shared state. Merely comparing or generating a plan MUST NOT change `lastSyncedAt`.
- **REQ-012**: `harnessConfig:syncToDisk` MUST accept only a bound plan from `harnessConfig:planSyncToDisk`; `harnessConfig:adoptFromDisk` MUST accept only a bound plan from `harnessConfig:planAdoptFromDisk`. Direct create/update/delete MUST likewise accept only the plan generated by their matching prepare channel. Every mutation channel MUST reject missing, mismatched, stale, reused, or unconfirmed plans through the structured result envelope before reporting success.
- **REQ-012a**: `harnessConfig:scan`, `harnessConfig:readFile`, `harnessConfig:compare`, all five plan-generation channels, and both conversion channels are non-mutating and MAY run without a confirmation gate. Only the five mutation channels may call `applyPlan`, and each MUST map to exactly one explicit user gate per the operation matrix in `implementation-details.md`. Cancel, dismissal, or abandonment of a comparison, generated plan, or conversion draft sends no mutation request and is a no-op for disk inventory and Tatsu config.
- **REQ-013**: `harnessConfig:scan` MUST call `service.scan(scope)` and, only after the scan succeeds, dispatch `harnessConfig/resourcesLoaded` with the exact scope, returned references, and one captured `scannedAt` timestamp. The successful result MUST return the same resources and timestamp.
- **REQ-014**: `harnessConfig:readFile` MUST call the service's fresh recognized-inventory read by ID, verify the returned ref belongs to the requested `agentKind` and requested logical/canonical/alias resource view, and return `{ ref, content, hash }` only in the request response. Content MUST NOT enter `AppState`, a state event, a plan, a log, or persisted transport metadata.
- **REQ-015**: After every mutation attempt that reaches `service.applyPlan`, the adapter MUST rescan all logical scopes captured in the binding, including canonical and alias views. It MUST dispatch `resourcesLoaded` only for successful rescans. This refresh is required after success and after a partial apply failure so mirrored state reflects disk reality.
- **REQ-016**: After a successful sync-to-disk or adopt-from-disk mutation, run a fresh read-only comparison for the same scope, dispatch `harnessConfig/comparisonLoaded` with that comparison, dispatch `harnessConfig/syncApplied` with `{ scope, syncedAt }` set to the successful apply timestamp, and return the service apply result. After a failed or partial apply, a successful fresh comparison MAY be dispatched without any `syncApplied` event, but the original apply error MUST remain the request result. Post-apply comparison MUST NOT silently generate, mirror, or confirm another actionable plan.
- **REQ-017**: Direct create, update, or delete success MUST refresh affected disk inventory but MUST NOT set `lastSyncedAt`; that timestamp represents confirmed sync/adopt application only. Conversion itself never mutates. Claude skill/command alias views MUST both refresh after the separately confirmed direct-create mutation when the prepared or rescanned refs identify the alias.
- **REQ-018**: Store events that describe domain success MUST be dispatched only after the corresponding service read or side effect succeeds. `loadingChanged` and `errorChanged` are request-lifecycle events and MAY report validation or service failure; they MUST NOT imply a disk or persistence mutation succeeded.
- **REQ-019**: Maintain a main-only in-flight request counter around all fifteen handlers. Dispatch `loadingChanged(true)` on the zero-to-one transition and `loadingChanged(false)` on the one-to-zero transition so concurrent Electron/WebSocket requests cannot clear loading while another request remains active.
- **REQ-020**: Clear the slice error explicitly at the start of a new harness-config request. On failure, return a structured error and dispatch the same safe message through `harnessConfig/errorChanged`; a success MUST NOT clear a failure that completed after that request began.
- **REQ-021**: Instantiate exactly one `HarnessConfigService` from the long-lived `config` loaded in `src/main/index.ts`. Bind `loadDesiredResources` to `getPersistedHarnessConfigResources(config)` and `replaceDesiredScope` to `replacePersistedHarnessConfigScope(config, scope, resources)` so confirmed mutations use Step 5's synchronous throwing persistence path rather than debounced `saveConfig()`.
- **REQ-022**: Use a dedicated `src/main/harness-config-transport/` package for validation, structured error mapping, request registration, plan bindings, refresh behavior, and focused tests. `src/main/index.ts` MUST own composition: construct the service, pass the shared `transport` and `store` to `registerHarnessConfigRequestHandlers`, and register before desktop or headless clients can issue requests.
- **REQ-023**: Register once on `CompoundServerTransport`; do not add Electron-only or WebSocket-only copies. Existing compound forwarding MUST make all fifteen channels available to local Electron, headless, and remote web clients.
- **REQ-024**: Extend `ElectronAPI` in `src/renderer/types/types.ts` with fifteen typed methods and add matching active-routed `req(...)` mappings in `src/renderer/build-backend/build-backend.ts`. Harness-config requests MUST follow the selected backend and MUST NOT use `reqLocal`.
- **REQ-025**: The main adapter MUST NOT implement filesystem backup, atomic write, path confinement, stale fingerprint, rollback, or Tatsu config replacement logic. It delegates these invariants to Step 2's service. Before overwrite, delete, or sync-to-disk replacement, the service backs up the existing file from its exact original bytes; brand-new creates do not produce backups. Backup failure aborts the mutation before overwrite/delete and leaves the original untouched.
- **REQ-026**: A conversion request accepts only the source scope and ID. `prepareCommandFromSkill` MUST require source resource type `skills`; `prepareSkillFromCommand` MUST require `commands`. The service and adapter MUST preserve the same `agentKind`, stable physical identity, and underlying path; no request may supply or infer another harness as a destination. The adapter returns `HarnessConfigConversionResult` unchanged — no plan binding, no apply phase, and no duplicate Claude skill/command alias.
- **REQ-027**: No plugin installation, cross-harness copying, repository-local resource management, binary skill assets, or Pi management is introduced by this step. Plugins remain provenance metadata for the originating harness, never a fourth resource type or automatic cross-harness payload.
- **SEC-001**: Renderer-provided absolute paths, relative paths, file refs, Tatsu config resources, hashes, fingerprints, operations, public plans, and destination harnesses are untrusted and MUST NOT be accepted as mutation authority. Sync/adopt require a matching current bound plan; direct create/update/delete require both a matching current bound plan and the corresponding explicit Create/Save/Delete action. All filesystem paths are resolved and normalized in the main process inside known harness configuration roots, and renderer input MUST NOT supply trusted absolute paths.
- **SEC-002**: A plan ID and renderer boolean are capability-like but insufficient by themselves: the adapter's main-only binding, exact scope, allowed action channel, direction when applicable, literal `confirmed === true`, and Step 2's current fingerprints MUST all pass before `applyPlan`. Validation failure MUST return a structured rejection and perform zero disk or Tatsu config mutation.
- **SEC-003**: Unexpected exceptions MUST be logged with the existing `harness-config` category and mapped to the generic `internal-error` response. Safe `HarnessConfigError` code/message pairs MAY pass through unchanged; neither logs nor responses may include user-authored content.
- **CON-001**: Add no runtime or development dependency.
- **CON-002**: Preserve main-owned shared state: the main process publishes disk inventory and non-authorizing comparisons, and renderer components consume the mirrored slice. Actionable plans remain request-scoped responses backed by main-only bindings; a renderer MAY hold the current response only for its confirmation flow but MUST NOT create an authoritative cache or mirror it into shared state. No renderer-local copy of inventory, loading, error, or timestamps is added here.
- **CON-003**: This step does not implement Config-page components, editor drafts, conflict modal state, navigation, or user-facing confirmation controls; those later steps consume the transport contract defined here.
- **GUD-001**: Follow package barrels. External code imports `src/main/harness-config-transport`, `src/main/harness-config`, `src/main/persistence`, and `src/shared/state/harness-config`, never their implementation files.
- **PAT-001**: Follow the existing `buildBackend()` pattern: `ElectronAPI` declares the method, the backend object maps it to one named request on the active transport, and the compound main transport owns the corresponding handler.

## 2. Implementation Steps

### Implementation Phase 1: Define transport contracts

- **GOAL-001**: Establish one browser-safe, exact request/result protocol that keeps read-only observation, non-mutating plan generation, confirmed mutation, conversion preparation, and structured failure contracts distinct.

- [ ] **TASK-001**: Update `src/shared/state/harness-config/types.ts` with the transport error and result contracts from REQ-004 through REQ-006.
  - Export `HarnessConfigRequestErrorCode`, `HarnessConfigRequestError`, and generic `HarnessConfigRequestResult<T>`.
  - Reuse or relocate the Step 2 stable error-code union so main and renderer compile against one declaration.
  - Keep Node `Error`, stack, cause, content, and executable-operation fields out of every shared type.
- [ ] **TASK-002**: Add exact shared input types for the fifteen channels.
  - Define separate scan, read, compare, direct-prepare, directional-plan, bound-apply, and conversion request types described by REQ-007 and REQ-008. Do not model create/update/delete as a `phase` union and do not reuse a mutation request type for plan generation.
  - Use `boolean` for runtime `confirmed` input so an untrusted false value can be rejected deterministically; successful mutation still requires the literal value `true` plus a matching main-only binding.
  - Define response value types for scan, read, comparison, prepared mutation, directional plan, conversion, and applied mutation without exposing service-private operations.
- [ ] **TASK-003**: Reconcile Step 2's public comparison and plan contracts with the shared DTOs and main-owned state.
  - Define `HarnessConfigComparison` exactly as `{ scope, status, diskOnly, configOnly, changed, comparedAt }`; exclude `planId`, `direction`, `fingerprint`, operations, and apply authority.
  - Keep `HarnessConfigSyncPlan` exactly `{ planId, scope, direction, status, diskOnly, configOnly, changed, generatedAt, fingerprint }`. Ensure direct mutation plans expose `planId`, exact scope, operation kind, generated timestamp, affected public refs or logical resource types, and no content/operations.
  - Add the shared `harnessConfig/comparisonLoaded` and `harnessConfig/syncApplied` events and the exact `${agentKind}:${resourceType}` comparison storage contract required by REQ-011 and REQ-016. `comparisonLoaded` stores only `HarnessConfigComparison`; `syncApplied` carries only `{ scope, syncedAt }`. Do not put `HarnessConfigSyncPlan` into mirrored state; update package barrels/main re-exports and remove structural duplicates rather than adding compatibility aliases.

### Implementation Phase 2: Register and execute main handlers

- **GOAL-002**: Compose the service, persistence, store, and compound transport behind a testable adapter that cannot bypass scope or confirmation rules.

- [ ] **TASK-004**: Create `src/main/harness-config-transport/index.ts` and `src/main/harness-config-transport/harness-config-transport.ts`.
  - Export `registerHarnessConfigRequestHandlers({ transport, store, service, now })` from the package barrel.
  - Type dependencies by the narrow methods used by the adapter so tests can provide deterministic fakes without importing Electron or starting a server.
  - Keep the plan-binding map and in-flight counter private to one registration instance.
- [ ] **TASK-005**: Implement boundary parsers and structured error mapping in `harness-config-transport.ts`.
  - Parse plain objects, exact managed scopes, resource types, strings, and confirmation only where the channel contract allows them; reject arrays, null, missing or extra fields, wrong primitives, unsupported Pi, unknown agent/resource values, and obsolete phase/direction fields on direction-specific channels.
  - Call `toAgentKind()` as required, but require exact round-trip equality and the managed allowlist before accepting its result.
  - Map known `HarnessConfigError` values to their stable safe code/message and unknown exceptions to `internal-error`; never return thrown transport rejections for expected validation or service failures.
- [ ] **TASK-006**: Implement one lifecycle wrapper for all handlers.
  - Increment/decrement the in-flight counter in `try/finally`, emit loading only on boundary transitions, and clear error at request start.
  - On failure, dispatch the safe error message before returning `{ ok: false, error }`.
  - Prevent an earlier successful request from clearing an error produced by a later concurrent request; error clearing occurs only at explicit request start.
- [ ] **TASK-007**: Register the read-only `harnessConfig:scan`, `harnessConfig:readFile`, and `harnessConfig:compare` handlers.
  - Scan validates scope, calls `service.scan`, captures `now()` once, dispatches `resourcesLoaded`, and returns `{ resources, scannedAt }`.
  - Read validates scope and ID, calls the fresh service read, verifies agent and logical/canonical/alias membership, and returns content only through the response.
  - Compare validates scope, calls only `service.planSync(scope)`, dispatches `harnessConfig/comparisonLoaded` with no `syncedAt`, returns the same `HarnessConfigComparison`, and records no apply binding. All three handlers perform zero disk and Tatsu config writes.
- [ ] **TASK-008**: Register the five non-mutating direct-prepare and conversion handlers.
  - Route `harnessConfig:prepareCreate`, `harnessConfig:prepareUpdate`, and `harnessConfig:prepareDelete` to the exact matching Step 2 wrapper. Record each returned `planId` with its one allowed create/update/delete mutation channel, exact scope, and affected canonical/alias logical views.
  - Route the two Step 10 channels only to `prepareCommandFromSkill`/`prepareSkillFromCommand`. Return `HarnessConfigConversionResult` through the standard envelope with no plan binding and no apply phase.
  - Return the public mutation plan or conversion result without dispatching inventory or comparison success events.
- [ ] **TASK-009**: Register the distinct `harnessConfig:planSyncToDisk` and `harnessConfig:planAdoptFromDisk` handlers.
  - Route each validated `{ scope }` payload only to its identically directed Step 2 wrapper; do not accept a renderer-provided direction discriminator.
  - Record a binding containing the originating plan channel, one allowed mutation channel, exact scope, fixed direction, and every canonical/alias resource type named by the plan's differences.
  - Return the public plan without applying it, changing disk/Tatsu config, or setting `syncedAt`.
- [ ] **TASK-010**: Implement the shared bound-plan apply path and register the three direct mutation channels.
  - Reject missing, cross-channel, cross-direction, or cross-scope binding metadata before service apply. A matching request with `confirmed !== true` MUST be rejected and its adapter binding invalidated so later replay cannot mutate.
  - For `createFile`, `updateFile`, and `deleteFile`, treat the action-specific request following the explicit Create/Save/Delete UI gate as the direct confirmed action, but still require the matching prepared `planId`; never accept draft fields or paths on these mutation channels.
  - Remove the matching binding immediately before calling `service.applyPlan({ planId, confirmed: true })`, so success, stale-plan rejection, partial failure, and any other attempted apply remain single-use. Rely on the service for stale fingerprint detection, plan consumption, backup, atomicity, rollback, and same-harness enforcement. After every reached apply attempt, refresh the bound scopes as required by REQ-015 and preserve the original failure after refresh.
- [ ] **TASK-011**: Register `harnessConfig:syncToDisk` and `harnessConfig:adoptFromDisk` on the shared apply path.
  - Require the matching direction-specific plan-channel binding, exact scope, and literal confirmation.
  - On success, rescan affected disk inventory, run a fresh read-only comparison, dispatch `harnessConfig/comparisonLoaded` with that comparison and `harnessConfig/syncApplied` with `{ scope, syncedAt }`, and return the apply result without generating or mirroring another actionable plan.
  - On partial failure, rescan and optionally dispatch a fresh `comparisonLoaded` event without `syncedAt` or `syncApplied`, then return the original apply error.
- [ ] **TASK-012**: Add deterministic refresh helpers.
  - Start with the binding's selected, canonical, and alias logical resource types; after each successful scan, add newly returned aliases and scan each scope at most once.
  - Reuse one `scannedAt` value for the refresh batch and dispatch one `resourcesLoaded` event per successfully refreshed scope.
  - Never broaden refresh to another `agentKind` and never hide an apply error behind a refresh error.
- [ ] **TASK-013**: Compose the adapter in `src/main/index.ts`.
  - Import `HarnessConfigService`, persistence accessors, and `registerHarnessConfigRequestHandlers` through package barrels.
  - Construct one service after the long-lived `config` is loaded, binding the Step 5 read/replace functions to that same object.
  - Invoke registration from the existing request-registration flow before desktop/headless clients connect; do not duplicate handlers per transport and do not call `saveConfig()` from these handlers.

### Implementation Phase 3: Expose the renderer backend API

- **GOAL-003**: Make every harness configuration operation available through the selected backend with shared argument and result types.

- [ ] **TASK-014**: Update `src/renderer/types/types.ts`.
  - Import and re-export the shared harness-config scope, file-ref, comparison, plan, request, apply-result, and request-result types through the shared package barrel.
  - Add exact one-object methods for all fifteen channels: `scanHarnessConfig`, `readHarnessConfigFile`, `compareHarnessConfig`, `prepareHarnessConfigCreate`, `prepareHarnessConfigUpdate`, `prepareHarnessConfigDelete`, `planHarnessConfigSyncToDisk`, `planHarnessConfigAdoptFromDisk`, `createHarnessConfigFile`, `updateHarnessConfigFile`, `deleteHarnessConfigFile`, `syncHarnessConfigToDisk`, `adoptHarnessConfigFromDisk`, `prepareHarnessConfigCommandFromSkill`, and `prepareHarnessConfigSkillFromCommand`.
  - Give every method its exact `Promise<HarnessConfigRequestResult<...>>` return type; no mutation method accepts the plan-generation payload shape.
- [ ] **TASK-015**: Update `src/renderer/build-backend/build-backend.ts` with fifteen active-routed method mappings.
  - Map each `ElectronAPI` method one-to-one to the channel in REQ-001 through `req`, preserving the single object argument and the observation/plan/mutation split.
  - Do not use `reqLocal`; remote Config pages must manage the active remote backend's harness files, state, and plans.
  - Do not add preload wiring because the generic `LocalTransportHandle.request()` already carries named requests.

### Implementation Phase 4: Prove safety and integration

- **GOAL-004**: Verify validation, confirmation, scoping, event ordering, partial-apply refresh, and renderer/main contract completeness before delivery.

- [ ] **TASK-016**: Add `src/main/harness-config-transport/harness-config-transport.test.ts` using a captured-handler fake transport, recording fake store, deterministic clock, and fake service.
  - Test observable request results and dispatched events, not private helper calls or source text.
  - Cover successful scan/read/compare, content exclusion from events, non-authorizing comparison, and exact scoped comparison/plan payloads.
  - Prove all plan-generation handlers perform zero mutation; only the five mutation handlers can reach `applyPlan`, each after its own matching explicit user gate.
- [ ] **TASK-017**: Add security, rejection, confirmation, and no-op regression cases.
  - Prove unknown/empty agent values, Pi, invalid resource types, malformed or extra authority-bearing fields, false confirmation, missing/stale/reused plans, mismatched scope/channel/direction bindings, and cross-harness destination attempts never invoke `applyPlan` or another mutating service method.
  - Prove `toAgentKind()` fallback cannot turn invalid input into Claude authorization and renderer-provided absolute/relative paths, refs, hashes, fingerprints, Tatsu config resources, and plans are rejected.
  - Prove conversion requests cannot select a destination harness, enforce Skills-to-Commands or Commands-to-Skills source types, and never create a plan binding.
  - Prove cancellation/dismissal/abandonment sends no mutation request, emits no success event, and leaves disk inventory and Tatsu config unchanged.
- [ ] **TASK-018**: Add event-order and refresh regression cases.
  - Prove scan/read/compare, all plan-generation requests, and conversion preparation do not dispatch resource mutation events, `syncApplied`, or any `lastSyncedAt` change; compare alone dispatches `comparisonLoaded`, and no actionable plan is mirrored into shared state.
  - Prove successful scan dispatches after the service returns; successful confirmed mutation refreshes selected/canonical/alias scopes; confirmed sync/adopt alone dispatches `syncApplied` and updates `lastSyncedAt`.
  - Simulate partial apply failure and prove successful rescans update inventory while the request still returns the original apply error, dispatches no `syncApplied`, and leaves `lastSyncedAt` unchanged.
  - Overlap two deferred requests and prove loading stays true until both settle.
- [ ] **TASK-019**: Add structured-error and side-effect-order cases.
  - Prove known service errors preserve safe code/message, unknown errors become `internal-error`, and neither response/store events nor logs contain supplied content.
  - Prove failed scan produces no `resourcesLoaded`, failed compare produces no `comparisonLoaded`, failed plan generation creates no binding, and failed mutation dispatches no `syncApplied`.
  - Prove a refresh failure cannot replace the primary apply failure.
- [ ] **TASK-020**: Run `npx vitest run src/main/harness-config-transport/harness-config-transport.test.ts src/main/harness-config/harness-config.test.ts src/shared/state/harness-config/harness-config.test.ts`, then run `pnpm typecheck` and `pnpm build`.
  - Resolve every failure without weakening strict scope validation, confirmation, plan binding, structured errors, or state-content boundaries.
  - Exercise the built backend with a throwaway fake `LocalTransportHandle` that calls all fifteen renderer methods and records the fifteen request names and single-object arguments; remove the throwaway script after it passes.
- [ ] **TASK-021**: Review the final change against the complete request table and downstream UI needs.
  - Verify all fifteen channels exist exactly once on main and renderer, all mappings use the active backend, and no request accepts paths or cross-harness destinations.
  - Verify observation and plan-generation channels cannot reach `applyPlan`, every mutation requires a matching current bound plan and literal confirmation, and direct create/update/delete channels correspond to their explicit Create/Save/Delete user gates.
  - Verify the adapter contains no backup/write implementation, the service contains no store/transport integration, Tatsu config content remains main-only, comparison state remains main-owned, actionable plans remain request-scoped/unmirrored, and the shared slice remains content-free.
  - Verify rejection and cancel/dismiss paths produce no disk/Tatsu config mutation or success event, and no request is authorized by arbitrary user-supplied paths.
  - Verify affected documentation still names `implementation-details.md` as the feature source and no later-step UI work was pulled into this change.
- [ ] **TASK-022**: Commit the shared contracts, adapter, renderer mappings, and tests as one focused change with message `feat: add harness config transport handlers`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Do not include unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Let each mutating channel accept arbitrary file paths and perform its own filesystem work. Rejected because renderer paths are not authority and this would duplicate Step 2's confinement, backup, atomic-write, rollback, and stale-plan logic.
- **ALT-002**: Treat `toAgentKind()` as sufficient validation. Rejected because unknown, empty, and undefined values normalize to Claude; strict round-trip validation plus the managed allowlist is required at this security boundary.
- **ALT-003**: Add one generic `harnessConfig:applyPlan` channel. Rejected because the requested API names distinguish user intent, and channel/scope/direction binding prevents a plan prepared for one action from being replayed through another.
- **ALT-004**: Prepare and apply a mutation inside one transport call. Rejected because it removes the inspectable, current plan boundary required by Steps 1 and 2 and makes stale/replay behavior harder to enforce consistently.
- **ALT-005**: Dispatch individual `resourceUpserted` and `resourceDeleted` events from apply results. Rejected because partial multi-file operations and Claude aliases can affect multiple logical views; authoritative post-apply rescans produce complete scoped inventory without guessing from an incomplete result.
- **ALT-006**: Keep request DTOs only in `src/renderer/types/types.ts`. Rejected because main and renderer would maintain structurally duplicated contracts with no compiler-enforced agreement.
- **ALT-007**: Register fifteen handlers directly inside the already-large `src/main/index.ts` without a package seam. Rejected because boundary validation, plan binding, concurrency, refresh, and error mapping require focused behavioral tests while `src/main/index.ts` has boot side effects and no request-registration test seam.
- **ALT-008**: Route Config requests through `reqLocal`. Rejected because a renderer connected to a remote backend must read and mutate that backend's harness directories and mirrored state, not the local Electron host.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk inventory versus Tatsu config, confirmation boundary, Claude alias behavior, and backup requirement, including the source-of-truth operation matrix with its required user gates: none for scan/compare/plan generation, a confirmed current sync/adopt plan for directional mutations, and an explicit Create/Save/Delete confirmation plus the matching current prepared plan for direct mutations. Stale plans are rejected rather than applied and require regeneration and reconfirmation.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines managed harness scope, exact `{ agentKind, resourceType }` isolation, conflict semantics, no-op cancellation, and the no-cross-harness rule.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) provides `HarnessConfigService`, the non-authorizing `planSync(scope)` comparison, the actionable direct and directional plan wrappers, public plans/results, structured service errors, confirmed apply behavior, stale fingerprints, filesystem safety, backups, rollback, and authoritative rescans.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) provides the canonical resource-type union and harness capability metadata.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) provides the content-free `harnessConfig` slice, exact scope keying, and timestamp semantics; its comparison map and `harnessConfig/comparisonLoaded` event store only `HarnessConfigComparison`, while `harnessConfig/syncApplied` alone carries `{ scope, syncedAt }` after confirmed sync/adopt; actionable directional plans are never mirrored.
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) provides `getPersistedHarnessConfigResources(config)` and synchronous `replacePersistedHarnessConfigScope(config, scope, resources)` bound to the long-lived config.
- **DEP-007**: `src/shared/transport/transport/transport.ts` and `src/main/transport-compound/transport-compound.ts` provide the untyped named request registration and Electron/WebSocket fan-out used by the adapter.
- **DEP-008**: `src/main/agent-kind/agent-kind.ts` provides the required but permissive `toAgentKind()` normalizer; the adapter adds exact validation around it.
- **DEP-009**: Steps 7 through 10 consume these typed methods for page loading, editor actions, conflict confirmation, sync direction selection, and skill/command conversion.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/types.ts` — shared observation, plan-generation, mutation, conversion, result, error, comparison, and serializable plan DTOs.
- **FILE-002**: `src/shared/state/harness-config/index.ts`, `src/shared/state/harness-config/harness-config.ts`, and the existing slice test — export, store, reduce, and verify main-owned scoped `HarnessConfigComparison` values without mirroring actionable plans.
- **FILE-003**: `src/main/harness-config/types.ts` — remove or redirect duplicate safe public error/comparison/plan contracts if Step 2 placed them in main.
- **FILE-004**: `src/main/harness-config/index.ts` — public service barrel and canonical shared type re-exports.
- **FILE-005**: `src/main/harness-config-transport/index.ts` — new transport-adapter package barrel.
- **FILE-006**: `src/main/harness-config-transport/harness-config-transport.ts` — validation, lifecycle, error mapping, non-authorizing comparison, plan bindings, confirmed mutation, refresh, and fifteen request registrations.
- **FILE-007**: `src/main/harness-config-transport/harness-config-transport.test.ts` — adapter behavioral and security coverage.
- **FILE-008**: `src/main/index.ts` — one service construction and one compound-transport registration call bound to the long-lived config/store.
- **FILE-009**: `src/renderer/types/types.ts` — fifteen typed renderer API methods and shared type imports/exports.
- **FILE-010**: `src/renderer/build-backend/build-backend.ts` — fifteen active-backend request mappings.

## 6. Testing

- **TEST-001**: Scan/read/compare coverage proves strict scopes, post-success disk inventory dispatch, fresh ID resolution, alias membership, response-only file content, comparison-only state dispatch, and zero mutation authority from compare.
- **TEST-002**: Plan-generation/mutation coverage proves every prepare or directional planning request is non-mutating and only a matching, current, confirmed, single-use plan on its one allowed mutation channel reaches `applyPlan`.
- **TEST-003**: Validation coverage proves malformed payloads, unknown values, Pi, invalid resource types, permissive normalizer fallback, obsolete phase/direction fields, renderer paths/refs/plans, and other authority-bearing fields fail closed.
- **TEST-004**: Rejection and scope coverage proves missing, stale, reused, unconfirmed, wrong-channel, wrong-direction, wrong-resource, and wrong-harness plans perform zero disk/Tatsu config mutation; conversions never accept a destination harness or create apply authority.
- **TEST-005**: Event coverage proves scan/compare/plan generation never update `lastSyncedAt`, compare dispatches only `comparisonLoaded`, actionable plans are never mirrored, successful sync/adopt dispatches `syncApplied` and updates `lastSyncedAt`, direct mutations refresh disk inventory only, and success events follow successful service work.
- **TEST-006**: Alias coverage proves a Claude resource refreshes its canonical and alias logical views without creating another physical identity or desired record.
- **TEST-007**: Partial-failure coverage proves post-attempt rescans expose completed disk changes while preserving the original apply error and withholding a success timestamp.
- **TEST-008**: Concurrency coverage proves the loading counter remains true until the final overlapping request settles.
- **TEST-009**: Error coverage proves stable known codes, generic unknown failures, safe slice messages, and no content leakage.
- **TEST-010**: Renderer smoke coverage proves all fifteen `ElectronAPI` methods emit the correct active-backend request name with exactly one object argument and mutation methods cannot carry generation payloads.
- **TEST-011**: Targeted Vitest, `pnpm typecheck`, and `pnpm build` all exit successfully.
- **TEST-012**: Identifier declaration validation from the `plan-implementation-plan` skill reports no duplicate TASK/GOAL table declarations and no duplicate bullet-style declaration identifiers.
- **TEST-013**: Cancel/dismiss/abandonment coverage proves no mutation request is sent, no success event is emitted, and disk inventory and Tatsu config remain unchanged.

## 7. Risks & Assumptions

- **RISK-001**: Comparison and plan objects share visible difference fields and can be accidentally conflated. Keep `HarnessConfigComparison` non-authorizing and unbound, keep `HarnessConfigSyncPlan` request-scoped and direction-bound, expose neither content nor executable operations, and reject either DTO if supplied back by the renderer instead of the exact `{ scope, planId, confirmed }` mutation request.
- **RISK-002**: Multi-file sync can partially mutate disk before a later operation fails. The adapter cannot make it transactional; mandatory post-attempt rescans, preserved backups, and the original structured error make the resulting state visible and recoverable.
- **RISK-003**: The global slice error represents the most recently started/failed request rather than a per-scope history. This plan preserves the required Step 4 state shape; request responses remain authoritative for the initiating client.
- **RISK-004**: Actionable plan records exist in both the adapter binding map and service process memory. They are deliberately ephemeral and invalidated by restart; the adapter stores channel/scope metadata only, while the service remains authoritative for executable operations and fingerprints. Read-only comparisons and conversion results create no adapter binding.
- **RISK-005**: Refreshing aliases after delete cannot infer metadata from a deleted result. The binding must capture canonical/alias views during preparation or sync planning before apply.
- **ASSUMPTION-001**: Steps 2 through 5 are implemented first or in the same branch and converge on one shared public ref/plan model without compatibility aliases.
- **ASSUMPTION-002**: `HarnessConfigService.applyPlan` returns or throws enough structured information to distinguish known failures and indicate that an apply attempt may require rescan; the adapter conservatively rescans after every call that reaches it.
- **ASSUMPTION-003**: All version-one supported combinations are resolved by Step 2/3; the adapter validates taxonomy and delegates capability rejection rather than guessing filesystem layouts.
- **ASSUMPTION-004**: The existing compound transport is registered before renderer/headless clients issue requests, and active-backend routing remains the correct ownership model for remote harness configuration.

## 8. Related Specifications / Further Reading

[Implementation details and product goals](./implementation-details.md)

[Parent implementation plan](./skills-agents-commands-sync.md)

[Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)

[Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)

[Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)

[Step 4: Shared state slice](./step-04-shared-state-slice.md)

[Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)

[Step 7: Config page shell](./step-07-config-page-shell.md)

[Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)

[Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)

[Repository architecture and workflow rules](../../AGENTS.md)
