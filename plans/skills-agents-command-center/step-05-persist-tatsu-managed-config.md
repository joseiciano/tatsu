---
goal: Persist canonical Tatsu-managed harness configuration as durable desired state
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, persistence, migration, harness-config, sync]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan adds a versioned, durable desired-state model for Tatsu-managed agent definitions, skills, and commands. It implements Step 5 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md) using the feature goals and source-of-truth rules in [implementation-details.md](./implementation-details.md): disk inventory remains the current filesystem view, while Tatsu config stores canonical managed resources, including full UTF-8 content, so a confirmed sync can recreate files that are missing or deleted from harness directories. Filesystem discovery, confirmed mutation plans, shared inventory state, transport handlers, and UI remain owned by Steps 2, 4, 6, and later.

## 1. Requirements & Constraints

- **REQ-001**: Extend `src/main/persistence/types.ts` with `PersistedHarnessConfig { version: 1; resources: PersistedHarnessConfigResource[] }` and an optional `Config.harnessConfig?: PersistedHarnessConfig` field. The field remains optional at the TypeScript boundary so legacy config literals and pre-migration data remain representable; `loadConfig()` and the harness-config accessors MUST supply the version-1 empty default at runtime.
- **REQ-002**: `PersistedHarnessConfigResource` MUST use the canonical desired-resource contract from `src/main/harness-config`: `id`, `agentKind`, canonical `resourceType`, `aliasResourceTypes`, root-relative POSIX `relativePath`, `label`, full UTF-8 `content`, lowercase hexadecimal SHA-256 `hash`, and `updatedAt`.
- **REQ-003**: `agentKind` MUST accept only the Step 1 managed harness union `claude | codex | opencode`; `pi` MUST NOT be persisted as a managed resource in the first implementation.
- **REQ-004**: `resourceType` MUST use the canonical `HarnessConfigResourceType` exported by `src/shared/agent-registry`. Persistence MUST NOT declare another `agents | skills | commands` union.
- **REQ-005**: Persist exactly one record per physical canonical resource. A Claude skill exposed in both Skills and Commands MUST be stored once with `resourceType: 'skills'` and `aliasResourceTypes: ['commands']`; no logical-view alias may produce a duplicate persisted record.
- **REQ-006**: Persist full content and its exact byte hash. Hash verification MUST use SHA-256 over `Buffer.from(content, 'utf8')` without newline, Unicode, or whitespace normalization so Step 2 can compare disk and desired state byte-for-byte.
- **REQ-007**: Persist only portable desired-state data. `absolutePath`, resolver roots, `existsOnDisk`, `managed`, disk modification times, editor drafts, live plans, executable operations, and shared-state request status MUST NOT enter `Config.harnessConfig`.
- **REQ-008**: Add a fresh version-1 empty object `{ version: 1, resources: [] }` to the config default path. Do not reuse a mutable singleton resource array across `loadConfig()` results.
- **REQ-009**: Append the next global config migration, currently v7 to v8, without rewriting or reordering historical migrations. The migration MUST initialize `harnessConfig` only when the key is absent and MUST preserve an existing version-1 object byte-for-byte.
- **REQ-010**: The v7 to v8 migration MUST NOT silently replace a present malformed object or an unknown nested `harnessConfig.version`. Accessors MUST reject malformed or unsupported persisted desired state before comparison or mutation so an older binary cannot erase newer-format desired resources.
- **REQ-011**: Export a read accessor from the existing `src/main/persistence` barrel that returns the canonical desired resources expected by Step 2's injected `loadDesiredResources()` dependency. Missing config MUST read as an empty version-1 resource set; malformed or unsupported present config MUST throw a stable error and leave unrelated config available.
- **REQ-012**: Export a scoped replacement operation compatible with Step 2's injected `replaceDesiredScope(scope, resources)` dependency. It MUST replace only resources whose canonical `agentKind` and `resourceType` match the requested scope, preserve all other resource objects, reject resources outside the requested canonical scope, reject duplicate physical IDs, and produce deterministic order by managed harness order `claude`, `codex`, `opencode`; then canonical resource order `agents`, `skills`, `commands`; then `relativePath`; then `id`.
- **REQ-013**: Before writing a replacement, validate every incoming and retained resource: allowed managed harness, canonical resource type, non-empty stable ID, root-relative POSIX path, finite non-negative `updatedAt`, unique alias types excluding the canonical type, lowercase 64-character hash, and hash equality with the UTF-8 content.
- **REQ-014**: Scoped replacement MUST persist the complete next `Config` synchronously and report write failure to the caller. It MUST update the in-memory `config.harnessConfig` reference only after the durable write succeeds; on serialization or filesystem failure, throw and leave the in-memory config unchanged so Step 2 can roll back the corresponding harness-file mutation.
- **REQ-015**: Do not use the existing debounced `saveConfig()` path for `replaceDesiredScope`. Its delayed write and swallowed error cannot satisfy Step 2's persistence-failure and rollback contract. Add a synchronous throwing write path used by the scoped replacement without changing the existing best-effort behavior of unrelated settings saves.
- **REQ-016**: Reading desired resources and constructing a candidate replacement MUST not mutate the supplied `Config`, nested desired config, resource objects, or alias arrays. Copy at the persistence boundary so service code cannot accidentally mutate the loaded config by retaining an array reference.
- **REQ-017**: `src/main/build-initial-state/build-initial-state.ts` MUST remain unchanged. Desired content is main-process persistence data consumed by the harness-config service, not renderer state; Step 4's `harnessConfig` slice remains content-free and starts from its own initial state until Step 6 dispatches scan/plan events.
- **REQ-018**: This step MUST NOT add filesystem discovery, harness-directory writes, store events, transport request handlers, renderer methods, editor state, or UI. It provides the durable desired-state boundary and the exact dependency seam consumed by Steps 2 and 6.
- **SEC-001**: Persisted `relativePath` values are data, not filesystem authority. Validation in this step reduces malformed state, but Step 2 MUST still resolve and confine every target against the selected harness resolver before reading or writing disk.
- **SEC-002**: Error messages and logs MUST NOT include resource `content`. Errors MAY identify the resource by `id`, `agentKind`, `resourceType`, or `relativePath` when needed for diagnosis.
- **CON-001**: No new runtime or development dependency is permitted; use Node's `crypto`, `fs`, and `path` APIs plus existing persistence infrastructure.
- **CON-002**: Preserve the package boundary: consumers import types and helpers through `src/main/persistence`, not deep implementation paths.
- **GUD-001**: Keep the nested `version: 1` independent from the global `schemaVersion`. Global migrations introduce or reshape the top-level field; the nested version governs future desired-resource format changes.
- **PAT-001**: Follow the append-only migration pattern in `src/main/persistence-migrations/persistence-migrations.ts` and the package-local test import pattern used by the existing persistence and migration tests.

## 2. Implementation Steps

### Implementation Phase 1: Define desired persistence contracts

- **GOAL-001**: Establish one versioned, canonical, content-complete desired-resource model without duplicating service or shared taxonomy types.

- [ ] **TASK-001**: Update `src/main/persistence/types.ts` to import the canonical desired-resource type from the `src/main/harness-config` package barrel and define the persisted aliases and container required by REQ-001 through REQ-007.
  - Export `PersistedHarnessConfigResource` as the persistence name for Step 2's canonical desired-resource contract rather than independently restating its fields.
  - Export `PersistedHarnessConfig` with literal `version: 1` and `resources: PersistedHarnessConfigResource[]`.
  - Add `harnessConfig?: PersistedHarnessConfig` to `Config` adjacent to other feature-owned persisted state.
  - If Step 2's implementation used a different desired-resource symbol name, rename it at its defining package and migrate every type import; do not create compatibility aliases or two structural definitions.
- [ ] **TASK-002**: In `src/main/persistence/persistence.ts`, add a small constructor that returns a fresh empty version-1 desired config and use it in the default/fallback load paths.
  - Preserve the existing `windowBounds`, `repoRoots`, schema stamping, and connection-default behavior.
  - Ensure a missing file, invalid top-level JSON, or absent `harnessConfig` yields a fresh `{ version: 1, resources: [] }` object without sharing its resources array with another call.
- [ ] **TASK-003**: Add module-private validation and cloning helpers in `src/main/persistence/persistence.ts` for nested version, resource fields, canonical scope, exact content hash, duplicate IDs, alias invariants, and deterministic comparison order.
  - Reject a present unsupported nested version rather than coercing it to version 1.
  - Reject Windows separators, absolute paths, NUL bytes, empty segments, `.` segments, and `..` segments in the persisted POSIX `relativePath`.
  - Keep validation errors content-free and deterministic so transport integration can safely map them later.

### Implementation Phase 2: Migrate and expose the service seam

- **GOAL-002**: Make legacy configs converge on the version-1 desired model and provide synchronous scoped reads and replacements for the harness-config service.

- [ ] **TASK-004**: Append migration index 7 in `src/main/persistence-migrations/persistence-migrations.ts` as the v7 to v8 migration.
  - When `c.harnessConfig === undefined`, set it to a new `{ version: 1, resources: [] }` object.
  - When the key is already present, leave it untouched; do not normalize, delete, or reinterpret unknown nested versions inside a global schema migration.
  - Rely on the existing `SCHEMA_VERSION = migrations.length` invariant so the global version becomes 8 automatically.
- [ ] **TASK-005**: Add `getPersistedHarnessConfigResources(config)` to `src/main/persistence/persistence.ts` and export it through the existing package barrel.
  - Treat an absent field as an empty version-1 desired config for legacy in-memory callers.
  - Validate a present field using TASK-003, then return copied resource objects and copied alias arrays in deterministic order.
  - Return canonical records only; never synthesize logical Claude alias rows or disk-only metadata.
- [ ] **TASK-006**: Add `replacePersistedHarnessConfigScope(config, scope, resources)` to `src/main/persistence/persistence.ts` and export it through the existing package barrel.
  - Validate the currently retained records before editing so malformed state cannot be silently discarded.
  - Require every incoming record to match `scope.agentKind` and canonical `scope.resourceType` and to pass TASK-003 validation.
  - Remove only the matching canonical scope, append validated copies of the replacement records, enforce global physical-ID uniqueness, sort deterministically, and construct a complete next `Config` without mutating the input.
- [ ] **TASK-007**: Add a synchronous throwing config writer in `src/main/persistence/persistence.ts` and make TASK-006 use it before assigning `config.harnessConfig`.
  - Serialize and write the complete next config to the existing `config.json` path.
  - Log a content-free persistence failure and rethrow the original error or a stable persistence error with the original cause.
  - Assign the validated nested desired object back to the long-lived `config` object only after the write returns successfully.
  - Leave `saveConfig()` and the existing best-effort `saveConfigSync()` behavior unchanged for unrelated callers.
- [ ] **TASK-008**: Verify the exports in `src/main/persistence/index.ts` expose the new types and helpers through its existing `export type *` and `export *` statements; edit the barrel only if the implementation introduces a file not already covered.
  - Do not import persistence helpers into `src/main/harness-config`; Step 2 remains dependency-injected.
  - Step 6 will close over the loaded main-process `config` and pass TASK-005 and TASK-006 as `loadDesiredResources` and `replaceDesiredScope` dependencies when it constructs the service.
- [ ] **TASK-009**: Confirm `src/main/build-initial-state/build-initial-state.ts` and its tests require no change.
  - The persisted desired content MUST NOT be copied into `AppState`, initial wire snapshots, or the Step 4 content-free slice.
  - Remove any attempted hydration of desired content discovered during implementation rather than retaining a second runtime source of truth.

### Implementation Phase 3: Prove migration and persistence behavior

- **GOAL-003**: Verify legacy convergence, canonical alias storage, strict scope isolation, deterministic persistence, and failure propagation before the adapter is consumed by transport handlers.

- [ ] **TASK-010**: Extend `src/main/persistence-migrations/persistence-migrations.test.ts` with focused v7 to v8 tests using the existing `runOne` helper.
  - Prove an absent key becomes exactly `{ version: 1, resources: [] }`.
  - Prove an existing version-1 object, including resource content and alias metadata, is preserved.
  - Prove a present malformed object and unknown nested version are not overwritten by the global migration.
  - Extend the end-to-end migration coverage to assert the empty desired config and global schema version 8.
- [ ] **TASK-011**: Extend `src/main/persistence/persistence.test.ts` with accessor tests for missing, valid, malformed, and unsupported-version desired config.
  - Prove returned arrays, resource objects, and alias arrays cannot mutate the source `Config` by reference.
  - Prove exact content survives retrieval and that hash verification is byte-sensitive.
  - Prove validation errors do not include the resource content.
- [ ] **TASK-012**: Add scoped replacement tests to `src/main/persistence/persistence.test.ts`.
  - Prove replacing Claude Skills preserves Claude Agents, native Claude Commands, and every Codex/OpenCode record by value.
  - Prove a Claude skill with `aliasResourceTypes: ['commands']` is persisted once and replacing native Claude Commands neither duplicates nor deletes that skill.
  - Prove out-of-scope resources, Pi, duplicate IDs, invalid paths, self-aliases, duplicate aliases, invalid timestamps, malformed hashes, and content/hash mismatches are rejected without mutating the input.
  - Prove output order is `claude`, `codex`, `opencode`; then `agents`, `skills`, `commands`; then `relativePath`; then `id`.
- [ ] **TASK-013**: Add durable-write tests to `src/main/persistence/persistence.test.ts` using an isolated or mocked config path.
  - Prove a successful scoped replacement writes a complete JSON config containing unrelated settings plus the next desired resources, then updates the in-memory config reference.
  - Force serialization or filesystem write failure and prove the error reaches the caller, no success is reported, and the original in-memory `config.harnessConfig` object remains unchanged.
  - Prove the throwing path never logs resource content.
- [ ] **TASK-014**: Run `npx vitest run src/main/persistence/persistence.test.ts src/main/persistence-migrations/persistence-migrations.test.ts`, then run `pnpm typecheck` and `pnpm build`; resolve every failure without weakening validation, canonical scope isolation, or synchronous failure propagation.
- [ ] **TASK-015**: Review the final diff against Steps 1, 2, 4, and 6.
  - Verify there is one canonical desired-resource contract, one canonical resource-type union, and no persisted duplicate for a Claude alias.
  - Verify no desired content entered shared state, snapshots, events, logs, transport contracts, or renderer code.
  - Verify the only runtime source change outside `src/main/persistence/` is the appended migration and its test.
- [ ] **TASK-016**: Commit the persistence contracts, migration, helpers, and tests as one focused change with message `feat: persist harness config desired state`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Do not include unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Persist only file references and hashes. Rejected because a config-only or deleted disk resource cannot be recreated by sync-to-disk without the full desired content.
- **ALT-002**: Persist one record per logical Skills and Commands row. Rejected because Claude exposes a physical skill in both views; duplicate records would drift independently and could generate double writes or conflicting deletions.
- **ALT-003**: Copy desired content into the shared `harnessConfig` slice at startup. Rejected because content may be large or sensitive, would inflate every snapshot, and main-process persistence plus request-scoped reads already provide the correct ownership boundary.
- **ALT-004**: Skip the global migration because `Config.harnessConfig` is optional. Rejected because an explicit append-only migration gives existing installations the same observable version-1 empty shape as new installations while the nested version remains available for future resource-format changes.
- **ALT-005**: Use debounced `saveConfig()` for scoped replacements. Rejected because it returns before durability is known and swallows write failures, preventing Step 2 from rolling back a disk mutation when desired-state persistence fails.
- **ALT-006**: Reset malformed or unknown nested desired state to empty. Rejected because silent reset could turn a future-version or manually recoverable config into an empty desired source and make a later confirmed sync propose destructive disk deletions.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk-inventory versus Tatsu-config source-of-truth model, explicit mutation boundary, and requirement to preserve existing user files.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the managed harness set, exact `{ agentKind, resourceType }` scoping, canonical Claude alias identity, confirmed plan semantics, and the requirement that desired config can recreate missing files.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) owns the canonical desired-resource contract, byte-exact hash semantics, and injected `loadDesiredResources()` / `replaceDesiredScope()` dependency interface consumed by this plan.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) owns the canonical `HarnessConfigResourceType` export and the first-version supported harness/resource matrix.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) owns content-free inventory and plan state; it must not become an alternate store for desired content.
- **DEP-006**: [Step 6](./step-06-transport-request-handlers.md) will compose the loaded `Config`, the helpers from this step, the Step 2 service, and post-side-effect store dispatches.
- **DEP-007**: `src/main/persistence/persistence.ts` currently owns `config.json` load/save behavior, while `src/main/persistence-migrations/persistence-migrations.ts` owns the append-only global schema chain.
- **DEP-008**: Node built-ins `crypto`, `fs`, and `path` provide exact hashing, synchronous persistence, and path-shape checks without a new package dependency.

## 5. Files

- **FILE-001**: `src/main/persistence/types.ts` — versioned desired-config types, canonical resource alias, and optional `Config.harnessConfig` field.
- **FILE-002**: `src/main/persistence/persistence.ts` — fresh defaults, validation, cloning, deterministic scoped read/replace helpers, and synchronous throwing persistence.
- **FILE-003**: `src/main/persistence/persistence.test.ts` — accessor, validation, scope isolation, canonical alias, ordering, and write-failure coverage.
- **FILE-004**: `src/main/persistence-migrations/persistence-migrations.ts` — append-only v7 to v8 initializer for the missing desired-config field.
- **FILE-005**: `src/main/persistence-migrations/persistence-migrations.test.ts` — isolated and end-to-end migration coverage.
- **FILE-006**: `src/main/persistence/index.ts` — existing barrel; edit only if the selected implementation file layout is not already exported.

## 6. Testing

- **TEST-001**: Migration coverage proves absent legacy data receives an empty version-1 desired config while present current, malformed, and future-version nested data is preserved rather than silently erased.
- **TEST-002**: Accessor coverage proves valid desired resources retain exact content and metadata, returned values do not share mutable references with `Config`, and malformed data fails content-free.
- **TEST-003**: Canonical identity coverage proves one Claude skill may advertise the Commands alias but is persisted only once under its canonical Skills scope.
- **TEST-004**: Scope coverage proves replacement changes exactly one canonical `{ agentKind, resourceType }` scope and preserves every other harness/resource record.
- **TEST-005**: Validation coverage proves Pi resources, out-of-scope records, duplicate physical IDs, unsafe paths, invalid aliases/timestamps/hashes, and content/hash mismatches cannot be persisted.
- **TEST-006**: Ordering coverage proves persisted resources use deterministic harness, canonical resource type, relative path, and ID order.
- **TEST-007**: Failure coverage proves synchronous serialization/filesystem errors propagate and leave the in-memory desired-config reference unchanged, enabling Step 2 rollback.
- **TEST-008**: `npx vitest run src/main/persistence/persistence.test.ts src/main/persistence-migrations/persistence-migrations.test.ts` exits successfully.
- **TEST-009**: `pnpm typecheck` exits successfully across main, preload, renderer, and web-client project references.
- **TEST-010**: `pnpm build` exits successfully for the desktop and web-client bundles.
- **TEST-011**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL declarations and duplicate bullet-style declaration identifiers MUST both produce zero results.

## 7. Risks & Assumptions

- **RISK-001**: `config.json` will contain complete user-authored instructions and prompts in plaintext, increasing file size and sensitivity. Desired content must stay out of telemetry, logs, shared snapshots, and error text.
- **RISK-002**: A malformed or future nested version cannot safely participate in drift comparison. Failing closed may temporarily block the Config feature, but it avoids converting unknown desired state into an empty set and proposing destructive synchronization.
- **RISK-003**: Whole-config saves from unrelated settings still serialize `harnessConfig`. Step 6 must retain the same long-lived `config` object so later saves include the latest successful desired-state replacement rather than a stale copy.
- **RISK-004**: Desired-state persistence is synchronous because the service requires immediate failure reporting for rollback. Resource sets are expected to be small Markdown collections; if measured write latency becomes material, a later change may move the confirmed apply transaction off the main event loop without weakening the success/failure contract.
- **RISK-005**: The persisted path is portable only within a harness resolver root. Resolver-layout changes can make a valid relative path unsupported; Step 2 remains authoritative and must reject rather than guess a target.
- **ASSUMPTION-001**: Step 2 exposes a single canonical desired-resource type containing `aliasResourceTypes`; this plan reuses it instead of maintaining a structurally duplicate persistence record.
- **ASSUMPTION-002**: Step 4's shared slice is implemented before transport integration, but its presence does not change the decision to keep persisted desired content main-only.
- **ASSUMPTION-003**: Step 6 will instantiate the service once from the long-lived `config` loaded in `src/main/index.ts` and will bind the accessor/replacement helpers without adding another in-memory desired-state cache.
- **ASSUMPTION-004**: Version one manages UTF-8 Markdown entrypoints only; binary skill assets and repository-local resources remain outside the first implementation.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 4: Shared state slice](./step-04-shared-state-slice.md)
- [Step 6: Transport request handlers](./step-06-transport-request-handlers.md)
- [Repository persistence types](../../src/main/persistence/types.ts)
- [Repository persistence implementation](../../src/main/persistence/persistence.ts)
- [Repository migration chain](../../src/main/persistence-migrations/persistence-migrations.ts)
