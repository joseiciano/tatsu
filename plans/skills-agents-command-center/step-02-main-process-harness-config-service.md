---
goal: Implement a safe main-process service for harness configuration discovery, drift planning, and confirmed mutation
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, architecture, filesystem, harness-config, security]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan adds the main-process package that discovers and manages harness-facing agent definitions, skills, and commands for Claude Code, Codex, and OpenCode. It converts the product contract in [implementation-details.md](./implementation-details.md) and [Step 1](./step-01-product-boundary-source-of-truth.md) into a testable filesystem boundary: scans and comparisons of the disk inventory are read-only; every comparison, generated plan, and confirmed application is isolated to one `${agentKind}:${resourceType}` scope; and mutation of disk or Tatsu config occurs only by applying a current confirmed plan. This is Step 2 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md); transport, shared state, persistence wiring, and UI remain later steps.

## 1. Requirements & Constraints

- **REQ-001**: Create `src/main/harness-config/` with exactly `index.ts`, `harness-config.ts`, `types.ts`, and `harness-config.test.ts`; the barrel MUST be the public import surface.
- **REQ-002**: The service MUST expose the logical resource union `HarnessConfigResourceType = 'agents' | 'skills' | 'commands'` and MUST accept only the first-version managed harness union `ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>`. `pi` MUST be rejected as unsupported, not normalized to another harness.
- **REQ-003**: Every scan, comparison, plan, and apply operation MUST carry a required scope `{ agentKind, resourceType }`. `agentKind` MUST NOT be optional on `HarnessConfigSyncPlan`, and no operation may default to all harnesses.
- **REQ-004**: Each supported harness/resource pair MUST use a resolver descriptor with one explicit known-root key, discovery boundary, and name-to-relative-path rule. If the repository and authoritative harness integration do not establish those values, the pair MUST remain unsupported; the service MUST NOT guess a home-relative, repository-local, environment-variable, directory, or filename convention.
- **REQ-005**: Known roots MUST be resolved and normalized in main from the verified resolver descriptor and injected main-process environment/home dependencies. Root discovery MUST reject an empty, ambiguous, or unavailable root rather than falling back to a different harness or an invented default. A future additional root requires an explicit scope contract before it can be managed.
- **REQ-006**: Resolver inventory MUST be descriptor-driven for the initial `claude`, `codex`, and `opencode` harness scope. Each descriptor MUST declare whether each `agents | skills | commands` pair is supported, which verified entrypoints belong to it, its discovery boundary, and any stable same-file alias relationship. Unsupported or unverified pairs MUST return an unsupported-scope error and MUST NOT receive a synthetic path. Claude skill/command aliases that the verified resolver recognizes MUST share physical identity and path rather than becoming copied resources.
- **REQ-007**: Each resolver descriptor MUST explicitly distinguish the managed entrypoint from adjacent supporting assets. Discovery, overwrite, and delete MUST act only on the verified managed entrypoint; adjacent files and directories remain untouched unless a later contract explicitly adds them.
- **REQ-008**: Discovery MUST be deterministic: exclude symlinks, non-files, backup files ending in `.x-backup-<UTC timestamp>[-<collision>]`, and files outside the resolver pattern; sort results by `agentKind`, `resourceType`, then POSIX-style relative path.
- **REQ-009**: `HarnessConfigFileRef` MUST contain `id`, `agentKind`, current view `resourceType`, `canonicalResourceType`, `aliasResourceTypes`, `label`, root-relative POSIX `relativePath`, normalized `absolutePath`, SHA-256 `hash`, `existsOnDisk`, `managed`, and `updatedAt`. Disk `updatedAt` is `stat.mtimeMs`; config-only entries use the persisted timestamp.
- **REQ-010**: Physical identity MUST be independent of logical view. Generate `id` as the lowercase hexadecimal SHA-256 of `agentKind`, resolver root key, and canonical POSIX relative path separated by NUL bytes. A Claude skill shown in Commands MUST retain the skill's physical `id`, `canonicalResourceType: 'skills'`, and `aliasResourceTypes: ['commands']`.
- **REQ-011**: Hash exact file bytes with SHA-256 and lowercase hexadecimal output. Persisted UTF-8 content MUST be hashed from `Buffer.from(content, 'utf8')`; no newline or Unicode normalization may occur.
- **REQ-012**: The service MUST accept Tatsu config resources through injected `loadDesiredResources()` and `replaceDesiredScope(scope, resources)` dependencies. It MUST NOT import the whole app `Config`, call `saveConfig`, dispatch store events, or register transport handlers; Steps 4 through 6 own those integrations.
- **REQ-013**: The Tatsu config resource contract in `types.ts` MUST include `id`, `agentKind`, canonical `resourceType`, `aliasResourceTypes`, `relativePath`, `label`, `content`, `hash`, and `updatedAt`. Step 5 MUST persist this contract without maintaining duplicate desired records for Claude skill/command aliases.
- **REQ-014**: `scan(scope)` MUST return disk refs only; `readFile(id)` MUST resolve an ID from a fresh recognized inventory and return UTF-8 content plus the current hash. Neither method may trust a renderer-supplied absolute path.
- **REQ-015**: `planSync(scope)` MUST compare a fresh disk inventory with a fresh Tatsu config snapshot by physical `id` for exactly one `${agentKind}:${resourceType}` scope. It MUST return `HarnessConfigComparison = { scope, status, diskOnly, configOnly, changed, comparedAt }`, where all difference lists contain serializable refs and status is `synced` for no differences, `disk-only` for only disk-only entries, `config-only` for only config-only entries, and `conflict` for any changed entry or more than one non-empty difference category. `HarnessConfigComparison` MUST NOT contain `planId`, `direction`, `fingerprint`, executable operations, or any apply authority.
- **REQ-016**: `planSyncToDisk(scope)` and `planAdoptFromDisk(scope)` MUST return `HarnessConfigSyncPlan = { planId, scope, direction, status, diskOnly, configOnly, changed, generatedAt, fingerprint }`, where `direction` is `sync-to-disk` or `adopt-from-disk` and `fingerprint` is opaque. File content and executable operations MUST remain only in a private in-memory plan record keyed by `planId`.
- **REQ-017**: `planSyncToDisk(scope)` MUST generate, without applying, create operations for config-only resources, overwrite operations for changed resources, and delete operations for disk-only resources in the selected scope. `planAdoptFromDisk(scope)` MUST generate, without applying, one Tatsu config scope replacement and MUST never write to harness directories. The generated public plan and private operation snapshot together form the only candidate for later confirmation.
- **REQ-018**: Direct create, update, and delete MUST also use prepare/apply separation. `prepareCreate(scope, name, content)`, `prepareUpdate(scope, id, content)`, and `prepareDelete(scope, id)` MUST return a `HarnessConfigMutationPlan`; only `applyPlan({ scope, planId, confirmed: true })` may execute it. The supplied scope key MUST exactly equal the stored plan scope. A request to apply without a previously generated, still-current confirmed plan MUST be rejected, not applied. Cancel, dismiss, and `confirmed !== true` MUST perform zero disk or Tatsu config mutations.
- **REQ-019**: Create input MUST be a logical name, never a path. The verified resolver descriptor MUST validate that logical name and derive its relative path. A descriptor MUST reject any name it cannot map unambiguously within its known root; the service MUST NOT infer a filename or directory convention not declared by that descriptor.
- **REQ-020**: Applying a create/update/delete plan MUST update the corresponding Tatsu config scope only after the disk mutation succeeds. If Tatsu config persistence fails, restore overwritten/deleted bytes from the backup or remove a newly created file, then throw a structured error.
- **REQ-021**: Applying `sync-to-disk` MUST leave Tatsu config unchanged. Applying `adopt-from-disk` MUST replace only the exact `{ agentKind, resourceType }` scope of Tatsu config and MUST leave disk unchanged. Alias canonicalization MUST prevent an adopt of Claude Commands from duplicating desired Claude Skills.
- **REQ-022**: Immediately before the first apply mutation, recompute both the scoped disk inventory fingerprint and Tatsu config fingerprint from the same `${agentKind}:${resourceType}` scope and compare them with the private plan record. Reject an absent plan; reject and consume a plan if either fingerprint differs, its request scope differs, its resolver identity changed, or it was already attempted. A changed disk inventory, changed Tatsu config snapshot, resolver change, scope mismatch, or process restart makes the plan stale or unavailable; it MUST be rejected without writes and requires generation and confirmation of a new plan. `confirmed !== true` is an unconfirmed no-op and MUST NOT execute or consume the plan.
- **REQ-023**: Confirmed plan application MUST preflight every operation before the first mutation, execute operations in stable relative-path order, stop on the first failure, consume the plan, and return the successfully applied operations. Because multi-file filesystem writes are not transactional, callers MUST rescan after either success or partial failure.
- **REQ-024**: Creating or overwriting a file MUST call `mkdirSync(parent, { recursive: true })` only after confirmed-plan validation and use a sibling temporary file plus `renameSync` so readers never observe a partial write. Temporary files MUST be removed on failure.
- **REQ-025**: Before every destructive disk operation — overwrite, delete, or an equivalent existing-file operation generated by `sync-to-disk` — read the existing target once, preserve those unmodified bytes, and write them to `${absolutePath}.x-backup-${timestamp}`, where `timestamp` is UTC `YYYYMMDDTHHmmssSSSZ`. Use exclusive creation; append `-2`, `-3`, and so on on collision. The backup write MUST complete before the original is overwritten or deleted. Any backup read, name allocation, creation, or write failure MUST abort that target operation and leave the original untouched. A genuinely new target, revalidated as absent immediately before creation, MUST NOT create a backup.
- **REQ-026**: Existing-file rollback MUST copy the captured backup bytes rather than regenerate content. Successful backup files MUST remain on disk for user recovery and MUST be excluded from later scans.
- **REQ-027**: Conversion is owned by Step 10's prepare-only contract: `prepareCommandFromSkill(scope, id)` and `prepareSkillFromCommand(scope, id)` resolve the source within the requested scope and return the exact `HarnessConfigConversionResult` union: `{ status: 'alias', ref }` for a Claude skill/command alias with the existing stable identity and physical path; `{ status: 'existing', ref }` when an independent destination already exists; or `{ status: 'draft', ... }` with generated content. They MUST NOT create a mutation plan; the only write path for a draft is the user-confirmed direct create, which follows REQ-018 through REQ-026. No conversion may create a resource in a different `agentKind`.
- **SEC-001**: Reject empty paths, absolute relative paths, NUL bytes, `.` and `..` segments, platform separator variants, and candidates that do not match the selected resolver's filename pattern.
- **SEC-002**: Every read or write candidate MUST be reconstructed in main from the selected verified resolver's known root plus its validated relative path, then normalized with `resolve`. Lexical containment MUST require `candidate === root || candidate.startsWith(root + sep)`; string-prefix containment without a separator is forbidden. Plan data, Tatsu config, and renderer input are never path authority.
- **SEC-003**: Symlink escape protection MUST validate `realpathSync` for an existing target or the nearest existing ancestor of a new target against the real known root. A symlink target or ancestor that escapes that root MUST be rejected for read, write, backup, and delete.
- **SEC-004**: The service MUST never accept an absolute target path, persisted absolute path, renderer-selected root, plan-carried absolute path, or `toAgentKind()` fallback as authorization. Validate `agentKind` and `resourceType` with exact allowlists, and re-resolve every apply target in main from the current resolver.
- **SEC-005**: No operation may automatically copy, translate, infer, or apply a resource across different `agentKind` values. Plugin affiliation is provenance metadata only: plugins are never a fourth resource type, never an automatic cross-harness payload, and never copied or installed by sync, adopt, direct mutation, or conversion. Harness settings files outside verified resolver entrypoints MUST remain untouched.
- **CON-001**: Use synchronous Node filesystem APIs to match existing main-process configuration services and keep each prepared operation ordered; no new runtime dependency is permitted.
- **CON-002**: Keep live plans and operation content in memory only. Shared-state plans in Step 4 remain lightweight and editor content remains request-scoped.
- **CON-003**: Do not add transport handlers, shared state, renderer methods, persistence fields, migrations, or UI in this step. The service dependency interface is the seam those later steps implement.
- **GUD-001**: Inject known-root resolution, clock, UUID generation, Tatsu config access, and the filesystem adapter through a typed `HarnessConfigServiceDeps`; production defaults wrap only verified main-process resolver inputs and Node APIs, while tests use explicit temporary known roots plus deterministic clock/ID dependencies.
- **GUD-002**: Public methods MUST catch operational failures, log category `harness-config` through `log()` with `formatErr(err)`, and rethrow `HarnessConfigError` with a stable code and safe message; logs may contain the normalized path, while transport-facing messages MUST NOT expose file content.
- **PAT-001**: Follow the package/barrel convention used by `src/main/fs-listing/`: external imports use `src/main/harness-config`, and the test imports from `.`.
- **PAT-002**: Model resolvers as a closed `Record<ManagedHarnessKind, HarnessResolver>` whose resource descriptors own verified root keys, supported/unsupported state, discovery boundaries, name-to-relative-path conversion, and stable alias expansion. Do not spread harness-specific conditionals across mutation methods, and do not populate a descriptor from an assumed vendor convention.

The service MUST implement the [source-of-truth operation matrix](./implementation-details.md) rather than redefine it: scanning the disk inventory and comparing it with Tatsu config are read-only observations; every mutation — sync to disk, adopt from disk, direct create, direct update, or direct delete — is scoped by `${agentKind}:${resourceType}` and writes only the selected scope behind a previously generated, still-current confirmed plan (direct mutations use an explicit Create action or Save/Delete confirmation plus backup). Cancel and dismiss are no-ops. No global, cross-harness, or plugin-copy mutation exists in the first version (SEC-005).

## 2. Implementation Steps

### Implementation Phase 1: Define service contracts and resolvers

- **GOAL-001**: Establish one deterministic, main-only domain model for roots, physical identity, aliases, plans, operations, and structured failures.

- [ ] **TASK-001**: Create `src/main/harness-config/types.ts` with the unions, scope and canonical scope-key helper, resolver, file-ref, Tatsu config resource, sync-plan, mutation-plan, apply-result, dependency, filesystem-adapter, and `HarnessConfigError` contracts required by REQ-002 through REQ-023.
  - Make `agentKind` required on every scope and plan and constrain `resourceType` to `agents | skills | commands`.
  - Define error codes for unsupported scope, invalid name, unsafe path, unknown resource, unconfirmed plan, unknown plan, stale plan, collision, backup failure, read failure, write failure, delete failure, and Tatsu config persistence failure.
  - Keep executable plan operations and content private to the implementation; public plans expose summaries and fingerprints only.
- [ ] **TASK-002**: Add the closed resolver table in `src/main/harness-config/harness-config.ts` from resolver conventions verified by existing repository integration or authoritative harness documentation; record the verification source beside each supported descriptor.
  - Keep resource types logical: each descriptor owns its known-root resolver, managed entrypoint boundary, discovery rule, and logical-name-to-relative-path conversion without exposing concrete paths to renderer code.
  - Mark any harness/resource combination whose root or entrypoint convention is not verified as unsupported. Do not infer a path from another harness, a home-directory convention, an executable name, or an adjacent vendor file.
  - Convert descriptor-produced relative paths to `/` separators before identity, sorting, or persistence, and emit verified Claude skill aliases in the Commands view without duplicating physical IDs or Tatsu config records.
- [ ] **TASK-003**: Implement exact allowlist validation, resolver-owned known-root resolution, logical-name validation, lexical containment, nearest-existing-ancestor realpath containment, backup exclusion, SHA-256 hashing, physical ID generation, and deterministic sort helpers in `harness-config.ts`.
  - Reject symlinks during recursive discovery by using directory-entry/lstat information and never following symbolic-link directories.
  - Reconstruct normalized absolute paths only in main from the selected descriptor and its known root; keep helpers module-private unless a test must assert a public contract through the service.
- [ ] **TASK-004**: Create `src/main/harness-config/index.ts` and export only the service factory/class plus public types and error contracts from the package barrel.

### Implementation Phase 2: Implement read-only inventory and planning

- **GOAL-002**: Produce current, scoped inventories and immutable drift plans without mutating disk or Tatsu config.

- [ ] **TASK-005**: Implement `HarnessConfigService.scan(scope)` and `readFile(id)` in `harness-config.ts`.
  - Recursively enumerate only each resolver's allowed depth and filename pattern, collect `lstat`/`stat` metadata, hash exact bytes, and return deterministic refs.
  - Mark a disk ref `managed` only when the canonical physical ID exists in the freshly loaded desired resources for the same harness and canonical scope.
  - Resolve reads from a fresh recognized inventory and return `{ ref, content, hash }`; reject unknown or newly unsafe IDs.
- [ ] **TASK-006**: Implement `planSync(scope)` as scoped disk-inventory-versus-Tatsu-config comparison with the status precedence in REQ-015.
  - Return a transport-safe comparison only; do not allocate a plan ID, retain executable operations, or allow its fingerprint to be passed to `applyPlan`.
  - Build config-only refs only when the selected verified resolver can derive and confine the target path; otherwise reject instead of synthesizing a path.
  - Classify an ID as changed only when both sides exist and their exact SHA-256 hashes differ; canonicalize Claude aliases so one physical skill cannot appear simultaneously as disk-only and config-only across views.
- [ ] **TASK-007**: Implement `planSyncToDisk(scope)` and `planAdoptFromDisk(scope)` as scoped, non-mutating actionable-plan generators with private plan records.
  - Capture the canonical scope key, sorted disk inventory fingerprint, Tatsu config fingerprint, resolver identity, operation snapshots, and exact content needed for apply.
  - Store plans under injected UUIDs; return only the serializable public plan. Plan generation MUST perform zero disk and Tatsu config writes; application happens exclusively through `applyPlan({ scope, planId, confirmed: true })` after the user confirms that specific plan.
  - Generate no operations and preserve `status: 'synced'` when the selected scope already matches.
- [ ] **TASK-008**: Implement `prepareCreate`, `prepareUpdate`, and `prepareDelete` as scoped, non-mutating plan generators, and `prepareCommandFromSkill`/`prepareSkillFromCommand` as scoped, non-mutating, prepare-only conversion methods returning the exact `alias | existing | draft` `HarnessConfigConversionResult` from REQ-027 (no conversion plan is created; Step 10 owns the draft-create write path through the direct-create contract).
  - Reject destination collisions before storing a direct-mutation plan; conversion collisions instead return `{ status: 'existing', ref }` without writing.
  - For a Claude alias conversion in either direction, return `{ status: 'alias', ref }` carrying the existing stable physical ref without creating a plan or a file.
  - Never generate an operation whose source and destination harness differ; plugin provenance MUST NOT become conversion or copy input.

### Implementation Phase 3: Apply confirmed plans safely

- **GOAL-003**: Execute only current confirmed plans with fail-closed backup, path, rollback, and persistence behavior.

- [ ] **TASK-009**: Implement `applyPlan({ scope, planId, confirmed })` with single-use lookup, explicit confirmation enforcement, exact `${agentKind}:${resourceType}` scope/resolver binding, fresh disk inventory and Tatsu config fingerprint recomputation, and all-operation preflight before mutation.
  - Return without mutation and without consuming the plan when `confirmed !== true`. Reject an absent plan. Reject and consume a reused, scope-mismatched, resolver-changed, or stale stored plan; stale rejection requires plan regeneration and a new explicit confirmation.
  - Mark a confirmed current plan attempted before its first side effect so it cannot be replayed; consume it on success or failure.
  - Return structured `applied`, `resultingRefs`, and `requiresRescan: true` fields without dispatching store events.
- [ ] **TASK-010**: Implement atomic create/overwrite and guarded delete primitives.
  - Immediately before every filesystem operation, reconstruct the target from the current main resolver, normalize it, and revalidate lexical and realpath containment in the selected known root.
  - For an existing target, read and retain its unmodified bytes once; create the exclusive dated backup from those bytes and verify backup completion before overwrite or delete. Then write replacements through a unique sibling temporary file and rename into place.
  - Abort on any backup failure before unlink or overwrite, leaving the original untouched. Revalidate absence and skip backup creation only for a genuinely new target.
- [ ] **TASK-011**: Implement direct-mutation Tatsu config updates and rollback.
  - After a successful disk create/update/delete, replace only the affected canonical Tatsu config scope.
  - On Tatsu config persistence failure, delete a just-created target or restore an overwritten/deleted target from the backup bytes, log both the persistence error and any rollback error, then throw `desired-state-failed`.
  - Leave successful backups in place even after rollback.
- [ ] **TASK-012**: Implement direction-specific application semantics.
  - `sync-to-disk` applies its stable ordered disk operations in only the selected known root and never calls `replaceDesiredScope`.
  - `adopt-from-disk` calls `replaceDesiredScope` exactly once to replace only the selected `${agentKind}:${resourceType}` portion of Tatsu config and performs zero harness filesystem writes.
  - Conversions are prepare-only: an `alias` result returns the existing Claude ref without mutation, and a `draft` result is saved only through the confirmed direct-create path with the same-harness guard — never through a conversion plan. No application path copies plugin payloads or resources to another harness.
- [ ] **TASK-013**: Wrap every public operation with consistent `harness-config` error logging and normalize unexpected Node errors into stable `HarnessConfigError` codes without swallowing the original cause.

### Implementation Phase 4: Prove service contracts

- **GOAL-004**: Verify resolver behavior, drift classification, confirmation gates, path confinement, backup ordering, stale-plan rejection, and rollback using isolated temporary roots.

- [ ] **TASK-014**: Create `src/main/harness-config/harness-config.test.ts` using Vitest, `mkdtempSync`, and `rmSync(..., { recursive: true, force: true })`; import the service from `.` and inject explicit temporary known roots, timestamps, UUIDs, resolver descriptors, and Tatsu config callbacks.
- [ ] **TASK-015**: Add resolver and inventory tests for each supported verified descriptor plus unsupported/unverified combinations, deterministic sorting, byte-exact hashes, stable physical IDs, backup exclusion, symlink exclusion, and Claude skill/command alias identity. Assert unsupported pairs never receive a guessed path.
- [ ] **TASK-016**: Add comparison and plan-generation tests covering all four statuses, disk-only/config-only/changed lists, same-ID unchanged files, exact `${agentKind}:${resourceType}` isolation, canonical alias deduplication, same-harness conversion, collision refusal, and prohibition of cross-harness or plugin-payload operations. Assert both sync-to-disk and adopt-from-disk generation perform zero writes and retain the exact scoped snapshots reviewed for confirmation.
- [ ] **TASK-017**: Add mutation safety tests proving cancel/dismiss and `confirmed !== true` are no-ops; unknown, reused, scope-mismatched, resolver-changed, process-lost, and stale plans perform zero writes; disk-inventory or Tatsu config changes after generation cause stale rejection and require a newly generated confirmed plan; traversal, absolute-path, prefix-sibling, separator-variant, and symlink-ancestor escapes are rejected; and parent directories are created only for a valid confirmed create.
- [ ] **TASK-018**: Add backup and failure-order tests proving overwrite and delete backups contain the exact unmodified pre-change bytes, the complete backup precedes the destructive operation, unique collision suffixes are used, every injected backup read/create/write failure leaves the original untouched, atomic-write failure removes temporary files, genuinely new files create no backup, and Tatsu config failure restores or removes the disk target as required.
- [ ] **TASK-019**: Add direction tests proving sync-to-disk creates/overwrites/deletes only inside the selected normalized main-resolved known root, adopt-from-disk performs no harness writes and replaces one Tatsu config scope, partial apply reports completed operations and requires rescan, and plugin provenance, plugin payloads, and harness settings files remain untouched.
- [ ] **TASK-020**: Run `npx vitest run src/main/harness-config/harness-config.test.ts`, `pnpm typecheck`, and `pnpm build`; resolve every failure without weakening validation or confirmation rules.
- [ ] **TASK-021**: Review downstream Steps 3 through 6 and update only incompatible type assumptions: capability metadata must match the resolver matrix, Step 4 must share the serializable public ref/plan shape without importing main code, Step 5 must persist canonical desired resources, and Step 6 must call prepare/apply rather than direct mutations.
- [ ] **TASK-022**: Commit the service as one focused change with message `feat: add harness config service` and push the current branch immediately after the commit succeeds.

## 3. Alternatives

- **ALT-001**: Let transport handlers accept arbitrary absolute paths and validate them inline. Rejected because duplicated handler checks are easy to bypass and renderer input must never become filesystem authority.
- **ALT-002**: Write immediately from create/update/delete, sync-to-disk, or adopt-from-disk requests after a boolean confirmation. Rejected because it does not produce a reviewable immutable plan, cannot reject stale input, and conflates comparison with mutation.
- **ALT-003**: Store one Tatsu config record per logical Claude Skills and Commands row. Rejected because the same physical skill would drift, back up, or overwrite twice and would violate alias identity.
- **ALT-004**: Let one `${agentKind}:${resourceType}` scope silently span multiple unresolved roots. Rejected because the confirmed plan would not identify which disk inventory is authorized; another root requires an explicit scope extension.
- **ALT-005**: Follow symlinks after checking normalized strings. Rejected because an in-root symlink can escape to arbitrary user files despite lexical containment.
- **ALT-006**: Add a generic filesystem abstraction package or external glob library. Rejected because the resolver set is small, Node APIs are sufficient, and a feature-local injected adapter is easier to audit and test.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, the disk inventory versus Tatsu config source-of-truth model, the source-of-truth operation matrix, the conflict requirement, the Claude caveat, and the backup invariant (established by step-01 TASK-008).
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the first-version harness boundary, confirmation semantics, stale-plan rule, scoped sync, no-cross-harness rule, and backup invariant consumed by this service.
- **DEP-003**: `src/shared/state/terminals/types.ts` owns `AgentKind = 'claude' | 'codex' | 'opencode' | 'pi'`; the service narrows this union explicitly and does not use `src/main/agent-kind/toAgentKind()` because its unknown-to-Claude fallback is unsafe at this boundary.
- **DEP-004**: `src/main/debug/` provides `log()` and `formatErr()` for operational failures.
- **DEP-005**: Node built-ins `fs`, `path`, `os`, and `crypto` provide discovery, confinement, backup, atomic replacement, root resolution, SHA-256, and UUID functionality; no package dependency is added.
- **DEP-006**: Step 3 must expose supported and unsupported capability metadata consistent with REQ-006, while the main resolver remains authoritative for verified known roots and normalized paths. Neither step may invent a path for an unknown combination.
- **DEP-007**: Step 4 must place the serializable public `HarnessConfigFileRef`, read-only comparison, and actionable plan contracts in a shared package or define structurally identical shared wire models; shared code MUST NOT import this main package.
- **DEP-008**: Step 5 must implement the Tatsu config dependency from REQ-012 with persisted canonical resources and migration/default behavior.
- **DEP-009**: Step 6 must instantiate the service after loading Tatsu config; expose read/scan and `planSync(scope)` comparison without apply authority; register distinct scoped prepare/plan/apply handlers; dispatch state only after side effects; and map structured service errors for clients.

## 5. Files

- **FILE-001**: `src/main/harness-config/index.ts` — package barrel for service and public contracts.
- **FILE-002**: `src/main/harness-config/types.ts` — scoped domain types, resolver/dependency contracts, plan/result shapes, and structured error definitions.
- **FILE-003**: `src/main/harness-config/harness-config.ts` — roots, resolvers, discovery, hashing, validation, planning, backup, confirmed application, and rollback implementation.
- **FILE-004**: `src/main/harness-config/harness-config.test.ts` — isolated behavioral and security regression coverage.
- **FILE-005**: `plans/skills-agents-command-center/step-03-harness-capability-metadata.md` — update only if its capability matrix conflicts with the implemented resolver matrix.
- **FILE-006**: `plans/skills-agents-command-center/step-04-shared-state-slice.md` — update only to align serializable shared types and alias identity.
- **FILE-007**: `plans/skills-agents-command-center/step-05-persist-tatsu-managed-config.md` — update only to persist canonical desired resources without alias duplication.
- **FILE-008**: `plans/skills-agents-command-center/step-06-transport-request-handlers.md` — update only to expose prepare/apply and structured error semantics.

## 6. Testing

- **TEST-001**: Resolver inventory fixtures prove every supported verified descriptor uses its injected known root and declared entrypoint boundary, while unsupported or unverified combinations return unsupported without deriving a concrete path; fixtures also prove deterministic ordering and backup/symlink exclusion.
- **TEST-002**: Hash and identity fixtures prove byte-exact SHA-256, POSIX path canonicalization, stable physical IDs, and shared Claude alias identity.
- **TEST-003**: Comparison fixtures prove `synced`, `disk-only`, `config-only`, and `conflict` precedence; strict `${agentKind}:${resourceType}` isolation; and that `planSync(scope)` is read-only and cannot authorize apply.
- **TEST-004**: Actionable-plan fixtures prove sync-to-disk and adopt-from-disk generation are non-mutating, capture exact scoped disk inventory and Tatsu config fingerprints, keep executable content private, deduplicate canonical aliases, refuse collisions, and never create cross-harness or plugin-copy operations.
- **TEST-005**: Confirmation fixtures prove cancel/dismiss and `confirmed: false` are no-ops; absent, wrong-scope, resolver-changed, stale, reused, and process-lost plan IDs cannot mutate disk or Tatsu config; a current confirmed plan applies only its captured scope; and stale rejection requires regeneration and reconfirmation.
- **TEST-006**: Path-security fixtures prove rejection of `..`, absolute paths, NUL bytes, mixed separators, sibling-prefix confusion, target symlinks, and escaping ancestor symlinks, with every accepted target reconstructed and normalized in main inside its known root.
- **TEST-007**: Backup fixtures prove exact unmodified pre-change bytes, completed-backup-before-overwrite/delete/sync-replacement ordering, collision suffixing, exclusion from inventory, no backup for genuinely new files, and fail-closed behavior for backup read/create/write failures.
- **TEST-008**: Atomicity and rollback fixtures prove temporary-file cleanup, create/update/delete Tatsu config ordering, disk restoration after Tatsu config persistence failure, and partial multi-file result reporting.
- **TEST-009**: Conversion fixtures prove the exact `alias | existing | draft` discriminator contract: Claude aliases return `{ status: 'alias', ref }` with the existing stable ref, independent collisions return `{ status: 'existing', ref }`, drafts perform no write until confirmed direct create, and no result creates a conversion plan.
- **TEST-010**: `npx vitest run src/main/harness-config/harness-config.test.ts`, `pnpm typecheck`, and `pnpm build` all exit successfully.

## 7. Risks & Assumptions

- **RISK-001**: Harness vendors can change or deprecate resolver conventions. The closed resolver table localizes updates, while unknown layouts remain unsupported instead of falling back to guessed paths.
- **RISK-002**: Multi-file sync to disk cannot be fully transactional across filesystem errors. Full preflight, deterministic ordering, per-file backups, fail-stop behavior, structured applied-operation results, and mandatory rescan limit and expose partial application.
- **RISK-003**: A path can become a symlink after validation. Revalidation immediately before each filesystem call narrows the race, but Node's path-based APIs cannot eliminate every local TOCTOU race.
- **RISK-004**: Tatsu config persistence can fail after a direct disk mutation. Explicit byte-for-byte rollback restores the target, but rollback itself may fail and must be logged as a separate recovery error.
- **RISK-005**: Modeling Claude skills in both views can cause duplicate Tatsu config records or double writes if later slices or persistence discard canonical identity fields. DEP-007 and DEP-008 require downstream models to preserve them.
- **RISK-006**: A harness/resource capability may remain unsupported until its exact resolver convention is verified. Capability metadata must show it as disabled rather than redirect it to an assumed directory.
- **ASSUMPTION-001**: Each supported `${agentKind}:${resourceType}` pair has exactly one verified known root in the first implementation; adding another root requires a separately authorized scope contract.
- **ASSUMPTION-002**: A resolver manages only the entrypoints explicitly declared in its verified descriptor; nested assets remain outside mutation unless that descriptor explicitly includes them.
- **ASSUMPTION-003**: A Create click is the explicit confirmation for a prepared non-destructive create; update, delete, sync to disk, and adopt from disk UI flows present their prepared plan before calling apply. Conversion remains prepare-only; a draft uses the direct-create flow.
- **ASSUMPTION-004**: The eventual Step 5 persistence adapter can replace one canonical Tatsu config scope atomically from the service's perspective or throw before reporting success.
- **ASSUMPTION-005**: Plugin provenance may annotate an inventoried resource but never changes its `agents | skills | commands` type, authorizes a plugin payload, or permits automatic cross-harness copying.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 4: Shared state slice](./step-04-shared-state-slice.md)
- [Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)
- [Step 6: Transport request handlers](./step-06-transport-request-handlers.md)
- [Step 11: Tests](./step-11-tests.md)
- [Step 14: Acceptance criteria](./step-14-acceptance-criteria.md)
- [Node.js path API](https://nodejs.org/api/path.html)
- [Node.js filesystem API](https://nodejs.org/api/fs.html)
- [Node.js crypto API](https://nodejs.org/api/crypto.html)
