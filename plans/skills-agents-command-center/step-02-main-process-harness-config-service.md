---
goal: Implement a safe main-process service for harness configuration discovery, drift planning, and confirmed mutation
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, architecture, filesystem, harness-config, security]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan adds the main-process package that discovers and manages harness-facing agent definitions, skills, and commands for Claude Code, Codex, and OpenCode. It converts the product contract in [implementation-details.md](./implementation-details.md) and [Step 1](./step-01-product-boundary-source-of-truth.md) into a testable filesystem boundary: scans and comparisons are read-only, every plan is scoped by harness and resource type, and disk or persisted-state mutation occurs only by applying a current user-confirmed plan. This is Step 2 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md); transport, shared state, persistence wiring, and UI remain later steps.

## 1. Requirements & Constraints

- **REQ-001**: Create `src/main/harness-config/` with exactly `index.ts`, `harness-config.ts`, `types.ts`, and `harness-config.test.ts`; the barrel MUST be the public import surface.
- **REQ-002**: The service MUST expose the logical resource union `HarnessConfigResourceType = 'agents' | 'skills' | 'commands'` and MUST accept only the first-version managed harness union `ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>`. `pi` MUST be rejected as unsupported, not normalized to another harness.
- **REQ-003**: Every scan, comparison, plan, and apply operation MUST carry a required scope `{ agentKind, resourceType }`. `agentKind` MUST NOT be optional on `HarnessConfigSyncPlan`, and no operation may default to all harnesses.
- **REQ-004**: The first version MUST manage user-global configuration only. Repository-local `.claude/`, `.codex/`, `.opencode/`, `AGENTS.md`, and `CLAUDE.md` files are outside this step because the current request surface has no explicit repository scope. Adding them later requires a separate root descriptor and confirmation scope.
- **REQ-005**: Root resolution MUST occur in main from a non-empty harness override when present, otherwise from `os.homedir()`: Claude uses `CLAUDE_CONFIG_DIR` or `~/.claude`; Codex uses `CODEX_HOME` or `~/.codex`; OpenCode uses `OPENCODE_CONFIG_DIR` or `~/.config/opencode`. A leading `~` in an override MUST expand against `homedir()` before normalization.
- **REQ-006**: Resolver inventory MUST use these version-one mappings and MUST keep each physical file attached to its originating harness:

  | Harness | Agents | Skills | Commands |
  |---|---|---|---|
  | Claude | `CLAUDE.md` and `agents/**/*.md` | `skills/*/SKILL.md` | `commands/**/*.md`, plus logical aliases for discovered Claude skills |
  | Codex | `AGENTS.md` | `skills/*/SKILL.md` | `prompts/**/*.md` |
  | OpenCode | `agents/**/*.md` | `skills/*/SKILL.md` | `commands/**/*.md` |

- **REQ-007**: Version one MUST manage only the Markdown entrypoint named by REQ-006. Supporting files nested beside a skill `SKILL.md` are neither inventoried nor deleted; deleting a skill removes only its `SKILL.md` and leaves its containing directory and assets intact.
- **REQ-008**: Discovery MUST be deterministic: exclude symlinks, non-files, backup files ending in `.x-backup-<UTC timestamp>[-<collision>]`, and files outside the resolver pattern; sort results by `agentKind`, `resourceType`, then POSIX-style relative path.
- **REQ-009**: `HarnessConfigFileRef` MUST contain `id`, `agentKind`, current view `resourceType`, `canonicalResourceType`, `aliasResourceTypes`, `label`, root-relative POSIX `relativePath`, normalized `absolutePath`, SHA-256 `hash`, `existsOnDisk`, `managed`, and `updatedAt`. Disk `updatedAt` is `stat.mtimeMs`; config-only entries use the persisted timestamp.
- **REQ-010**: Physical identity MUST be independent of logical view. Generate `id` as the lowercase hexadecimal SHA-256 of `agentKind`, resolver root key, and canonical POSIX relative path separated by NUL bytes. A Claude skill shown in Commands MUST retain the skill's physical `id`, `canonicalResourceType: 'skills'`, and `aliasResourceTypes: ['commands']`.
- **REQ-011**: Hash exact file bytes with SHA-256 and lowercase hexadecimal output. Persisted UTF-8 content MUST be hashed from `Buffer.from(content, 'utf8')`; no newline or Unicode normalization may occur.
- **REQ-012**: The service MUST accept desired Tatsu resources through injected `loadDesiredResources()` and `replaceDesiredScope(scope, resources)` dependencies. It MUST NOT import the whole app `Config`, call `saveConfig`, dispatch store events, or register transport handlers; Steps 4 through 6 own those integrations.
- **REQ-013**: The desired-resource contract in `types.ts` MUST include `id`, `agentKind`, canonical `resourceType`, `aliasResourceTypes`, `relativePath`, `label`, `content`, `hash`, and `updatedAt`. Step 5 MUST persist this contract without maintaining duplicate desired records for Claude skill/command aliases.
- **REQ-014**: `scan(scope)` MUST return disk refs only; `readFile(id)` MUST resolve an ID from a fresh recognized inventory and return UTF-8 content plus the current hash. Neither method may trust a renderer-supplied absolute path.
- **REQ-015**: `planSync(scope)` MUST compare a fresh disk inventory with a fresh desired-state snapshot by physical `id`. It MUST return `diskOnly`, `configOnly`, and `changed` refs and use status `synced` for no differences, `disk-only` for only disk-only entries, `config-only` for only config-only entries, and `conflict` for any changed entry or more than one non-empty difference category.
- **REQ-016**: Public plans MUST include `planId`, required scope, direction (`sync-to-disk` or `adopt-from-disk`), `status`, difference lists, `generatedAt`, and an opaque fingerprint. File content and executable operations MUST remain only in a private in-memory plan record keyed by `planId`.
- **REQ-017**: `planSyncToDisk(scope)` MUST derive create operations for config-only resources, overwrite operations for changed resources, and delete operations for disk-only resources. `planAdoptFromDisk(scope)` MUST derive one desired-scope replacement and MUST never write to harness directories.
- **REQ-018**: Direct create, update, and delete MUST also use prepare/apply separation. `prepareCreate(scope, name, content)`, `prepareUpdate(id, content)`, and `prepareDelete(id)` MUST return a `HarnessConfigMutationPlan`; only `applyPlan({ planId, confirmed: true })` may execute it.
- **REQ-019**: Create input MUST be a logical name, never a path. Resolver-specific derivation MUST allow lowercase ASCII alphanumeric segments separated by single hyphens; command names MAY contain `/`-separated segments. Claude/OpenCode agents become `agents/<name>.md`, Codex agents permit only the fixed `AGENTS.md`, skills become `skills/<name>/SKILL.md`, Claude/OpenCode commands become `commands/<name>.md`, and Codex commands become `prompts/<name>.md`.
- **REQ-020**: Applying a create/update/delete plan MUST update the corresponding desired scope only after the disk mutation succeeds. If desired-state persistence fails, restore overwritten/deleted bytes from the backup or remove a newly created file, then throw a structured error.
- **REQ-021**: Applying `sync-to-disk` MUST leave desired state unchanged. Applying `adopt-from-disk` MUST replace only the exact desired `{ agentKind, resourceType }` scope and MUST leave disk unchanged. Alias canonicalization MUST prevent an adopt of Claude Commands from duplicating desired Claude Skills.
- **REQ-022**: Before apply, recompute both the scoped disk fingerprint and desired-state fingerprint. Reject and consume a plan if either differs from its captured inputs, if `confirmed !== true`, if the plan does not exist, or if it was already attempted. Restarting the process invalidates all plans.
- **REQ-023**: Plan application MUST preflight every operation before the first mutation, execute operations in stable relative-path order, stop on the first failure, consume the plan, and return the successfully applied operations. Because multi-file filesystem writes are not transactional, callers MUST rescan after either success or partial failure.
- **REQ-024**: Creating or overwriting a file MUST call `mkdirSync(parent, { recursive: true })` and use a sibling temporary file plus `renameSync` so readers never observe a partial write. Temporary files MUST be removed on failure.
- **REQ-025**: Before every overwrite or delete, copy the unmodified target bytes to `${absolutePath}.x-backup-${timestamp}`, where `timestamp` is UTC `YYYYMMDDTHHmmssSSSZ`. Use exclusive creation; append `-2`, `-3`, and so on on collision. Abort the original operation if the backup cannot be created. Brand-new targets MUST NOT create a backup.
- **REQ-026**: Existing-file rollback MUST copy the backup bytes rather than regenerate content. Successful backup files MUST remain on disk for user recovery and MUST be excluded from later scans.
- **REQ-027**: `createCommandFromSkill(id)` and `createSkillFromCommand(id)` MUST use the same prepare/apply plan contract. For a Claude skill/command alias they MUST return the existing physical ref without a write; for distinct supported layouts they MUST reject an existing destination and otherwise create one resource only within the same `agentKind`.
- **SEC-001**: Reject empty paths, absolute relative paths, NUL bytes, `.` and `..` segments, platform separator variants, and candidates that do not match the selected resolver's filename pattern.
- **SEC-002**: Lexical containment MUST use normalized `resolve(root)` and `candidate === root || candidate.startsWith(root + sep)`; string-prefix containment without a separator is forbidden.
- **SEC-003**: Symlink escape protection MUST validate `realpathSync` for an existing target or the nearest existing ancestor of a new target against the real root. A symlink target or ancestor that escapes the known root MUST be rejected for read, write, backup, and delete.
- **SEC-004**: The service MUST never accept an absolute target path, persisted absolute path, renderer-selected root, or `toAgentKind()` fallback as authorization. Validate `agentKind` and `resourceType` with exact allowlists.
- **SEC-005**: No operation may copy, translate, or infer a resource across different `agentKind` values. Plugin files and harness settings files are outside all resolver patterns and MUST remain untouched.
- **CON-001**: Use synchronous Node filesystem APIs to match existing main-process configuration services and keep each prepared operation ordered; no new runtime dependency is permitted.
- **CON-002**: Keep live plans and operation content in memory only. Shared-state plans in Step 4 remain lightweight and editor content remains request-scoped.
- **CON-003**: Do not add transport handlers, shared state, renderer methods, persistence fields, migrations, or UI in this step. The service dependency interface is the seam those later steps implement.
- **GUD-001**: Inject `homedir`, environment lookup, clock, UUID generation, desired-state access, and the filesystem adapter through a typed `HarnessConfigServiceDeps`; production defaults wrap Node APIs and tests use real temporary directories plus deterministic clock/ID dependencies.
- **GUD-002**: Public methods MUST catch operational failures, log category `harness-config` through `log()` with `formatErr(err)`, and rethrow `HarnessConfigError` with a stable code and safe message; logs may contain the normalized path, while transport-facing messages MUST NOT expose file content.
- **PAT-001**: Follow the package/barrel convention used by `src/main/fs-listing/`: external imports use `src/main/harness-config`, and the test imports from `.`.
- **PAT-002**: Model resolvers as a closed `Record<ManagedHarnessKind, HarnessResolver>` whose resource descriptors own root keys, discovery patterns, name-to-relative-path conversion, and Claude alias expansion. Do not spread harness-specific conditionals across mutation methods.

## 2. Implementation Steps

### Implementation Phase 1: Define service contracts and resolvers

- **GOAL-001**: Establish one deterministic, main-only domain model for roots, physical identity, aliases, plans, operations, and structured failures.

- [ ] **TASK-001**: Create `src/main/harness-config/types.ts` with the unions, scope, resolver, file-ref, desired-resource, sync-plan, mutation-plan, apply-result, dependency, filesystem-adapter, and `HarnessConfigError` contracts required by REQ-002 through REQ-023.
  - Make `agentKind` required on every scope and plan.
  - Define error codes for unsupported scope, invalid name, unsafe path, unknown resource, unconfirmed plan, unknown plan, stale plan, collision, backup failure, read failure, write failure, delete failure, and desired-state failure.
  - Keep executable plan operations private to the implementation; public plans expose summaries and fingerprints only.
- [ ] **TASK-002**: Add the closed resolver table in `src/main/harness-config/harness-config.ts` using the exact global roots and patterns in REQ-005 through REQ-007.
  - Convert discovered relative paths to `/` separators before identity, sorting, or persistence.
  - Treat `CLAUDE.md` and `AGENTS.md` as fixed singleton agent resources while deriving named agent, skill, and command paths exactly as REQ-019 specifies.
  - Emit Claude skill aliases in the Commands view without duplicating physical IDs or desired records.
- [ ] **TASK-003**: Implement root expansion, exact allowlist validation, logical-name validation, lexical containment, nearest-existing-ancestor realpath containment, backup exclusion, SHA-256 hashing, physical ID generation, and deterministic sort helpers in `harness-config.ts`.
  - Reject symlinks during recursive discovery by using directory-entry/lstat information and never following symbolic-link directories.
  - Keep helpers module-private unless a test must assert a public contract through the service.
- [ ] **TASK-004**: Create `src/main/harness-config/index.ts` and export only the service factory/class plus public types and error contracts from the package barrel.

### Implementation Phase 2: Implement read-only inventory and planning

- **GOAL-002**: Produce current, scoped inventories and immutable drift plans without mutating disk or desired Tatsu config.

- [ ] **TASK-005**: Implement `HarnessConfigService.scan(scope)` and `readFile(id)` in `harness-config.ts`.
  - Recursively enumerate only each resolver's allowed depth and filename pattern, collect `lstat`/`stat` metadata, hash exact bytes, and return deterministic refs.
  - Mark a disk ref `managed` only when the canonical physical ID exists in the freshly loaded desired resources for the same harness and canonical scope.
  - Resolve reads from a fresh recognized inventory and return `{ ref, content, hash }`; reject unknown or newly unsafe IDs.
- [ ] **TASK-006**: Implement scoped disk-versus-desired comparison and the status precedence in REQ-015.
  - Build config-only refs with a resolver-derived safe absolute path and `existsOnDisk: false`.
  - Classify an ID as changed only when both sides exist and their exact SHA-256 hashes differ.
  - Canonicalize Claude aliases before comparison so one physical skill cannot appear simultaneously as disk-only and config-only across views.
- [ ] **TASK-007**: Implement `planSyncToDisk(scope)` and `planAdoptFromDisk(scope)` with private plan records.
  - Capture sorted disk and desired fingerprints, operation snapshots, and exact content needed for apply.
  - Store plans under injected UUIDs; return only the serializable public plan.
  - Generate no operations and preserve `status: 'synced'` when the selected scope already matches.
- [ ] **TASK-008**: Implement `prepareCreate`, `prepareUpdate`, `prepareDelete`, `createCommandFromSkill`, and `createSkillFromCommand` as non-mutating plan generators.
  - Reject destination collisions before storing a plan.
  - For a Claude alias conversion, return a no-op plan whose result is the existing physical ref.
  - Never generate an operation whose source and destination harness differ.

### Implementation Phase 3: Apply confirmed plans safely

- **GOAL-003**: Execute only current confirmed plans with fail-closed backup, path, rollback, and persistence behavior.

- [ ] **TASK-009**: Implement `applyPlan({ planId, confirmed })` with single-use lookup, confirmation enforcement, full stale-plan recomputation, and all-operation preflight before mutation.
  - Consume plans on rejection, stale detection, first apply attempt, success, or failure.
  - Return structured `applied`, `resultingRefs`, and `requiresRescan: true` fields without dispatching store events.
- [ ] **TASK-010**: Implement atomic create/overwrite and guarded delete primitives.
  - Revalidate root and realpath containment immediately before every filesystem call.
  - Create parent directories recursively, create exclusive dated backups before destructive operations, write through a unique sibling temporary file, and rename into place.
  - Stop immediately when backup creation fails; never unlink or overwrite the original afterward.
- [ ] **TASK-011**: Implement direct-mutation desired-state updates and rollback.
  - After a successful disk create/update/delete, replace only the affected canonical desired scope.
  - On desired-state failure, delete a just-created target or restore an overwritten/deleted target from the backup bytes, log both the persistence error and any rollback error, then throw `desired-state-failed`.
  - Leave successful backups in place even after rollback.
- [ ] **TASK-012**: Implement direction-specific application semantics.
  - `sync-to-disk` applies its stable ordered disk operations and never calls `replaceDesiredScope`.
  - `adopt-from-disk` calls `replaceDesiredScope` exactly once and performs zero harness filesystem writes.
  - Conversion plans either return the Claude alias ref without mutation or use the same direct create path and same-harness guard.
- [ ] **TASK-013**: Wrap every public operation with consistent `harness-config` error logging and normalize unexpected Node errors into stable `HarnessConfigError` codes without swallowing the original cause.

### Implementation Phase 4: Prove service contracts

- **GOAL-004**: Verify resolver behavior, drift classification, confirmation gates, path confinement, backup ordering, stale-plan rejection, and rollback using isolated temporary roots.

- [ ] **TASK-014**: Create `src/main/harness-config/harness-config.test.ts` using Vitest, `mkdtempSync`, and `rmSync(..., { recursive: true, force: true })`; import the service from `.` and inject deterministic roots, timestamps, UUIDs, environment, and desired-state callbacks.
- [ ] **TASK-015**: Add resolver and inventory tests for every mapping in REQ-006, global-only scope, deterministic sorting, byte-exact hashes, stable physical IDs, backup exclusion, symlink exclusion, and Claude skill/command alias identity.
- [ ] **TASK-016**: Add comparison and plan-generation tests covering all four statuses, disk-only/config-only/changed lists, same-ID unchanged files, exact `{ agentKind, resourceType }` isolation, canonical alias deduplication, same-harness conversion, collision refusal, and prohibition of cross-harness operations.
- [ ] **TASK-017**: Add mutation safety tests proving unconfirmed/unknown/reused/stale plans perform zero writes; traversal, absolute-path, prefix-sibling, separator-variant, and symlink-ancestor escapes are rejected; and parent directories are created only for a valid confirmed create.
- [ ] **TASK-018**: Add backup and failure-order tests proving overwrite/delete backups contain the exact pre-change bytes, unique collision suffixes are used, a backup failure leaves the original untouched, atomic-write failure removes temporary files, and desired-state failure restores or removes the disk target as required.
- [ ] **TASK-019**: Add direction tests proving sync-to-disk creates/overwrites/deletes only inside the selected harness root, adopt-from-disk performs no harness writes and replaces one desired scope, partial apply reports completed operations and requires rescan, and plugin/settings files remain untouched.
- [ ] **TASK-020**: Run `npx vitest run src/main/harness-config/harness-config.test.ts`, `pnpm typecheck`, and `pnpm build`; resolve every failure without weakening validation or confirmation rules.
- [ ] **TASK-021**: Review downstream Steps 3 through 6 and update only incompatible type assumptions: capability metadata must match the resolver matrix, Step 4 must share the serializable public ref/plan shape without importing main code, Step 5 must persist canonical desired resources, and Step 6 must call prepare/apply rather than direct mutations.
- [ ] **TASK-022**: Commit the service as one focused change with message `feat: add harness config service` and push the current branch immediately after the commit succeeds.

## 3. Alternatives

- **ALT-001**: Let transport handlers accept arbitrary absolute paths and validate them inline. Rejected because duplicated handler checks are easy to bypass and renderer input must never become filesystem authority.
- **ALT-002**: Write immediately from create/update/delete and sync requests after a boolean confirmation. Rejected because it does not produce a reviewable immutable plan, cannot reject stale input, and conflates comparison with mutation.
- **ALT-003**: Store one desired record per logical Claude Skills and Commands row. Rejected because the same physical skill would drift, back up, or overwrite twice and would violate alias identity.
- **ALT-004**: Include project-local roots in the first service. Rejected because safe identity and confirmation would also require an explicit repository/worktree scope that the current feature contracts do not carry.
- **ALT-005**: Follow symlinks after checking normalized strings. Rejected because an in-root symlink can escape to arbitrary user files despite lexical containment.
- **ALT-006**: Add a generic filesystem abstraction package or external glob library. Rejected because the resolver set is small, Node APIs are sufficient, and a feature-local injected adapter is easier to audit and test.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk-versus-Tatsu source-of-truth model, conflict requirement, Claude caveat, and backup requirement.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the first-version harness boundary, confirmation semantics, stale-plan rule, scoped sync, no-cross-harness rule, and backup invariant consumed by this service.
- **DEP-003**: `src/shared/state/terminals/types.ts` owns `AgentKind = 'claude' | 'codex' | 'opencode' | 'pi'`; the service narrows this union explicitly and does not use `src/main/agent-kind/toAgentKind()` because its unknown-to-Claude fallback is unsafe at this boundary.
- **DEP-004**: `src/main/debug/` provides `log()` and `formatErr()` for operational failures.
- **DEP-005**: Node built-ins `fs`, `path`, `os`, and `crypto` provide discovery, confinement, backup, atomic replacement, root resolution, SHA-256, and UUID functionality; no package dependency is added.
- **DEP-006**: Step 3 must expose capability metadata consistent with REQ-006, but the main resolver remains authoritative for absolute roots and paths.
- **DEP-007**: Step 4 must place the serializable public `HarnessConfigFileRef` and plan contracts in a shared package or define a structurally identical shared wire model; shared code MUST NOT import this main package.
- **DEP-008**: Step 5 must implement the desired-resource dependency from REQ-012 with persisted canonical resources and migration/default behavior.
- **DEP-009**: Step 6 must instantiate the service after loading config, register prepare/read/scan/apply request handlers, dispatch state only after side effects, and map structured service errors for clients.

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

- **TEST-001**: Resolver inventory fixtures prove exact Claude, Codex, and OpenCode global layouts, deterministic ordering, backup/symlink exclusion, and no project-local traversal.
- **TEST-002**: Hash and identity fixtures prove byte-exact SHA-256, POSIX path canonicalization, stable physical IDs, and shared Claude alias identity.
- **TEST-003**: Drift fixtures prove `synced`, `disk-only`, `config-only`, and `conflict` precedence plus strict harness/resource scoping.
- **TEST-004**: Plan fixtures prove sync/adopt operation direction, opaque in-memory content, canonical alias deduplication, collision refusal, and no automatic cross-harness copying.
- **TEST-005**: Confirmation fixtures prove false, unknown, stale, reused, and process-lost plan IDs cannot mutate disk or desired state.
- **TEST-006**: Path-security fixtures prove rejection of `..`, absolute paths, NULs, mixed separators, sibling-prefix confusion, target symlinks, and escaping ancestor symlinks.
- **TEST-007**: Backup fixtures prove exact pre-change bytes, backup-before-overwrite/delete ordering, collision suffixing, exclusion from inventory, and fail-closed behavior.
- **TEST-008**: Atomicity and rollback fixtures prove temporary-file cleanup, create/update/delete desired-state ordering, disk restoration after persistence failure, and partial multi-file result reporting.
- **TEST-009**: Conversion fixtures prove Claude aliases return an existing ref without writes and distinct same-harness conversions are idempotent and never overwrite a destination.
- **TEST-010**: `npx vitest run src/main/harness-config/harness-config.test.ts`, `pnpm typecheck`, and `pnpm build` all exit successfully.

## 7. Risks & Assumptions

- **RISK-001**: Harness vendors can change or deprecate global layouts. The closed resolver table localizes updates, while unknown layouts remain unsupported instead of falling back to guessed paths.
- **RISK-002**: Multi-file sync cannot be fully transactional across filesystem errors. Full preflight, deterministic ordering, per-file backups, fail-stop behavior, structured applied-operation results, and mandatory rescan limit and expose partial application.
- **RISK-003**: A path can become a symlink after validation. Revalidation immediately before each filesystem call narrows the race, but Node's path-based APIs cannot eliminate every local TOCTOU race.
- **RISK-004**: Desired-state persistence can fail after a direct disk mutation. Explicit byte-for-byte rollback restores the target, but rollback itself may fail and must be logged as a separate recovery error.
- **RISK-005**: Modeling Claude skills in both views can cause duplicate desired records or double writes if later slices/persistence discard canonical identity fields. DEP-007 and DEP-008 require downstream models to preserve them.
- **RISK-006**: Codex prompt-directory support may change independently from skills. Capability metadata must disable an unavailable resource type rather than redirect it to an unverified directory.
- **ASSUMPTION-001**: Version one intentionally manages only user-global resources; project-local configuration will be a separately scoped extension.
- **ASSUMPTION-002**: Managed files are UTF-8 Markdown entrypoints. Binary files and nested skill assets are outside the first-version editor and sync contract.
- **ASSUMPTION-003**: A Create click is the explicit confirmation for a prepared non-destructive create; update, delete, sync, adopt, and conversion UI flows present their prepared plan before calling apply.
- **ASSUMPTION-004**: The eventual Step 5 persistence adapter can replace one canonical desired scope atomically from the service's perspective or throw before reporting success.
- **ASSUMPTION-005**: Existing vendor config, plugin, hook, and settings files that do not match REQ-006 remain unmanaged and untouched.

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
