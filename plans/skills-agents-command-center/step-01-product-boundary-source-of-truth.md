---
goal: Define the skills, agents, and commands sync product boundary and source-of-truth contract
date_created: 2026-09-24
last_updated: 2026-09-24
status: 'Planned'
tags: [feature, architecture, product-boundary, harness-config]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan establishes the binding product contract for Tatsu's skills, agent definitions, and commands management feature before runtime implementation begins. It turns the product boundary in [implementation-details.md](./implementation-details.md) into deterministic terminology, source-of-truth rules, mutation safeguards, and downstream acceptance criteria. This step is documentation-only and is the first part of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md); completing it does not complete the feature.

## 1. Requirements & Constraints

- **REQ-001**: The first implementation MUST expose exactly three logical resource types: `agents`, `skills`, and `commands`.
- **REQ-002**: `agents` MUST represent harness-facing instruction or agent-definition files, including resolver-recognized `AGENTS.md`, `CLAUDE.md`, and harness-specific equivalents.
- **REQ-003**: `skills` MUST represent resolver-recognized reusable skill files or packages that a harness can load. This boundary does not prescribe a filesystem layout; each harness resolver owns that mapping.
- **REQ-004**: `commands` MUST represent resolver-recognized slash-command or prompt-command files for harnesses that support them.
- **REQ-005**: The initial managed harness scope MUST be `claude`, `codex`, and `opencode`. `pi` exists in the current `AgentKind` union but is outside this feature's first implementation until its resource capabilities and filesystem conventions are specified.
- **REQ-006**: Unsupported harness/resource combinations MUST remain visible as unsupported capability states with an explanation; the implementation MUST NOT guess a path or silently treat the combination as supported.
- **REQ-007**: Disk inventory MUST mean the files currently discovered by a harness-specific resolver inside known configuration roots.
- **REQ-008**: Tatsu config MUST mean the persisted desired managed state, not a cache of the latest disk scan.
- **REQ-009**: `Sync to disk` MUST generate and, only after confirmation, apply a plan that makes the selected disk scope match Tatsu's desired config.
- **REQ-010**: `Adopt from disk` MUST generate and, only after confirmation, apply a plan that replaces the selected portion of Tatsu's desired config with the current disk inventory.
- **REQ-011**: Every comparison and mutation MUST be scoped by both `agentKind` and `resourceType`. No first-version action may implicitly mutate every harness or every resource type.
- **REQ-012**: When disk inventory and Tatsu config differ, Tatsu MUST show a conflict modal containing the disk-only, config-only, and changed resources before any sync or adopt mutation.
- **REQ-013**: The conflict modal MUST offer exactly three outcomes: `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel`.
- **REQ-014**: Read-only discovery and comparison MAY run automatically, but no create, update, delete, sync, adopt, or plugin setup operation may run without an explicit user action that confirms that specific mutation.
- **REQ-015**: Opening or dismissing a conflict modal MUST NOT mutate disk or Tatsu config. A request that lacks a previously generated, still-current confirmed plan MUST be rejected rather than applied.
- **REQ-016**: Existing files MUST be backed up before destructive disk writes, including overwrite, delete, and sync-to-disk replacement. New-file creation does not require a backup when no prior file exists.
- **REQ-017**: Claude skill and command views MUST model synonymy as aliases of the same underlying resource where Claude exposes one file through both concepts. Conversion MUST return the existing resource reference and MUST NOT create a duplicate file.
- **REQ-018**: Plugin-provided resources MAY be inventoried for their originating harness, but plugins are not a fourth managed resource type and MUST NOT be copied, installed, or translated across harnesses automatically.
- **SEC-001**: Destructive writes MUST preserve the complete pre-change file in a dated backup before replacing or deleting the original. Failure to create the backup MUST abort the destructive write.
- **SEC-002**: All later filesystem implementations MUST restrict writes to main-process-resolved, normalized paths inside known harness configuration roots; renderer input MUST NOT supply trusted absolute paths.
- **CON-001**: This step MUST define product semantics only. Exact per-version directories, filenames, nested asset support, and resolver behavior belong to Steps 2 and 3 and MUST NOT be guessed here.
- **CON-002**: Runtime source files under `src/` MUST remain unchanged while executing this product-boundary step.
- **CON-003**: Existing unmanaged user files MUST remain unmanaged until the user explicitly adopts them or confirms a direct mutation.
- **GUD-001**: Use the terms `disk inventory`, `Tatsu config`, `sync to disk`, `adopt from disk`, `conflict`, and `confirmed plan` consistently in every downstream plan and UI contract.
- **GUD-002**: Present the originating harness and logical resource type on every conflict entry so users can identify the exact mutation scope.
- **PAT-001**: Later implementation MUST preserve the repository's main-owned shared-state pattern: the main process performs filesystem and persistence work, while renderer clients request plans and render store-backed results.

## 2. Implementation Steps

### Implementation Phase 1: Canonicalize resource scope

- **GOAL-001**: Establish one authoritative resource and harness boundary that every later step references.

- [ ] **TASK-001**: Update `plans/skills-agents-command-center/implementation-details.md` so its Product Boundary section declares the canonical `agents | skills | commands` logical resource set and uses the definitions in REQ-002 through REQ-004.
  - State that resource types are logical categories; filesystem layouts and support are selected by per-harness resolvers.
  - Preserve the existing user-facing labels `Agents`, `Skills`, and `Commands`.
- [ ] **TASK-002**: Record the first-version harness matrix in `plans/skills-agents-command-center/implementation-details.md`.
  - Mark `claude`, `codex`, and `opencode` as the managed harness scope.
  - Mark `pi` as explicitly deferred rather than unsupported forever.
  - Require unsupported or unknown resource combinations to remain visible and disabled instead of being omitted or assigned guessed paths.
- [ ] **TASK-003**: Separate plugin inventory from managed resource semantics in `plans/skills-agents-command-center/implementation-details.md`.
  - Allow the UI to identify plugin-provided resources under the originating harness.
  - State that plugin installation, conversion, and cross-harness copying are outside the first implementation.

### Implementation Phase 2: Fix source-of-truth semantics

- **GOAL-002**: Make every synchronization direction, scope, and confirmation boundary deterministic before persistence or transport APIs are designed.

- [ ] **TASK-004**: Add a source-of-truth operation matrix to `plans/skills-agents-command-center/implementation-details.md` with the following exact behavior:

  | Operation | Reads | Writes | Required user gate |
  |---|---|---|---|
  | Scan | Known harness roots | Nothing | None |
  | Compare | Disk inventory and Tatsu config | Nothing | None |
  | Sync to disk | Confirmed Tatsu config snapshot | Selected harness directory | Confirmed current sync plan |
  | Adopt from disk | Confirmed disk inventory snapshot | Selected Tatsu config scope | Confirmed current adopt plan |
  | Direct create | User draft and target capability | One new resource | Explicit Create action |
  | Direct update | User draft and current resource | Backup plus one existing resource | Explicit Save confirmation |
  | Direct delete | Current resource | Backup plus removal of one existing resource | Explicit Delete confirmation |

- [ ] **TASK-005**: Define conflict behavior in `plans/skills-agents-command-center/implementation-details.md` and `plans/skills-agents-command-center/step-09-sync-conflict-ux.md`.
  - Key each plan by `${agentKind}:${resourceType}`.
  - Require the modal to display disk-only, config-only, and content-changed entries before presenting the three outcomes in REQ-013.
  - Invalidate a displayed plan when a new scan changes either side; applying a stale plan must require regeneration and reconfirmation.
  - Define `Cancel` and modal dismissal as no-op outcomes.
- [ ] **TASK-006**: Propagate the canonical mutation rules into the service, persistence, transport, and acceptance plans.
  - Update `step-02-main-process-harness-config-service.md` to separate plan generation from confirmed application.
  - Update `step-05-persist-tatsu-managed-config.md` so persisted desired state is distinct from disk inventory.
  - Update `step-06-transport-request-handlers.md` so mutating requests accept a confirmed scoped plan or a direct confirmed action rather than arbitrary paths.
  - Update `step-14-acceptance-criteria.md` so every mutation direction and no-op cancellation behavior is testable.

### Implementation Phase 3: Lock caveats and safety gates

- **GOAL-003**: Encode aliasing, portability, and backup rules so later phases cannot introduce duplicate resources or destructive unconfirmed writes.

- [ ] **TASK-007**: Define Claude skill/command alias behavior in `plans/skills-agents-command-center/implementation-details.md`, `step-03-harness-capability-metadata.md`, and `step-10-skill-command-conversion.md`.
  - One physical Claude resource may appear in both logical views.
  - Both views must resolve to the same stable resource identity and underlying path.
  - Create-skill/create-command conversion must return that identity when the alias already exists.
- [ ] **TASK-008**: Define the backup invariant in `plans/skills-agents-command-center/implementation-details.md`, `step-02-main-process-harness-config-service.md`, and `step-14-acceptance-criteria.md`.
  - Create a dated backup from the unmodified bytes before overwrite or delete.
  - Abort the original mutation if backup creation fails.
  - Exclude brand-new files from backup creation only when the target does not already exist.
- [ ] **TASK-009**: Reconcile `plans/skills-agents-command-center/step-15-open-questions.md` with this boundary.
  - Remove the already-decided sync-scope question.
  - Keep exact harness directory conventions, repo-local versus global discovery roots, and nested skill asset support open for their owning resolver steps.
  - State that none of those resolver questions may weaken the confirmation, backup, alias, or no-cross-harness-copy invariants established here.

## 3. Alternatives

- **ALT-001**: Treat disk as the only source of truth and use Tatsu solely as a file editor. Rejected because it cannot represent desired resources that are temporarily missing from disk and cannot provide a deterministic sync-to-disk direction.
- **ALT-002**: Treat Tatsu config as authoritative and automatically overwrite drift on scan. Rejected because it can destroy existing user-authored harness configuration without informed consent.
- **ALT-003**: Provide one global sync action across all harnesses and resource types. Rejected for the first implementation because the blast radius is too large and plugin/capability differences make a single confirmation ambiguous.
- **ALT-004**: Convert plugin and resource formats between harnesses automatically. Rejected because plugin schemas and runtime assumptions are not portable across vendors.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) is the canonical feature specification that this step must update and every later step must reference.
- **DEP-002**: `src/shared/state/terminals/types.ts` currently defines `AgentKind` as `claude | codex | opencode | pi`; the first-version scope decision in REQ-005 must remain explicit wherever this union is consumed.
- **DEP-003**: `src/shared/agent-registry/agent-registry.ts` currently registers all four agent kinds but does not yet contain harness-config capability metadata; Step 3 owns that addition.
- **DEP-004**: `src/main/persistence/types.ts` currently has no persisted desired harness-config field; Step 5 owns the schema addition after this contract is accepted.
- **DEP-005**: Steps 2 through 14 depend on the terminology and invariants declared by this step and must not redefine synchronization direction or confirmation semantics.

## 5. Files

- **FILE-001**: `plans/skills-agents-command-center/step-01-product-boundary-source-of-truth.md` — executable plan and binding decisions for this step.
- **FILE-002**: `plans/skills-agents-command-center/implementation-details.md` — canonical feature boundary, source-of-truth operation matrix, caveats, and safety rules.
- **FILE-003**: `plans/skills-agents-command-center/step-02-main-process-harness-config-service.md` — downstream service invariants for scoped plan generation, backup, and confirmed application.
- **FILE-004**: `plans/skills-agents-command-center/step-03-harness-capability-metadata.md` — downstream alias and supported/unknown capability rules.
- **FILE-005**: `plans/skills-agents-command-center/step-05-persist-tatsu-managed-config.md` — downstream desired-state persistence semantics.
- **FILE-006**: `plans/skills-agents-command-center/step-06-transport-request-handlers.md` — downstream confirmation and mutation request contract.
- **FILE-007**: `plans/skills-agents-command-center/step-09-sync-conflict-ux.md` — downstream conflict presentation and no-op cancellation behavior.
- **FILE-008**: `plans/skills-agents-command-center/step-10-skill-command-conversion.md` — downstream Claude alias conversion behavior.
- **FILE-009**: `plans/skills-agents-command-center/step-14-acceptance-criteria.md` — end-to-end observable boundary and safety criteria.
- **FILE-010**: `plans/skills-agents-command-center/step-15-open-questions.md` — unresolved resolver questions after product decisions are removed.
- **FILE-011**: `src/shared/state/terminals/types.ts` — read-only reference for the current `AgentKind` union; no change in this step.
- **FILE-012**: `src/shared/agent-registry/agent-registry.ts` — read-only reference for registered harnesses; no change in this step.
- **FILE-013**: `src/main/persistence/types.ts` — read-only reference proving desired harness config is not implemented yet; no change in this step.

## 6. Testing

- **TEST-001**: Review every declaration of the managed resource union in the plan set and verify it is exactly `agents | skills | commands`; plugin MUST NOT appear as a fourth resource type.
- **TEST-002**: Review every sync/adopt description and verify the direction is consistent: sync writes Tatsu config to disk, while adopt writes disk inventory to Tatsu config.
- **TEST-003**: Verify each mutating flow in the operation matrix has an explicit user gate, each destructive disk flow requires backup-before-write, and scan/compare remain read-only.
- **TEST-004**: Verify downstream plans preserve `${agentKind}:${resourceType}` scoping, Claude alias identity, stale-plan rejection, cancellation as a no-op, and the prohibition on automatic cross-harness plugin copying.
- **TEST-005**: Run Markdown link validation for all relative links in FILE-001 through FILE-010 and confirm every target exists.
- **TEST-006**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL rows and duplicate bullet-style declaration identifiers MUST both produce zero results.
- **TEST-007**: Do not run TypeScript tests, `pnpm typecheck`, or `pnpm build` for this documentation-only step because CON-002 prohibits runtime source changes.

## 7. Risks & Assumptions

- **RISK-001**: The phrase "every supported harness" can be misread to include `pi` because the repository supports Pi terminals. REQ-005 resolves the first-version feature scope without removing Pi from the application.
- **RISK-002**: A physical Claude resource shown in both Skills and Commands can be counted or written twice unless later models use one stable identity with two logical views.
- **RISK-003**: A plan can become stale between comparison and confirmation. TASK-005 requires stale-plan invalidation before this can cause an overwrite based on obsolete inputs.
- **RISK-004**: Backup creation can fail because of permissions, storage, or naming collisions. SEC-001 requires fail-closed behavior so the original file remains untouched.
- **RISK-005**: Version-specific harness directories can drift. CON-001 prevents this boundary step from hard-coding unverified paths and delegates detection to explicit resolvers.
- **ASSUMPTION-001**: The feature's first implementation intentionally supports only Claude, Codex, and Opencode configuration management even though Tatsu also launches Pi.
- **ASSUMPTION-002**: A user click on Create is sufficient confirmation for a non-destructive new-file write; Save over an existing file and Delete require an explicit confirmation action that can be represented and audited independently.
- **ASSUMPTION-003**: Tatsu's persisted desired config may store enough resource content to recreate a missing managed file; the exact schema remains owned by Step 5.
- **ASSUMPTION-004**: Exact repo-local/global roots and nested skill asset support remain resolver decisions and do not alter this step's logical resource taxonomy.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)
- [Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)
- [Step 14: Acceptance criteria](./step-14-acceptance-criteria.md)
