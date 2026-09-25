---
goal: Add safe harness configuration transport request handlers
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, transport, harness-config, ipc, websocket]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 6 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It connects the main-process harness configuration service and persisted desired state to Electron and WebSocket clients through the existing compound transport, publishes successful inventory and plan changes through the shared store, and exposes a typed renderer API without allowing renderer-supplied paths or unconfirmed mutations. The Config page, conflict modal, and conversion controls remain follow-up work in Steps 7 through 10.

## 1. Requirements & Constraints

- **REQ-001**: Register exactly these ten active-backend request channels: `harnessConfig:scan`, `harnessConfig:readFile`, `harnessConfig:createFile`, `harnessConfig:updateFile`, `harnessConfig:deleteFile`, `harnessConfig:planSync`, `harnessConfig:syncToDisk`, `harnessConfig:adoptFromDisk`, `harnessConfig:createCommandFromSkill`, and `harnessConfig:createSkillFromCommand`.
- **REQ-002**: Every channel MUST accept one JSON-serializable object argument. Main-process handlers MUST treat the argument as `unknown`, validate its complete shape, reject extra authority-bearing fields, and never trust TypeScript types at the transport boundary.
- **REQ-003**: Every request that identifies a scope MUST carry `{ agentKind, resourceType }`. `agentKind` MUST be a string for which `toAgentKind(agentKind) === agentKind` and MUST additionally belong to `claude | codex | opencode`; the permissive `toAgentKind()` fallback MUST NOT authorize an unknown value or `pi` as `claude`. `resourceType` MUST match the canonical `HarnessConfigResourceType` allowlist `agents | skills | commands`.
- **REQ-004**: Add shared, browser-safe request and response contracts to `src/shared/state/harness-config/types.ts`; main and renderer code MUST import those contracts through `src/shared/state/harness-config`. Do not duplicate transport DTOs in main and renderer packages.
- **REQ-005**: Define `HarnessConfigRequestResult<T>` as `{ ok: true; value: T } | { ok: false; error: HarnessConfigRequestError }`. `HarnessConfigRequestError` MUST contain a stable `code` and safe `message`; it MUST NOT contain file content, executable operations, stack traces, backup bytes, or arbitrary Node error text.
- **REQ-006**: Reuse the stable service error codes defined by Step 2 and add only transport-owned `invalid-request` and `internal-error` codes. If the Step 2 implementation declared service codes only in main, move the safe code union to the shared harness-config contract and make the main package import and re-export it; do not retain two unions.
- **REQ-007**: Define exact request contracts: scan accepts `{ scope }`; read accepts `{ scope, id }`; sync planning accepts `{ scope, direction }`; sync/adopt apply accepts `{ scope, planId, confirmed }`; create/update/delete/conversion accepts a discriminated `{ phase: 'prepare', ... } | { phase: 'apply', scope, planId, confirmed }` object.
- **REQ-008**: Create prepare payloads MUST contain `{ scope, name, content }`; update payloads `{ scope, id, content }`; delete payloads `{ scope, id }`; conversion payloads `{ scope, id }`. IDs, names, plan IDs, and content MUST be validated as strings, with non-empty IDs/names/plan IDs. No request accepts an absolute path, relative path, root override, target harness, executable operation, hash override, or desired-resource object.
- **REQ-009**: Prepare requests are read-only. They MUST call Step 2's `prepareCreate`, `prepareUpdate`, `prepareDelete`, `createCommandFromSkill`, or `createSkillFromCommand`, return a serializable public mutation plan, and record a main-only binding from `planId` to the originating channel, exact scope, and affected logical resource types.
- **REQ-010**: Apply requests MUST locate the main-only binding, verify the channel and exact scope match, require `confirmed === true`, and call only `HarnessConfigService.applyPlan({ planId, confirmed })`. A plan prepared by one channel or harness/resource scope MUST NOT be usable through another channel or scope. Plans remain process-local, single-use, and subject to Step 2 fingerprint revalidation.
- **REQ-011**: `harnessConfig:planSync` MUST require `direction: 'sync-to-disk' | 'adopt-from-disk'`, call the matching Step 2 plan generator, record the channel/scope/direction binding, dispatch `harnessConfig/syncPlanLoaded` without `syncedAt`, and return the same public plan. Merely comparing drift MUST NOT change `lastSyncedAt`.
- **REQ-012**: `harnessConfig:syncToDisk` MUST accept only a bound `sync-to-disk` plan; `harnessConfig:adoptFromDisk` MUST accept only a bound `adopt-from-disk` plan. Both MUST reject missing, mismatched, stale, reused, or unconfirmed plans through the structured result envelope.
- **REQ-013**: `harnessConfig:scan` MUST call `service.scan(scope)` and, only after the scan succeeds, dispatch `harnessConfig/resourcesLoaded` with the exact scope, returned references, and one captured `scannedAt` timestamp. The successful result MUST return the same resources and timestamp.
- **REQ-014**: `harnessConfig:readFile` MUST call the service's fresh recognized-inventory read by ID, verify the returned ref belongs to the requested `agentKind` and requested logical/canonical/alias resource view, and return `{ ref, content, hash }` only in the request response. Content MUST NOT enter `AppState`, a state event, a plan, a log, or persisted transport metadata.
- **REQ-015**: After every apply attempt that reaches `service.applyPlan`, the adapter MUST rescan all logical scopes captured in the binding, including canonical and alias views. It MUST dispatch `resourcesLoaded` only for successful rescans. This refresh is required after success and after a partial apply failure so mirrored state reflects disk reality.
- **REQ-016**: After a successful sync-to-disk or adopt-from-disk apply, generate a fresh plan for the same scope and direction, dispatch `syncPlanLoaded` with `syncedAt` set to the successful apply timestamp, and return the service apply result. After a failed or partial apply, a successful fresh comparison MAY be dispatched without `syncedAt`, but the original apply error MUST remain the request result.
- **REQ-017**: Direct create, update, delete, and conversion success MUST refresh affected inventory but MUST NOT set `lastSyncedAt`; that timestamp represents confirmed sync/adopt application only. Claude skill/command alias views MUST both refresh when the prepared or rescanned refs identify the alias.
- **REQ-018**: Store events that describe domain success MUST be dispatched only after the corresponding service read or side effect succeeds. `loadingChanged` and `errorChanged` are request-lifecycle events and MAY report validation or service failure; they MUST NOT imply a disk or persistence mutation succeeded.
- **REQ-019**: Maintain a main-only in-flight request counter around all ten handlers. Dispatch `loadingChanged(true)` on the zero-to-one transition and `loadingChanged(false)` on the one-to-zero transition so concurrent Electron/WebSocket requests cannot clear loading while another request remains active.
- **REQ-020**: Clear the slice error explicitly at the start of a new harness-config request. On failure, return a structured error and dispatch the same safe message through `harnessConfig/errorChanged`; a success MUST NOT clear a failure that completed after that request began.
- **REQ-021**: Instantiate exactly one `HarnessConfigService` from the long-lived `config` loaded in `src/main/index.ts`. Bind `loadDesiredResources` to `getPersistedHarnessConfigResources(config)` and `replaceDesiredScope` to `replacePersistedHarnessConfigScope(config, scope, resources)` so confirmed mutations use Step 5's synchronous throwing persistence path rather than debounced `saveConfig()`.
- **REQ-022**: Use a dedicated `src/main/harness-config-transport/` package for validation, structured error mapping, request registration, plan bindings, refresh behavior, and focused tests. `src/main/index.ts` MUST own composition: construct the service, pass the shared `transport` and `store` to `registerHarnessConfigRequestHandlers`, and register before desktop or headless clients can issue requests.
- **REQ-023**: Register once on `CompoundServerTransport`; do not add Electron-only or WebSocket-only copies. Existing compound forwarding MUST make all ten channels available to local Electron, headless, and remote web clients.
- **REQ-024**: Extend `ElectronAPI` in `src/renderer/types/types.ts` with ten typed methods and add matching active-routed `req(...)` mappings in `src/renderer/build-backend/build-backend.ts`. Harness-config requests MUST follow the selected backend and MUST NOT use `reqLocal`.
- **REQ-025**: The main adapter MUST NOT implement filesystem backup, atomic write, path confinement, stale fingerprint, rollback, or desired-state replacement logic. It delegates these invariants to Step 2's service. Existing targets are backed up before overwrite/delete/sync replacement; brand-new creates do not produce backups; backup failure aborts the service operation.
- **REQ-026**: A conversion request accepts only the source scope and ID. `createCommandFromSkill` MUST require source resource type `skills`; `createSkillFromCommand` MUST require `commands`. The service and adapter MUST preserve the same `agentKind`; no request may supply or infer another harness as a destination.
- **REQ-027**: No plugin installation, cross-harness copying, repository-local resource management, binary skill assets, or Pi management is introduced by this step.
- **SEC-001**: Renderer-provided absolute paths, file refs, desired resources, hashes, fingerprints, operations, and destination harnesses are untrusted and MUST NOT be accepted as mutation authority.
- **SEC-002**: A plan ID is capability-like but insufficient by itself: the adapter binding, exact scope, channel/direction, `confirmed === true`, and Step 2's current fingerprints MUST all pass before apply.
- **SEC-003**: Unexpected exceptions MUST be logged with the existing `harness-config` category and mapped to the generic `internal-error` response. Safe `HarnessConfigError` code/message pairs MAY pass through unchanged; neither logs nor responses may include user-authored content.
- **CON-001**: Add no runtime or development dependency.
- **CON-002**: Preserve main-owned shared state: renderer methods issue requests and renderer components consume the mirrored slice; no renderer-local copy of inventory, plans, loading, error, or timestamps is added here.
- **CON-003**: This step does not implement Config-page components, editor drafts, conflict modal state, navigation, or user-facing confirmation controls; those later steps consume the transport contract defined here.
- **GUD-001**: Follow package barrels. External code imports `src/main/harness-config-transport`, `src/main/harness-config`, `src/main/persistence`, and `src/shared/state/harness-config`, never their implementation files.
- **PAT-001**: Follow the existing `buildBackend()` pattern: `ElectronAPI` declares the method, the backend object maps it to one named request on the active transport, and the compound main transport owns the corresponding handler.

## 2. Implementation Steps

### Implementation Phase 1: Define transport contracts

- **GOAL-001**: Establish one browser-safe, exact request/result protocol for read-only operations, prepare/apply mutations, confirmations, and structured failures.

- [ ] **TASK-001**: Update `src/shared/state/harness-config/types.ts` with the transport error and result contracts from REQ-004 through REQ-006.
  - Export `HarnessConfigRequestErrorCode`, `HarnessConfigRequestError`, and generic `HarnessConfigRequestResult<T>`.
  - Reuse or relocate the Step 2 stable error-code union so main and renderer compile against one declaration.
  - Keep Node `Error`, stack, cause, content, and executable-operation fields out of every shared type.
- [ ] **TASK-002**: Add exact shared input types for the ten channels.
  - Define `HarnessConfigScanRequest`, `HarnessConfigReadFileRequest`, `HarnessConfigPlanSyncRequest`, `HarnessConfigApplySyncRequest`, and the create/update/delete/conversion prepare-or-apply discriminated unions described by REQ-007 and REQ-008.
  - Use `boolean` for runtime `confirmed` input so an untrusted false value can be rejected deterministically; successful apply still requires the literal value `true`.
  - Define response value types for scan, read, prepared mutation, and applied mutation without exposing service-private operations.
- [ ] **TASK-003**: Reconcile Step 2's public plan contracts with the shared DTOs.
  - Ensure the serializable mutation plan exposes `planId`, exact scope, operation kind, generated timestamp, affected public refs or logical resource types, and no content/operations.
  - Keep sync plan fields exactly aligned with Step 4's `HarnessConfigSyncPlan`, including required direction and opaque fingerprint.
  - Update `src/main/harness-config/index.ts` and types only as needed to import/re-export canonical shared contracts; remove any structural duplicates rather than adding compatibility aliases.

### Implementation Phase 2: Register and execute main handlers

- **GOAL-002**: Compose the service, persistence, store, and compound transport behind a testable adapter that cannot bypass scope or confirmation rules.

- [ ] **TASK-004**: Create `src/main/harness-config-transport/index.ts` and `src/main/harness-config-transport/harness-config-transport.ts`.
  - Export `registerHarnessConfigRequestHandlers({ transport, store, service, now })` from the package barrel.
  - Type dependencies by the narrow methods used by the adapter so tests can provide deterministic fakes without importing Electron or starting a server.
  - Keep the plan-binding map and in-flight counter private to one registration instance.
- [ ] **TASK-005**: Implement boundary parsers and structured error mapping in `harness-config-transport.ts`.
  - Parse plain objects, exact managed scopes, resource types, direction, phase, strings, and confirmation; reject arrays, null, missing fields, wrong primitives, unsupported Pi, and unknown agent/resource values.
  - Call `toAgentKind()` as required, but require exact round-trip equality and the managed allowlist before accepting its result.
  - Map known `HarnessConfigError` values to their stable safe code/message and unknown exceptions to `internal-error`; never return thrown transport rejections for expected validation or service failures.
- [ ] **TASK-006**: Implement one lifecycle wrapper for all handlers.
  - Increment/decrement the in-flight counter in `try/finally`, emit loading only on boundary transitions, and clear error at request start.
  - On failure, dispatch the safe error message before returning `{ ok: false, error }`.
  - Prevent an earlier successful request from clearing an error produced by a later concurrent request; error clearing occurs only at explicit request start.
- [ ] **TASK-007**: Register `harnessConfig:scan` and `harnessConfig:readFile`.
  - Scan validates scope, calls `service.scan`, captures `now()` once, dispatches `resourcesLoaded`, and returns `{ resources, scannedAt }`.
  - Read validates scope and ID, calls the fresh service read, verifies agent and logical/canonical/alias membership, and returns content only through the response.
  - Neither handler writes desired config or disk.
- [ ] **TASK-008**: Register prepare phases for create, update, delete, and both conversions.
  - Route each validated payload to the one matching service method.
  - Enforce fixed conversion source types and record the returned `planId` with channel, exact scope, and affected canonical/alias logical views.
  - Return the public mutation plan without dispatching inventory or sync-plan success events.
- [ ] **TASK-009**: Register `harnessConfig:planSync`.
  - Route `sync-to-disk` to `planSyncToDisk(scope)` and `adopt-from-disk` to `planAdoptFromDisk(scope)`.
  - Record a binding containing channel, scope, direction, and every canonical/alias resource type named by the plan's differences.
  - Dispatch `syncPlanLoaded` without `syncedAt`, then return the public plan.
- [ ] **TASK-010**: Implement the shared bound-plan apply path and register direct mutation apply phases.
  - Reject missing or mismatched binding metadata before service apply; do not permit a plan from one request kind to execute through another.
  - Pass `planId` and the received confirmation to `service.applyPlan`; rely on the service for consumption, stale fingerprints, backup, atomicity, rollback, and same-harness enforcement.
  - After every reached apply attempt, refresh the bound scopes as required by REQ-015; on success return the apply result, and on failure preserve the original structured error after any successful state refresh.
- [ ] **TASK-011**: Register `harnessConfig:syncToDisk` and `harnessConfig:adoptFromDisk` on the shared apply path.
  - Require the matching direction binding and exact scope.
  - On success, rescan affected inventory, generate a fresh same-direction plan, dispatch it with one `syncedAt` timestamp, and return the apply result.
  - On partial failure, rescan and optionally dispatch a fresh comparison without `syncedAt`, then return the apply error.
- [ ] **TASK-012**: Add deterministic refresh helpers.
  - Start with the binding's selected, canonical, alias, and conversion-target logical resource types; after each successful scan, add newly returned aliases and scan each scope at most once.
  - Reuse one `scannedAt` value for the refresh batch and dispatch one `resourcesLoaded` event per successfully refreshed scope.
  - Never broaden refresh to another `agentKind` and never hide an apply error behind a refresh error.
- [ ] **TASK-013**: Compose the adapter in `src/main/index.ts`.
  - Import `HarnessConfigService`, persistence accessors, and `registerHarnessConfigRequestHandlers` through package barrels.
  - Construct one service after the long-lived `config` is loaded, binding the Step 5 read/replace functions to that same object.
  - Invoke registration from the existing request-registration flow before desktop/headless clients connect; do not duplicate handlers per transport and do not call `saveConfig()` from these handlers.

### Implementation Phase 3: Expose the renderer backend API

- **GOAL-003**: Make every harness configuration operation available through the selected backend with shared argument and result types.

- [ ] **TASK-014**: Update `src/renderer/types/types.ts`.
  - Import and re-export the shared harness-config scope, file-ref, plan, request, apply-result, and request-result types through the shared package barrel.
  - Add `scanHarnessConfig`, `readHarnessConfigFile`, `createHarnessConfigFile`, `updateHarnessConfigFile`, `deleteHarnessConfigFile`, `planHarnessConfigSync`, `syncHarnessConfigToDisk`, `adoptHarnessConfigFromDisk`, `createHarnessConfigCommandFromSkill`, and `createHarnessConfigSkillFromCommand` to `ElectronAPI`.
  - Give every method exactly one typed input object and its exact `Promise<HarnessConfigRequestResult<...>>` return type.
- [ ] **TASK-015**: Update `src/renderer/build-backend/build-backend.ts` with ten active-routed method mappings.
  - Map each `ElectronAPI` method one-to-one to the channel in REQ-001 through `req`, preserving the single object argument.
  - Do not use `reqLocal`; remote Config pages must manage the active remote backend's harness files, state, and plans.
  - Do not add preload wiring because the generic `LocalTransportHandle.request()` already carries named requests.

### Implementation Phase 4: Prove safety and integration

- **GOAL-004**: Verify validation, confirmation, scoping, event ordering, partial-apply refresh, and renderer/main contract completeness before delivery.

- [ ] **TASK-016**: Add `src/main/harness-config-transport/harness-config-transport.test.ts` using a captured-handler fake transport, recording fake store, deterministic clock, and fake service.
  - Test observable request results and dispatched events, not private helper calls or source text.
  - Cover successful scan/read, content exclusion from events, and exact scoped resource/plan payloads.
- [ ] **TASK-017**: Add security and confirmation regression cases.
  - Prove unknown/empty agent values, Pi, invalid resource types, malformed payloads, mismatched scope/channel/direction bindings, false confirmation, missing/reused plans, and cross-harness destination attempts never invoke a mutating service method.
  - Prove `toAgentKind()` fallback cannot turn invalid input into Claude authorization.
  - Prove conversion requests cannot select a destination harness and enforce Skills-to-Commands or Commands-to-Skills source types.
- [ ] **TASK-018**: Add event-order and refresh regression cases.
  - Prove prepare and read-only comparison do not dispatch resource mutation events or `syncedAt`.
  - Prove successful scan dispatches after the service returns; successful apply refreshes selected/canonical/alias scopes; confirmed sync/adopt alone sets `syncedAt`.
  - Simulate partial apply failure and prove successful rescans update inventory while the request still returns the original apply error and does not set `syncedAt`.
  - Overlap two deferred requests and prove loading stays true until both settle.
- [ ] **TASK-019**: Add structured-error and side-effect-order cases.
  - Prove known service errors preserve safe code/message, unknown errors become `internal-error`, and neither response/store events nor logs contain supplied content.
  - Prove failed scan produces no `resourcesLoaded`, failed planning produces no `syncPlanLoaded`, and failed apply never emits a success timestamp.
  - Prove a refresh failure cannot replace the primary apply failure.
- [ ] **TASK-020**: Run `npx vitest run src/main/harness-config-transport/harness-config-transport.test.ts src/main/harness-config/harness-config.test.ts src/shared/state/harness-config/harness-config.test.ts`, then run `pnpm typecheck` and `pnpm build`.
  - Resolve every failure without weakening strict scope validation, confirmation, plan binding, structured errors, or state-content boundaries.
  - Exercise the built backend with a throwaway fake `LocalTransportHandle` that calls all ten renderer methods and records the ten request names and single-object arguments; remove the throwaway script after it passes.
- [ ] **TASK-021**: Review the final change against the complete request table and downstream UI needs.
  - Verify all ten channels exist exactly once on main and renderer, all mappings use the active backend, and no request accepts paths or cross-harness destinations.
  - Verify the adapter contains no backup/write implementation, the service contains no store/transport integration, desired content remains main-only, and the shared slice remains content-free.
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
- **ALT-007**: Register ten handlers directly inside the already-large `src/main/index.ts` without a package seam. Rejected because boundary validation, plan binding, concurrency, refresh, and error mapping require focused behavioral tests while `src/main/index.ts` has boot side effects and no request-registration test seam.
- **ALT-008**: Route Config requests through `reqLocal`. Rejected because a renderer connected to a remote backend must read and mutate that backend's harness directories and mirrored state, not the local Electron host.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk inventory versus Tatsu desired config, confirmation boundary, Claude alias behavior, and backup requirement.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines managed harness scope, exact `{ agentKind, resourceType }` isolation, conflict semantics, and the no-cross-harness rule.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) provides `HarnessConfigService`, public plans/results, structured service errors, prepare/apply behavior, stale fingerprints, filesystem safety, backups, rollback, and authoritative rescans.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) provides the canonical resource-type union and harness capability metadata.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) provides the content-free `harnessConfig` slice, six event variants, scope keying, and timestamp semantics.
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) provides `getPersistedHarnessConfigResources(config)` and synchronous `replacePersistedHarnessConfigScope(config, scope, resources)` bound to the long-lived config.
- **DEP-007**: `src/shared/transport/transport/transport.ts` and `src/main/transport-compound/transport-compound.ts` provide the untyped named request registration and Electron/WebSocket fan-out used by the adapter.
- **DEP-008**: `src/main/agent-kind/agent-kind.ts` provides the required but permissive `toAgentKind()` normalizer; the adapter adds exact validation around it.
- **DEP-009**: Steps 7 through 10 consume these typed methods for page loading, editor actions, conflict confirmation, sync direction selection, and skill/command conversion.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/types.ts` — shared request/result/error DTOs and serializable plan alignment.
- **FILE-002**: `src/shared/state/harness-config/index.ts` — existing package barrel; verify it exports the added contracts.
- **FILE-003**: `src/main/harness-config/types.ts` — remove or redirect duplicate safe public error/plan contracts if Step 2 placed them in main.
- **FILE-004**: `src/main/harness-config/index.ts` — public service barrel and canonical shared type re-exports.
- **FILE-005**: `src/main/harness-config-transport/index.ts` — new transport-adapter package barrel.
- **FILE-006**: `src/main/harness-config-transport/harness-config-transport.ts` — validation, lifecycle, error mapping, plan bindings, refresh, and ten request registrations.
- **FILE-007**: `src/main/harness-config-transport/harness-config-transport.test.ts` — adapter behavioral and security coverage.
- **FILE-008**: `src/main/index.ts` — one service construction and one compound-transport registration call bound to the long-lived config/store.
- **FILE-009**: `src/renderer/types/types.ts` — typed renderer API methods and shared type imports/exports.
- **FILE-010**: `src/renderer/build-backend/build-backend.ts` — ten active-backend request mappings.

## 6. Testing

- **TEST-001**: Scan/read coverage proves strict scopes, post-success inventory dispatch, fresh ID resolution, alias membership, and response-only file content.
- **TEST-002**: Prepare/apply coverage proves no mutation occurs during prepare and only a matching, current, confirmed, single-use plan reaches `applyPlan`.
- **TEST-003**: Validation coverage proves malformed payloads, unknown values, Pi, invalid resource types, permissive normalizer fallback, and authority-bearing fields fail closed.
- **TEST-004**: Scope coverage proves plans cannot cross request kind, direction, logical resource type, or harness and conversions never accept a destination harness.
- **TEST-005**: Event coverage proves comparison does not set `lastSyncedAt`, successful sync/adopt does, direct mutations refresh inventory only, and success events follow successful service work.
- **TEST-006**: Alias coverage proves a Claude resource refreshes its canonical and alias logical views without creating another physical identity or desired record.
- **TEST-007**: Partial-failure coverage proves post-attempt rescans expose completed disk changes while preserving the original apply error and withholding a success timestamp.
- **TEST-008**: Concurrency coverage proves the loading counter remains true until the final overlapping request settles.
- **TEST-009**: Error coverage proves stable known codes, generic unknown failures, safe slice messages, and no content leakage.
- **TEST-010**: Renderer smoke coverage proves every `ElectronAPI` method emits the correct active-backend request name with exactly one object argument.
- **TEST-011**: Targeted Vitest, `pnpm typecheck`, and `pnpm build` all exit successfully.
- **TEST-012**: Identifier declaration validation from the `plan-implementation-plan` skill reports no duplicate TASK/GOAL table declarations and no duplicate bullet-style declaration identifiers.

## 7. Risks & Assumptions

- **RISK-001**: Step 2's current plan types may not expose enough safe metadata to bind and refresh affected logical views. Promote only scope, kind, timestamps, and public refs/resource types; never expose content or executable operations to solve this.
- **RISK-002**: Multi-file sync can partially mutate disk before a later operation fails. The adapter cannot make it transactional; mandatory post-attempt rescans, preserved backups, and the original structured error make the resulting state visible and recoverable.
- **RISK-003**: The global slice error represents the most recently started/failed request rather than a per-scope history. This plan preserves the required Step 4 state shape; request responses remain authoritative for the initiating client.
- **RISK-004**: Plan bindings exist in both the adapter and service process memory. They are deliberately ephemeral and invalidated by restart; the adapter stores metadata only, while the service remains authoritative for executable operations and fingerprints.
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
