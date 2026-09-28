---
goal: Consolidate cross-layer regression coverage for the skills-agents-commands-sync feature
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [test, harness-config, shared-state, agent-registry, regression, security]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 11 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It audits and completes the four declared test files so that every critical behavior of the feature — path safety, drift classification, confirmed mutation, backups, alias identity, and scope isolation — is defended by a failing-on-bug regression test. It uses the feature goals, scope, and source-of-truth rules in [implementation-details.md](./implementation-details.md).

 Completing this step does not by itself complete the overarching feature; Step 12 and Step 13 (verification commands and suggested implementation order) remain follow-up work, while the Step 14 and Step 15 plans ([acceptance criteria](./step-14-acceptance-criteria.md) and [open questions](./step-15-open-questions.md)) are authored alongside this step.

Steps 2 through 10 each add their own focused tests when implemented. Step 11 is therefore a consolidation step, not a from-scratch test authoring step: for each required case, the implementing agent first verifies whether an existing test already defends the behavior and adds a test only when the behavior is uncovered. Existing passing tests MUST NOT be weakened, reworded, or deleted. This step changes test files only; a test that exposes a genuine implementation defect is resolved by fixing the owning production source, never by weakening the test.


## 1. Requirements & Constraints

- **REQ-001**: Every one of the 15 critical cases enumerated in the original Step 11 specification MUST be defended by at least one named test located in the file declared for its area: reducer events in `src/shared/state/harness-config/harness-config.test.ts`, wire snapshot merge in `src/shared/state/wire-merge.test.ts`, agent capability metadata in `src/shared/agent-registry/agent-registry.test.ts`, and path validation, sync plans, backup, confirmation, and conversion in `src/main/harness-config/harness-config.test.ts`. The case-to-test mapping is fixed by the Testing section (TEST-001 through TEST-015).
- **REQ-002**: Tests MUST verify observable behavior — returned values, files written to disk, persisted config contents, and dispatched state — not implementation wiring, source text, or incidental defaults. Each test MUST fail on a plausible bug that removes the defended behavior.
- **REQ-003**: Main-service tests MUST use real temporary directories created with `mkdtempSync` inside `os.tmpdir()` and removed with `rmSync(..., { recursive: true, force: true })`, plus the injected deterministic dependencies of `HarnessConfigServiceDeps` (fixed clock, fixed UUID sequence, resolver-owned known-root resolution, Tatsu config access/callbacks via `loadDesiredResources`/`replaceDesiredScope`). No test may depend on the developer's real `~/.claude`, `~/.codex`, or `~/.config/opencode` directories, and no test may set real user-home environment variables for the test process.
- **REQ-004**: Every rejection-path test MUST prove zero side effects: after a rejected create/update/delete/sync/adopt/conversion attempt, the temporary harness roots and the injected Tatsu config store MUST be byte-for-byte unchanged (compare a pre-captured snapshot of file names and contents).
- **REQ-005**: Shared-state and registry tests MUST remain deterministic, isolated, and full-suite-safe: no timers, no randomness beyond fixed fixture values, no cross-test shared mutable fixtures, and no reliance on test execution order.
- **REQ-006**: This step MUST NOT weaken or delete any test added by Steps 2 through 10, MUST NOT change production source except to fix a defect a test exposed, and MUST NOT add snapshot tests that pin incidental output.
- **REQ-007**: If a new or existing test fails because the production implementation violates a Step 1/Step 2 invariant (for example a missing traversal check or a backup written after the overwrite), the fix MUST be made in the owning package (`src/main/harness-config/`, `src/shared/state/harness-config/`, or `src/shared/agent-registry/`), the test MUST be re-run, and the fix MUST NOT introduce a special case for the failing input.
- **CON-001**: The only files this step may modify are the four test files named in REQ-001, plus production source fixes under REQ-007 when a test exposes a defect, plus this plan file. No new packages, barrels, types, transport handlers, or UI code may be added.
- **CON-002**: No new runtime or development dependency is permitted; tests use the existing Vitest toolchain and Node built-ins already used by Steps 2 through 6.
- **GUD-001**: Follow repository test conventions: tests live in the same package as the code under test, import through the package barrel (`.`), use one `describe` per behavioral area, and use descriptive test names that state the defended invariant.
- **GUD-002**: Use the product terms `disk inventory`, `Tatsu config`, `sync to disk`, `adopt from disk`, `conflict`, and `confirmed plan` in test names and fixture descriptions, matching [implementation-details.md](./implementation-details.md).
- **PAT-001**: Main-service fixtures MUST build harness roots by writing files directly with `fs.writeFileSync` into the temporary root (for example `<root>/skills/my-skill/SKILL.md`), then drive the service through its public API with an injected root — never by patching private helpers.
- **PAT-002**: Shared-state fixtures MUST use the typed fixture-builder pattern already established by the Step 4 slice tests: content-free refs and plans with stable IDs, hashes, paths, and timestamps.

## 2. Implementation Steps

### Implementation Phase 1: Verify prerequisites and locate existing coverage

- GOAL-001: Confirm every contract Step 11 tests depends on exists, and determine which of the 15 critical cases are already covered.

- [ ] **TASK-001**: Verify that the Steps 2 through 10 prerequisites are present before any test work begins.
  - Confirm `src/main/harness-config/` exports a service factory accepting `HarnessConfigServiceDeps` (injected `homedir`, resolver-owned known-root resolution, clock, UUID generation, `loadDesiredResources()`, `replaceDesiredScope(scope, resources)`).
  - Confirm `src/shared/state/harness-config/` exports `initialHarnessConfig`, `harnessConfigScopeKey`, and the seven `harnessConfig/*` event variants.
  - Confirm `src/shared/agent-registry` exports `AGENT_REGISTRY` entries carrying `configCapabilities`, `HarnessConfigResourceType`, and `AgentConfigCapability`.
  - Confirm the fifteen renderer/backend harness-config methods exist for import-free compile safety (typecheck only; Step 11 does not test the transport adapter — [Step 6](./step-06-transport-request-handlers.md) owns `src/main/harness-config-transport/harness-config-transport.test.ts`).
  - If any prerequisite is absent, STOP this step without editing test files; the prerequisite step owns the missing contract.
- [ ] **TASK-002**: Audit the four declared test files against the 15 critical cases and record the gap list before editing.
  - Run `npx vitest run src/shared/state/harness-config/harness-config.test.ts src/shared/state/wire-merge.test.ts src/shared/agent-registry/agent-registry.test.ts src/main/harness-config/harness-config.test.ts` and note any pre-existing failures; a pre-existing failure in a file owned by this step is in scope, one in another package is reported and left alone.
  - For each of the 15 cases (TEST-001 through TEST-015), search the corresponding test file for an existing test defending that behavior. Produce the final gap list as the working basis for Phases 2 and 3; do not write the audit to a scratch document.

### Implementation Phase 2: Shared-state and registry coverage

- GOAL-002: Guarantee reducer-event semantics, wire-snapshot skew safety, and exact capability metadata.

- [ ] **TASK-003**: Complete `src/shared/state/harness-config/harness-config.test.ts` coverage for the reducer-event area.
  - If absent, add one test per event variant: `loadingChanged` toggles only `loading` (identical value returns the original state object), `errorChanged` sets/clears only `error`, `resourcesLoaded` replaces only the scoped harness rows inside the targeted logical array and updates `lastScannedAt` only, `comparisonLoaded` stores only the `HarnessConfigComparison` (scope, status, diskOnly, configOnly, changed, comparedAt — no planId, direction, fingerprint, or syncedAt) at `harnessConfigScopeKey(comparison.scope)` and never updates `lastSyncedAt`, `syncApplied` carries `{ scope, syncedAt }` and is the sole writer of `lastSyncedAt`, `resourceUpserted` inserts at its deterministic sorted position, and `resourceDeleted` removes only the entry matching `agentKind` + `resourceType` + `id` (TEST-008, reducer half).
  - Add the delete-isolation assertions: a `resourceDeleted` event for an absent ID returns the original state unchanged, and a same-ID Claude skill alias in the other logical view (Skills vs Commands) is NOT removed by a scoped Commands delete (part of TEST-008 and TEST-012).
  - Add the comparison-scope-key assertions: a Claude Skills comparison and a Claude Commands comparison occupy different `comparisons` keys under `harnessConfigScopeKey`, and the same resource type for two harnesses occupies different keys; storing one never touches the other (TEST-012, slice half).
  - Keep every assertion on observable state (returned slice object fields), never on reducer internals.
- [ ] **TASK-004**: Complete `src/shared/state/wire-merge.test.ts` coverage for snapshot skew.
  - If absent, add one test proving an older snapshot with no `harnessConfig` key receives the full `initialHarnessConfig` default, and one test proving a snapshot carrying `resources`/`loading` but omitting `lastSyncedAt` preserves the sent values while `lastSyncedAt` is filled from the initial default (TEST-016).
  - Assert against the returned merged snapshot object only; no reducer invocation in these tests.
- [ ] **TASK-005**: Verify `src/shared/agent-registry/agent-registry.test.ts` defends the capability matrix and add gaps.
  - Required existing-or-added coverage (TEST-017): every `AgentKind` entry exposes exactly three capabilities in `agents`, `skills`, `commands` order with the exact `status`, `label`, and `notes` values from [Step 3](./step-03-harness-capability-metadata.md); Claude `skills` carries exactly `aliasResourceTypes: ['commands']` with its explanatory note; Claude `commands` is independently supported with no reciprocal alias declaration; no capability's `aliasResourceTypes` contains its own `resourceType`; all three Pi capabilities are status `unknown` with the exact note `Pi config management is deferred; its resource capabilities and layouts are not yet specified.`; `unsupported` rows remain visible and disabled with their capability note; `getAgentInfo` returns a registry entry for every `AgentKind`, with capability rows matching the Step 2 resolver matrix.

### Implementation Phase 3: Main-service coverage

- GOAL-003: Guarantee path confinement, drift classification, backup ordering, confirmation gates, and conversion identity against real temporary roots.

- [ ] **TASK-006**: Complete path-validation and traversal-rejection coverage in `src/main/harness-config/harness-config.test.ts`.
  - TEST-001 (unknown harness resource path cannot be written): a create whose logical name does not match the resolver's filename pattern for the selected harness/resource (for example a name with characters outside the allowed lowercase alphanumeric/hyphen segments, or a Codex agents name other than the fixed `AGENTS.md`), and an update/delete of an ID absent from a fresh recognized inventory, are both rejected with the structured invalid-name/unknown-resource error and perform zero writes (assert the temporary root snapshot is unchanged per REQ-004).
  - TEST-002 (`../` path traversal is rejected): a create/update target whose resolved path would escape the harness root — including a name or persisted path containing a `..` segment, an absolute path, a NUL byte, and a platform separator variant — is rejected before any filesystem call; additionally assert a sibling-prefix candidate (root `<tmp>/claude-root` vs `<tmp>/claude-root-evil`) does NOT satisfy lexical containment. Each rejection asserts zero files created and zero desired-state changes.
- [ ] **TASK-007**: Complete disk/config sync-plan coverage in `src/main/harness-config/harness-config.test.ts`.
  - TEST-003 (disk-only file appears in sync plan): seed a real file matching a resolver pattern with no corresponding desired resource; assert `planSyncToDisk`/`planAdoptFromDisk` (or the shared plan generator) returns the ref in `diskOnly` with `existsOnDisk: true`, correct `relativePath`, and a real SHA-256 hash, and that the status reflects the disk-only difference.
  - TEST-004 (config-only file appears in sync plan): seed a desired resource via the injected desired-state dependency with no file on disk; assert the plan returns the ref in `configOnly` with `existsOnDisk: false` and a resolver-derived safe absolute path.
  - TEST-005 (changed hash appears as conflict): seed the same physical resource on disk and in desired state with differing bytes; assert the plan classifies it in `changed` as an explicit `{ disk, config }` pair and that the plan status is `conflict` per the status precedence (any changed entry forces `conflict` even when other categories are empty).
  - TEST-012 (sync plan is scoped by `agentKind`): seed drift in Claude Skills only; assert a Codex Skills plan and an OpenCode Skills plan for the same temporary environment report `synced` (or only their own drift), and that no plan for one harness contains a ref whose `agentKind` differs from the plan scope. Also assert plans for different harnesses are distinct plan objects that do not share mutable difference arrays.
  - TEST-013 (no resources are copied between different `agentKind` values automatically): run a full sync-to-disk and adopt-from-disk cycle with drift present in every managed harness; assert operations and desired-scope replacements touch only the requested harness root and only the requested canonical scope — no operation list entry, desired record, or disk write names another `agentKind`, and plugin/settings files seeded beside the roots remain untouched.
- [ ] **TASK-008**: Complete mutation-safety coverage in `src/main/harness-config/harness-config.test.ts`.
  - TEST-015 (write and delete operations require explicit user confirmation; unconfirmed requests are rejected): for update, delete, and sync-to-disk apply, call `applyPlan` with `confirmed: false`, with `confirmed` absent, with an unknown `planId`, and a second time with an already-consumed `planId`; every call must reject with the structured unconfirmed/unknown-plan/stale error and perform zero writes and zero desired-state changes. Assert the successful control run (same payload with `confirmed: true`) does write, proving the gate is the confirmation value and not incidental failure.
  - TEST-007 (sync-to-disk writes only inside allowed root): apply a confirmed sync-to-disk plan containing create, overwrite, and delete operations; assert every created/modified/deleted path is inside the selected harness temporary root (assert exact file sets), that nothing was created in the parent temp directory or any sibling root, and that the atomic-write pattern left no temporary sibling files behind.
  - TEST-011 (backup file is created before update, delete, or sync-to-disk write): for each of an overwrite, a delete, and a sync-to-disk replacement, assert a backup sibling `<name>.x-backup-<UTC timestamp>[collision suffix]` exists containing the exact pre-change bytes, that a backup collision appends `-2`, that the backup is excluded from a subsequent scan, that a brand-new create produces no backup, and that forcing backup creation to fail (inject a filesystem adapter or use a read-only directory) aborts the original operation leaving the original file untouched.
  - TEST-008 (service half: delete dispatches resource removal only after successful delete): apply a confirmed delete plan where the disk delete succeeds but the injected `replaceDesiredScope` is made to throw; assert the structured `desired-state-failed` error is thrown, the deleted file has been restored from backup bytes on disk, and no partial desired-state change remains. Contrast with the successful control run where the desired scope is updated only after the disk delete succeeded.
- [ ] **TASK-009**: Complete adopt and conversion coverage in `src/main/harness-config/harness-config.test.ts`.
  - TEST-006 (adopt-from-disk updates persisted config): with real files on disk and existing desired state that differs, apply a confirmed adopt-from-disk plan; assert `replaceDesiredScope` was called exactly once with the exact requested `{ agentKind, resourceType }` scope and the canonical disk-derived resources, that no harness-directory file changed (byte-compare the root snapshot), and that other desired scopes were preserved.
  - TEST-009 (create command from skill is idempotent): generate a command from a skill by calling `prepareCommandFromSkill`, run it a second time for the same source, and assert the second run returns the same existing file ref, performs zero writes, and does not duplicate the command file. Also assert a conversion whose destination already exists as an independent file returns `{ status: 'existing', ref }` as a no-op success without overwriting, preserving idempotency.
  - TEST-010 (create skill from command is idempotent): mirror TEST-009 in the command-to-skill direction.
  - TEST-014 (Claude skill/command alias conversion returns the existing alias): for a Claude skill whose canonical `resourceType` is `skills` with `aliasResourceTypes: ['commands']`, call `prepareCommandFromSkill`; assert it returns the existing physical ref (same `id`, same `relativePath`) without writing any file, without creating a duplicate command file, and without creating a second desired record. Mirror for a Claude command that already functions as a skill.

### Implementation Phase 4: Prove the suite and deliver

- GOAL-004: Run the focused and full verification gates and commit the consolidated coverage.

- [ ] **TASK-010**: Run the four focused test files and resolve every failure.
  - Command: `npx vitest run src/shared/state/harness-config/harness-config.test.ts src/shared/state/wire-merge.test.ts src/shared/agent-registry/agent-registry.test.ts src/main/harness-config/harness-config.test.ts`.
  - A failure caused by a production defect is fixed in the owning package per REQ-007 and the focused run is repeated; a test is never adjusted to pass over an invariant violation.
- [ ] **TASK-011**: Run the full verification gates.
  - `npx vitest run` (entire suite) must exit successfully, proving the new tests are full-suite-safe and did not break sibling packages.
  - `pnpm typecheck` must exit successfully across all TypeScript project references (test files included in typechecking must compile without casts that hide contract mismatches).
  - `pnpm build` must exit successfully; a test-only change should not alter bundles, so any build failure indicates an accidental production edit that must be reviewed.
- [ ] **TASK-012**: Review the final diff against scope, run identifier validation, and commit.
  - Verify the diff touches only the four test files, permitted production fixes under REQ-007, and this plan file; verify no new dependency in `package.json` / `pnpm-lock.yaml`; verify no test asserts source text or implementation wiring.
  - Run the identifier declaration validation from the `plan-implementation-plan` skill against this plan file: duplicate TASK/GOAL table declarations and duplicate bullet-style declaration identifiers MUST both produce zero rows.
  - Commit with message `test: consolidate harness config regression coverage` and immediately run `git push origin <current-branch>`. Do not include unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Rewrite all four test files from scratch. Rejected because Steps 2 through 4 already own high-quality focused tests; a rewrite would discard verified coverage and risk re-introducing gaps the earlier steps closed.
- **ALT-002**: Add a new cross-package end-to-end test package that drives service, transport, slice, and renderer together. Rejected because CON-001 restricts this step to the four declared files; the transport adapter and renderer surfaces are covered by Step 6's dedicated tests and the Step 9/10 smoke plans, and a cross-layer harness would add a fifth test surface without a declared owner.
- **ALT-003**: Mock the filesystem adapter for all main-service tests. Rejected because path confinement, backup bytes, atomic-write cleanup, and traversal rejection are exactly the behaviors a fake filesystem tends to get wrong; real temporary directories are the honest oracle.
- **ALT-004**: Add snapshot tests for plan objects to pin drift output. Rejected because snapshots pin incidental shape and churn on every fixture edit; explicit assertions on `diskOnly`/`configOnly`/`changed` membership and statuses defend the actual contract.
- **ALT-005**: Cover the 15 critical cases in the transport adapter tests instead of the service tests. Rejected because confirmation, traversal, backup, and drift classification are service invariants (Step 2 REQ-018 through REQ-027); the adapter only forwards validated requests, and duplicating the assertions there would double maintenance for no additional defect coverage.
- **ALT-006**: Skip the audit and only append new tests. Rejected because duplicate tests for an already-covered case add suite time and future maintenance cost without defending anything new; TASK-002 makes the additions surgical.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, the disk-inventory versus Tatsu-config source-of-truth rules, the Claude skill/command caveat, and the backup requirement that these tests defend.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the managed harness boundary, confirmation semantics, alias identity, and no-cross-harness rule asserted by TEST-006, TEST-013, TEST-014, and TEST-015.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) provides the service, resolver matrix, injected dependencies, structured error codes, backup/rollback behavior, and the existing `harness-config.test.ts` that this step extends.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) provides `configCapabilities`, the canonical `HarnessConfigResourceType`, and the exact notes/alias values asserted by TEST-017.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) provides the seven event variants (`loadingChanged`, `resourcesLoaded`, `comparisonLoaded`, `syncApplied`, `resourceUpserted`, `resourceDeleted`, `errorChanged`), `harnessConfigScopeKey`, `initialHarnessConfig`, and the reducer asserted by TEST-008, TEST-012, and TEST-016.
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) provides the persisted desired-state seam (`loadDesiredResources` / `replaceDesiredScope`) used as the injected desired-state dependency in the adopt and delete tests.
- **DEP-007**: [Step 6](./step-06-transport-request-handlers.md) provides the fifteen-channel transport contract splitting observation, prepare, plan-generation, mutation, and conversion channels — `compareHarnessConfig` is non-authorizing (read-only comparison only) while mutations are bound to channel-matching plans; its adapter tests remain owned by Step 6 and are out of scope here.
- **DEP-008**: [Step 10](./step-10-skill-command-conversion.md) provides the single-phase `prepareCommandFromSkill` / `prepareSkillFromCommand` service wrappers and the alias/idempotency contract asserted by TEST-009, TEST-010, and TEST-014 (TEST-009/010/014 may exercise the service-level conversion directly; behavior assertions keep the idempotent alias return).
- **DEP-009**: Vitest, `node:fs`, `node:os`, `node:path`, and `node:crypto` provide the test toolchain; no new dependency is introduced.
- **DEP-010**: [AGENTS.md](../../AGENTS.md) defines the repository test conventions (behavioral assertions, no implementation-pinning, full-suite safety) that REQ-002 and REQ-005 enforce.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/harness-config.test.ts` — reducer event variants, scoped isolation, alias/delete isolation, and comparison-scope-key coverage (TEST-008, TEST-012 slice halves, TEST-016-adjacent event coverage).
- **FILE-002**: `src/shared/state/wire-merge.test.ts` — missing-slice and partial-slice snapshot merge coverage (TEST-016).
- **FILE-003**: `src/shared/agent-registry/agent-registry.test.ts` — exact capability matrix, Claude alias invariant, Pi status-`unknown` rows with the deferred note (TEST-017).
- **FILE-004**: `src/main/harness-config/harness-config.test.ts` — path safety, drift plans, backup ordering, confirmation gates, confined writes, delete ordering, adopt semantics, and conversion idempotency (TEST-001 through TEST-007, TEST-008 service half, TEST-009 through TEST-015).
- **FILE-005**: `plans/skills-agents-command-center/step-11-tests.md` — this executable plan, replacing the original one-line step stub.
- **FILE-006**: Production source under `src/main/harness-config/`, `src/shared/state/harness-config/`, or `src/shared/agent-registry/` — modified only when a test exposes a genuine invariant defect (REQ-007).

## 6. Testing

The 15 critical cases from the Step 11 specification map to tests as follows. "Main" = `src/main/harness-config/harness-config.test.ts`, "Slice" = `src/shared/state/harness-config/harness-config.test.ts`.

| Critical case | Test | File |
|---|---|---|
| Unknown harness resource path cannot be written | **TEST-001** | Main |
| `../` path traversal is rejected | **TEST-002** | Main |
| Disk-only file appears in sync plan | **TEST-003** | Main |
| Config-only file appears in sync plan | **TEST-004** | Main |
| Changed hash appears as conflict | **TEST-005** | Main |
| Adopt-from-disk updates persisted config | **TEST-006** | Main |
| Sync-to-disk writes only inside allowed root | **TEST-007** | Main |
| Delete dispatches resource removal only after successful delete | **TEST-008** | Slice + Main |
| Create command from skill is idempotent; existing destination returns `{ status: 'existing' }` | **TEST-009** | Main |
| Create skill from command is idempotent | **TEST-010** | Main |
| Backup file created before update, delete, or sync-to-disk write | **TEST-011** | Main |
| Sync plan scoped by `agentKind`; one harness's sync does not affect another | **TEST-012** | Slice + Main |
| No resources copied between different `agentKind` values automatically | **TEST-013** | Main |
| Claude skill/command alias conversion returns the existing alias | **TEST-014** | Main |
| Write/delete require explicit confirmation; unconfirmed rejected | **TEST-015** | Main |

- **TEST-001**: Unknown-resource-path test proves a logical name outside the resolver pattern and an unrecognized resource ID are both rejected with zero writes.
- **TEST-002**: Traversal test proves `..` segments, absolute paths, NUL bytes, separator variants, and sibling-prefix candidates cannot escape the harness root, with zero writes on every rejection.
- **TEST-003**: Disk-only test proves a resolver-matched disk file without desired state appears in `diskOnly` with real hash and path metadata.
- **TEST-004**: Config-only test proves a desired resource without a disk file appears in `configOnly` with `existsOnDisk: false`.
- **TEST-005**: Conflict test proves differing hashes classify as a `{ disk, config }` changed pair and force plan status `conflict`.
- **TEST-006**: Adopt test proves one confirmed adopt replaces exactly the requested desired scope from disk with zero harness-directory writes.
- **TEST-007**: Confinement test proves a confirmed sync-to-disk creates, overwrites, and deletes only inside the selected harness root with no temporary-file residue.
- **TEST-008**: Delete-ordering coverage proves the reducer removes a resource only via the scoped `resourceDeleted` event (absent ID is a no-op; alias views untouched) and the service updates desired state only after a successful disk delete, restoring backup bytes when persistence fails.
- **TEST-009**: Skill-to-command idempotency test proves the second conversion returns the existing ref with zero writes and refuses to overwrite an independent destination.
- **TEST-010**: Command-to-skill idempotency test mirrors TEST-009 in the reverse direction.
- **TEST-011**: Backup test proves exact pre-change bytes, collision suffixing, scan exclusion, no backup for brand-new creates, and fail-closed behavior when backup creation fails.
- **TEST-012**: Scope-isolation tests prove plan keys and plan contents never cross `agentKind` or `resourceType` at the service layer, and comparison keys never cross at the slice layer.
- **TEST-013**: Cross-harness test proves sync/adopt cycles never copy, write, or persist a resource into another `agentKind`, and plugin/settings files remain untouched.
- **TEST-014**: Alias test proves Claude skill-to-command (and reverse) conversion returns the existing physical ref without duplicating files or desired records.
- **TEST-015**: Confirmation test proves `confirmed: false`, missing confirmation, unknown plan IDs, and reused plan IDs reject with zero writes while the `confirmed: true` control run succeeds.
- **TEST-016**: Wire-merge tests prove an older snapshot without `harnessConfig` receives `initialHarnessConfig` and a partial snapshot preserves sent fields while filling omitted ones from defaults.
- **TEST-017**: Capability-matrix tests prove every agent exposes the exact three-row matrix with status `supported|unsupported|unknown`, exact labels/notes/aliases, no self-aliasing, Pi rows at status `unknown` with the exact note `Pi config management is deferred; its resource capabilities and layouts are not yet specified.`, and `unsupported` rows remaining visible and disabled with their capability note.
- **TEST-018**: `npx vitest run` on the four focused files exits successfully.
- **TEST-019**: Full `npx vitest run`, `pnpm typecheck`, and `pnpm build` all exit successfully.
- **TEST-020**: Identifier declaration validation against this plan reports zero duplicate TASK/GOAL table declarations and zero duplicate bullet-style declaration identifiers.

## 7. Risks & Assumptions

- **RISK-001**: Steps 2 through 10 are not implemented yet (the repository currently contains only their plans). This step MUST NOT be started until TASK-001 confirms the prerequisite contracts; starting early would force inventing partial substitutes, which CON-001 forbids.
- **RISK-002**: The consolidation audit can double-count: an existing test may already defend a critical case under a different name. TASK-002's case-by-case verification prevents duplicates; when in doubt, the existing test is retained and the case is marked covered.
- **RISK-003**: Backup-collision and fail-closed tests manipulate real directories and can be flaky on unusual filesystems. Using `os.tmpdir()` per test, unique fixed timestamps via the injected clock, and skipping no assertions keeps them deterministic; a genuinely platform-dependent failure is fixed in the production code path it exposes, not by skipping the test.
- **RISK-004**: A new test may expose a defect in shipped Steps 2–10 code. REQ-007 routes the fix to the owning package with a focused re-run, so this step can deliver test-plus-fix in one commit without expanding into unrelated refactoring.
- **RISK-005**: Alias tests depend on the exact Claude canonical/alias modeling from Step 2 (physical ID stability across Skills and Commands). If the alias contract changed during Steps 9/10 implementation, TEST-014 must assert the implemented contract and any divergence is reported rather than papered over.
- **ASSUMPTION-001**: The service's public API and injected dependency surface match Step 2's plan (prepare/apply separation, `HarnessConfigServiceDeps`, structured `HarnessConfigError` codes); tests assert through public methods only.
- **ASSUMPTION-002**: The seven-event slice union and scope-key helper match Step 4's plan exactly; no additional event variants were added during implementation.
- **ASSUMPTION-003**: The Step 3 capability matrix is unchanged since its plan (three `supported` rows for Claude/Codex/OpenCode, three Pi rows at status `unknown` with the exact note `Pi config management is deferred; its resource capabilities and layouts are not yet specified.`).
- **ASSUMPTION-004**: Test files participate in `pnpm typecheck`; if the repository excludes tests from typecheck, TASK-011's typecheck gate still runs and the Vitest run remains the compile check for tests.
- **ASSUMPTION-005**: The Step 11 specification's phrase "Skill-command generation" area maps to the conversion tests (TEST-009, TEST-010, TEST-014) in the main service test file, because [Step 10](./step-10-skill-command-conversion.md) places the generators in `src/main/harness-config/`.

## 8. Related Specifications / Further Reading

[Feature implementation details and source-of-truth rules](./implementation-details.md)

[Parent Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md)

[Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)

[Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)

[Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)

[Step 4: Shared state slice](./step-04-shared-state-slice.md)

[Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)

[Step 6: Transport request handlers](./step-06-transport-request-handlers.md)

[Step 7: Config page shell](./step-07-config-page-shell.md)

[Step 8: Navigation entry points](./step-08-navigation-entry-points.md)

[Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)

[Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)

 [Step 14: Acceptance criteria](./step-14-acceptance-criteria.md)

[Repository architecture and workflow rules](../../AGENTS.md)
