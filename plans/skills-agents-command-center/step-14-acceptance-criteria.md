---
goal: Define end-to-end observable acceptance criteria for the skills, agents, and commands sync boundary
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, acceptance-criteria, product-boundary, harness-config]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan defines the end-to-end acceptance contract for Tatsu's skills, agents, and commands management feature. It restates the binding product boundary from [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md) and the canonical terms and operation matrix in [implementation-details.md](./implementation-details.md) as observable, testable criteria: every mutation direction, every user gate, and every safety invariant must be verifiable against file-system effects, config effects, and UI states. Requirement identifiers here mirror the canonical identifiers declared in Step 1; this plan declares no new requirement semantics and MUST NOT redefine synchronization direction or confirmation semantics (DEP-005). Test implementation details are owned by [step-11-tests.md](./step-11-tests.md); this plan stays at the acceptance-contract level.

## 1. Requirements & Constraints

Identifiers below are declared once here and mirror Step 1's canonical declarations; each row states the observable outcome that proves the canonical term in [implementation-details.md](./implementation-details.md).

- **REQ-001**: The managed resource union MUST be observable as exactly `agents | skills | commands`. Any scan, compare, plan, or mutation surface that exposes a fourth resource type (including plugins) is a failure (Step 1 REQ-001).
- **REQ-002**: `agents` inventory MUST be observable as resolver-recognized harness-facing instruction or agent-definition files, including `AGENTS.md`, `CLAUDE.md`, and harness-specific equivalents (Step 1 REQ-002).
- **REQ-003**: `skills` inventory MUST be observable as resolver-recognized reusable skill files or packages for the originating harness; the resolver owns the filesystem mapping, and the acceptance check is that only resolver-recognized entries appear (Step 1 REQ-003).
- **REQ-004**: `commands` inventory MUST be observable as resolver-recognized slash-command or prompt-command files for harnesses that support them (Step 1 REQ-004).
- **REQ-005**: The managed harness scope MUST be observable as `claude`, `codex`, and `opencode` only. `pi` MUST be presented as explicitly deferred, not supported and not unsupported-forever (Step 1 REQ-005).
- **REQ-006**: Every unsupported harness/resource combination MUST be observable as a visible, disabled capability state with an explanation. No guessed path may appear, and no unsupported combination may be silently omitted or treated as supported (Step 1 REQ-006).
- **REQ-007**: Disk inventory MUST be observable as exactly the files a harness-specific resolver discovers inside known configuration roots at scan time — an observation, never desired state (GUD-001).
- **REQ-008**: Tatsu config MUST be observable as persisted desired managed state. A disk scan that changes inventory MUST NOT change Tatsu config; a rescan must not mutate the persisted desired set as a side effect (GUD-001).
- **REQ-009**: Sync to disk MUST be observable as: generate a plan that captures a Tatsu config snapshot, present that plan for confirmation, and only after confirmation write that snapshot to the selected `${agentKind}:${resourceType}` disk scope in the selected harness directory. Before confirmation there MUST be zero disk writes; after application Tatsu config and every non-selected disk scope MUST remain byte-identical (Step 1 REQ-009).
- **REQ-010**: Adopt from disk MUST be observable as: generate a plan that captures a disk inventory snapshot, present that plan for confirmation, and only after confirmation write that snapshot to the selected `${agentKind}:${resourceType}` Tatsu config scope. Before confirmation there MUST be zero config changes; after application the disk inventory and every non-selected Tatsu config scope MUST remain byte-identical (Step 1 REQ-010).
- **REQ-011**: Every comparison, plan, and mutation MUST be scoped by both `agentKind` and `resourceType`, keyed `${agentKind}:${resourceType}`. The displayed scope and resulting effects MUST agree. No action may observably mutate more than the selected scope: confirming a `claude:skills` plan MUST leave every other harness/resource scope byte-identical on disk and in Tatsu config (Step 1 REQ-011).
- **REQ-012**: When disk inventory and Tatsu config differ for a scope, a conflict modal MUST be observable before any sync to disk or adopt from disk mutation can run. Its comparison MUST distinguish and display disk-only, config-only, and content-changed entries for the selected `${agentKind}:${resourceType}` scope (Step 1 REQ-012).
- **REQ-013**: The conflict modal MUST offer exactly three outcomes: `Sync Tatsu config to disk` applies a confirmed plan only to the selected disk scope; `Adopt current disk files into Tatsu config` applies a confirmed plan only to the selected Tatsu config scope; and `Cancel` is a no-op. Each entry MUST show the originating harness and logical resource type (Step 1 REQ-013, GUD-002).
- **REQ-014**: Scan and compare MUST be observable as read-only: they MAY run automatically; scan reads known harness roots into disk inventory, compare reads disk inventory and Tatsu config, and both produce zero disk writes and zero config changes. Direct create MUST require an explicit Create action; direct update MUST require an explicit Save confirmation; direct delete MUST require an explicit Delete confirmation; sync to disk and adopt from disk MUST each require confirmation of their specific still-current plan. No plugin setup mutation may run without an explicit user action confirming that specific mutation (Step 1 REQ-014).
- **REQ-015**: Opening, dismissing, or choosing `Cancel` in a conflict modal MUST be observable as a no-op: disk inventory and Tatsu config are byte-identical before and after. A mutation request with an absent confirmed plan, or with a plan made stale by a newer disk inventory or Tatsu config state, MUST be rejected with zero disk writes and zero config changes and MUST require regeneration and reconfirmation (Step 1 REQ-015).
- **REQ-016**: Before every destructive disk write to an existing file, including overwrite, delete, and sync-to-disk replacement, a dated backup MUST first be created from the original bytes. The destructive write MUST begin only after backup success. Brand-new files MUST skip backup creation only when the target does not already exist (Step 1 REQ-016).
- **REQ-017**: A physical Claude resource exposed through both Skills and Commands MUST be observable as two aliases of one stable resource identity and one physical path. Create-skill/create-command conversion on an existing alias MUST reuse and return that existing identity and MUST NOT create a duplicate disk file or Tatsu config entry (Step 1 REQ-017).
- **REQ-018**: Plugin information MUST be observable only as provenance metadata on resources inventoried under their originating harness. Plugins MUST NOT appear as a fourth resource type or independent managed payload, and no action may automatically copy, install, translate, or include plugin payloads in a cross-harness operation (Step 1 REQ-018).
- **SEC-001**: Backup failure MUST be observable as an aborted destructive write: if the dated backup cannot be created (permissions, storage, naming collisions), the original file MUST remain byte-identical and no mutation is reported as successful (Step 1 SEC-001).
- **SEC-002**: All disk writes MUST resolve inside main-process-resolved, normalized paths within known harness configuration roots. Renderer-supplied absolute paths MUST NOT be trusted; an out-of-root write request MUST be rejected without filesystem effect (Step 1 SEC-002).
- **CON-001**: Per-harness directory conventions, filename layouts, and nested asset support are resolver decisions owned by Steps 2 and 3; acceptance criteria here MUST NOT assert specific paths beyond known configuration roots (Step 1 CON-001).
- **CON-002**: Executing this step is documentation-only; nothing under `src/` may change while authoring this plan (Step 1 CON-002).
- **CON-003**: Existing unmanaged user files MUST remain unmanaged until the user explicitly adopts them or confirms a direct mutation. A scan over unmanaged files MUST NOT create, edit, or delete anything (Step 1 CON-003).
- **GUD-001**: Acceptance criteria MUST use the canonical terminology consistently: `disk inventory`, `Tatsu config`, `sync to disk`, `adopt from disk`, `conflict`, and `confirmed plan` (Step 1 GUD-001).
- **GUD-002**: Every conflict entry and every scoped mutation result MUST identify the originating harness and logical resource type (Step 1 GUD-002).
- **PAT-001**: Acceptance of mutation flows MUST be observable through the main-owned shared-state pattern: the main process performs filesystem and persistence work, renderer clients request plans and render store-backed results. A renderer-only side effect that bypasses the store is a failure (Step 1 PAT-001).

## 2. Implementation Steps

### Implementation Phase 1: Verify mutating flows and their gates

- **GOAL-001**: Prove every mutation direction from the operation matrix is executable and gated exactly as specified, while scan/compare stay read-only.

- [ ] **TASK-001**: Verify sync to disk end to end for a `${agentKind}:${resourceType}` scope.
  - Generate a plan that captures the selected Tatsu config snapshot; before confirmation, observe zero disk writes and zero Tatsu config changes.
  - Confirm that specific plan; observe its captured Tatsu config snapshot written to the selected harness directory and only the selected disk scope changed.
  - Observe Tatsu config and all non-selected disk scopes remain byte-identical; repeat with a second scope to prove scope isolation (REQ-009, REQ-011).
- [ ] **TASK-002**: Verify adopt from disk end to end for a `${agentKind}:${resourceType}` scope.
  - Generate a plan that captures the selected disk inventory snapshot; before confirmation, observe zero disk writes and zero Tatsu config changes.
  - Confirm that specific plan; observe its captured disk inventory snapshot written to only the selected Tatsu config scope.
  - Observe disk inventory and all non-selected Tatsu config scopes remain byte-identical (REQ-010, REQ-011).
- [ ] **TASK-003**: Verify direct mutations carry their explicit gates per the operation matrix.
  - Direct create: observe exactly one new target resource only after the explicit Create action; without that action, observe zero disk writes and zero config changes (REQ-014).
  - Direct update: observe the target resource change only after an explicit Save confirmation and only after a dated backup captures the prior bytes; without that confirmation, observe zero disk writes and zero config changes (REQ-014, REQ-016).
  - Direct delete: observe the target resource disappear only after an explicit Delete confirmation and only after a dated backup captures the prior bytes; without that confirmation, observe zero disk writes and zero config changes (REQ-014, REQ-016).
  - For every direct mutation, observe all non-target `${agentKind}:${resourceType}` scopes remain byte-identical (REQ-011).
- [ ] **TASK-004**: Verify scan and compare are read-only.
  - Run scan over known harness roots and observe it reads discovered files into disk inventory while producing zero disk writes and zero Tatsu config changes.
  - Run compare over disk inventory and Tatsu config and observe it classifies disk-only, config-only, and content-changed entries while producing zero disk writes and zero Tatsu config changes.
  - Include unmanaged user files and observe those files remain byte-identical (REQ-014, CON-003).

### Implementation Phase 2: Verify plan currency, cancellation, and backup safety

- **GOAL-002**: Prove stale plans cannot mutate, cancellation mutates nothing, and backups protect every destructive write.

- [ ] **TASK-005**: Verify stale-plan and absent-plan rejection.
  - Generate a sync to disk plan, externally change its source or target state, and rescan; attempt to apply the formerly confirmed plan and observe rejection with zero disk writes and zero config changes.
  - Generate an adopt from disk plan, change disk inventory or Tatsu config so its snapshot is no longer current, and attempt to apply the formerly confirmed plan; observe the same rejection.
  - Attempt sync to disk and adopt from disk with no confirmed plan at all; observe rejection with zero disk writes and zero config changes.
  - In every rejection, observe a regeneration-and-reconfirmation requirement surfaced to the user (REQ-015).
- [ ] **TASK-006**: Verify exact conflict outcomes and no-ops.
  - Create a conflict for one `${agentKind}:${resourceType}` scope and observe separate disk-only, config-only, and content-changed entries, each labeled with its originating harness and logical resource type (REQ-012, REQ-013, GUD-002).
  - Observe exactly these three outcomes and no fourth path: `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel` (REQ-013).
  - Choose `Sync Tatsu config to disk`, confirm its plan, and observe only the selected disk scope receives the captured Tatsu config snapshot; choose `Adopt current disk files into Tatsu config`, confirm its plan, and observe only the selected Tatsu config scope receives the captured disk inventory snapshot.
  - Open and dismiss the modal, then repeat and choose `Cancel`; for both paths observe disk inventory and Tatsu config remain byte-identical (REQ-015).
- [ ] **TASK-007**: Verify the backup invariant across all destructive flows.
  - For overwrite, delete, and sync-to-disk replacement of an existing file, observe a dated backup containing the original unmodified bytes is created before the original is changed or removed (REQ-016).
  - For a brand-new file target, observe no backup is created because no prior file exists (REQ-016).
  - Force backup failure before each destructive flow and observe the destructive write never begins, the original file remains byte-identical, no partial target state exists, and no success is reported (SEC-001).

### Implementation Phase 3: Verify boundary invariants

- **GOAL-003**: Prove the resource union, harness scope, unsupported-combination handling, alias identity, plugin rules, and path safety hold end to end.

- [ ] **TASK-008**: Verify the resource union and harness scope.
  - Observe every inventory and mutation surface exposes exactly `agents | skills | commands` for `claude`, `codex`, and `opencode` (REQ-001, REQ-005).
  - Observe `pi` appears only as explicitly deferred and offers no managed mutation actions (REQ-005).
- [ ] **TASK-009**: Verify unsupported combinations and path safety.
  - For every unsupported harness/resource combination, observe a visible, disabled capability state with an explanation, no guessed path, and no mutation available (REQ-006).
  - Attempt a mutation whose target resolves outside known harness configuration roots and observe rejection with zero filesystem effect (SEC-002, PAT-001).
- [ ] **TASK-010**: Verify Claude alias identity.
  - Locate one physical Claude resource exposed in both Skills and Commands; observe both aliases carry the same stable identity and resolve to the same physical path (REQ-017).
  - Run create-command on an existing skill alias and create-skill on an existing command alias; observe each conversion returns the existing identity and produces no duplicate disk file or Tatsu config entry (REQ-017).
- [ ] **TASK-011**: Verify plugin provenance and cross-harness boundaries.
  - Observe plugin provenance only as metadata on inventoried resources under the originating harness; observe no `plugins` resource type, independent plugin row, or plugin mutation payload (REQ-001, REQ-018).
  - Inspect every plan and action surface and observe no automatic plugin copy, install, or translation and no automatic cross-harness payload; every plan remains within one `${agentKind}:${resourceType}` scope (REQ-011, REQ-018).

## 3. Alternatives

- **ALT-001**: Write acceptance criteria as executable test suites in this step. Rejected: test implementation details are owned by [step-11-tests.md](./step-11-tests.md); duplicating them here would create two sources of truth for the same contract.
- **ALT-002**: Declare a fresh local identifier namespace for this plan. Rejected: restating Step 1's canonical identifiers keeps every criterion traceable to the binding contract and satisfies GUD-001 without inventing a second numbering system.
- **ALT-003**: Accept criteria only at the UI level, deferring file-system and config observables. Rejected: the product boundary is defined by file-system and persisted-state effects; UI-only checks cannot prove REQ-009, REQ-010, REQ-016, or SEC-001.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) is the canonical feature specification; its terminology (GUD-001) and operation matrix are the acceptance baseline.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) declares the canonical requirement identifiers mirrored in this plan.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) owns scoped plan generation, confirmed application, and backup implementation rules exercised by TASK-001 through TASK-007.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) owns the supported/unsupported capability matrix and alias capability rules observed by TASK-008 through TASK-010.
- **DEP-005**: [Step 5](./step-05-persist-tatsu-managed-config.md) owns the persisted desired state whose behavior REQ-008 and TASK-002 observe.
- **DEP-006**: [Step 6](./step-06-transport-request-handlers.md) owns the confirmed-plan request contract exercised by TASK-005 and the gate enforcement in TASK-003.
- **DEP-007**: [Step 9](./step-09-sync-conflict-ux.md) owns conflict presentation whose observables REQ-012, REQ-013, and TASK-006 verify.
- **DEP-008**: [Step 10](./step-10-skill-command-conversion.md) owns alias conversion behavior observed by TASK-010.
- **DEP-009**: [Step 11](./step-11-tests.md) owns test implementation details; this plan's Testing section defines observable outcomes only.

## 5. Files

- **FILE-001**: `plans/skills-agents-command-center/step-14-acceptance-criteria.md` — this acceptance-contract plan.
- **FILE-002**: `plans/skills-agents-command-center/step-01-product-boundary-source-of-truth.md` — canonical requirement declarations mirrored here (read-only).
- **FILE-003**: `plans/skills-agents-command-center/implementation-details.md` — canonical terminology and operation matrix (read-only).

## 6. Testing

Observable acceptance checks at the contract level; implementation details belong to [step-11-tests.md](./step-11-tests.md) (ALT-001, DEP-009).

- **TEST-001**: Direction and scope observable — a confirmed sync to disk writes the confirmed plan's Tatsu config snapshot to exactly the selected `${agentKind}:${resourceType}` disk scope and leaves Tatsu config and other disk scopes byte-identical; a confirmed adopt from disk writes the confirmed plan's disk inventory snapshot to exactly the selected Tatsu config scope and leaves disk inventory and other config scopes byte-identical; either direction before confirmation has no effect (TASK-001, TASK-002, REQ-009, REQ-010, REQ-011).
- **TEST-002**: Direct-mutation gate observable — Create creates exactly one target resource only after its explicit action, Save changes its target only after explicit confirmation, Delete removes its target only after explicit confirmation, and every ungated attempt produces zero disk writes and zero config changes (TASK-003, REQ-014).
- **TEST-003**: Backup-order observable — before overwrite, delete, or sync-to-disk replacement changes an existing file, a dated backup already contains the original bytes; a new target skips backup; forced backup failure prevents the destructive write from beginning, leaves the original byte-identical, creates no partial target state, and reports no success (TASK-007, REQ-016, SEC-001).
- **TEST-004**: Config effect — a confirmed adopt from disk replaces exactly the selected `${agentKind}:${resourceType}` Tatsu config scope with the captured disk inventory snapshot; disk inventory and every other config scope remain byte-identical (TASK-002, REQ-010, REQ-011).
- **TEST-005**: Rejection and no-op observable — stale and absent confirmed plans are rejected with zero disk writes, zero config changes, and a regeneration-and-reconfirmation requirement; modal open, dismissal, and `Cancel` leave disk inventory and Tatsu config byte-identical (TASK-005, TASK-006, REQ-015).
- **TEST-006**: Conflict observable — for the selected `${agentKind}:${resourceType}` scope, the modal displays disk-only, config-only, and content-changed entries with harness and resource labels and offers exactly the three outcomes in REQ-013; sync changes only disk, adopt changes only Tatsu config, and `Cancel` changes neither (TASK-006, REQ-012, REQ-013, GUD-002).
- **TEST-007**: Harness-visibility observable — inventory and mutation surfaces manage only `claude`, `codex`, and `opencode`; unsupported harness/resource combinations render visible, disabled, explained, and pathless; `pi` remains visible as explicitly deferred with no managed actions (TASK-008, TASK-009, REQ-005, REQ-006).
- **TEST-008**: Resource-boundary observable — inventory surfaces expose exactly `agents | skills | commands`; plugin provenance appears only as metadata under the originating harness, never as a resource type or independent payload, and no automatic plugin or cross-harness copy action exists (TASK-008, TASK-011, REQ-001, REQ-018).
- **TEST-009**: Alias observable — Claude Skills and Commands aliases expose one stable identity and one physical path; conversion in either direction returns that existing identity and creates no duplicate disk file or Tatsu config entry (TASK-010, REQ-017).
- **TEST-010**: Read-only observable — scan reads known harness roots into disk inventory and compare reads disk inventory plus Tatsu config to classify disk-only, config-only, and content-changed entries; both produce zero disk writes and zero Tatsu config changes, including when unmanaged files are present (TASK-004, REQ-008, REQ-014, CON-003).
- **TEST-011**: Run identifier declaration validation from the `plan-implementation-plan` skill against this file; duplicate TASK/GOAL declarations and duplicate bullet-style declaration identifiers MUST both produce zero results.

## 7. Risks & Assumptions

- **RISK-001**: Mirroring Step 1's identifier declarations locally can look like redefinition. This plan declares each identifier once as an observable acceptance criterion and cites its source; validation (TEST-011) confirms single declarations within this file, and no criterion adds new semantics.
- **RISK-002**: Acceptance checks that force backup failure or stale-plan rejection require controllable failure injection. Step 11 must provide seams for this without weakening production behavior; if a seam is missing, the criterion remains contract-level and untestable until Step 11 supplies it.
- **RISK-003**: "Byte-identical" observables assume the flows under test are the only writers. Concurrent harness-side file changes during acceptance runs can cause false failures; runs must serialize external mutations or tolerate re-running the affected check.
- **RISK-004**: Acceptance criteria reference resolver-dependent inventory contents without pinning paths (CON-001). Checks must be written against resolver-recognized entries, not hard-coded directories, or they will break when Step 2/3 resolvers settle conventions.
- **ASSUMPTION-001**: Every mutation flow from the operation matrix is implemented by the time acceptance runs, since this plan defines criteria only for flows Steps 2 through 10 own.
- **ASSUMPTION-002**: Failure injection (backup failure, out-of-root path, stale plan) can be represented at the acceptance level without dictating Step 11's test mechanisms.
- **ASSUMPTION-003**: Disk and config state can be observed byte-for-byte through the main-process persistence and filesystem layers, consistent with PAT-001's main-owned pattern.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent implementation plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)
- [Step 6: Transport request handlers](./step-06-transport-request-handlers.md)
- [Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)
- [Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)
- [Step 11: Tests](./step-11-tests.md)
