---
goal: Implement deterministic same-harness skill-command conversion with generated-draft review and Claude alias no-ops
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, harness-config, conversion, renderer, react]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 10 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It adds deterministic same-harness conversion between skills and commands: Claude conversion resolves the opposite logical view as an alias of the same physical resource with the same stable identity/path, while supported non-alias conversions use pure content generators in `src/main/harness-config/`, a non-mutating conversion-prepare service path that returns an existing alias/ref or a generated draft, and explicit Config-page actions that let the user review and edit the generated draft before the final confirmed save. Conversion is never an automatic consequence of disk inventory, Tatsu config, sync to disk, adopt from disk, conflict handling, or plugin provenance. It consumes the feature goals, source-of-truth rules, Claude alias caveat, and backup boundary defined in [implementation-details.md](./implementation-details.md).

This step completes the first-version conversion feature but not the larger plan: Step 11 retains cross-layer test ownership. At plan time, the runtime packages from Steps 2 through 9 are declared prerequisites rather than files present in the repository; implementation MUST begin only after those prerequisite contracts exist, and MUST stop rather than substitute if any declared symbol is missing.

Three upstream contracts are refined here and reconciled in Phase 2: the Step 6 channels `harnessConfig:prepareCommandFromSkill` and `harnessConfig:prepareSkillFromCommand` are single-phase prepare-only requests with no plan binding or apply phase because the generated draft must be user-editable before the final save (the separate confirmed direct-create path owns the write); the Step 2 service conversion methods are named `prepareCommandFromSkill`/`prepareSkillFromCommand` so the pure generators own the `createCommandFromSkill`/`createSkillFromCommand` names; and an existing destination returns the existing ref as a no-op success rather than an error, which preserves Step 2's no-overwrite guarantee and satisfies Step 11's idempotency requirement.

## 1. Requirements & Constraints

 - **REQ-001**: Create `src/main/harness-config/conversion.ts` with exactly two exported pure generators, `createCommandFromSkill(skill)` and `createSkillFromCommand(command)`, plus package-internal `slugifyLogicalName()` and `extractFrontMatterDescription()` helpers. The module MUST be deterministic: no filesystem access, clock, randomness, or UUID generation. It MUST be exported through the `src/main/harness-config` barrel.
- **REQ-002**: The generator input type `HarnessConfigConversionSource` MUST contain `agentKind` (`claude | codex | opencode`), `resourceType` (`'skills' | 'commands'`), logical source `name`, display `label`, root-relative POSIX `relativePath`, and full UTF-8 `content`. `createCommandFromSkill` MUST require `resourceType: 'skills'`; `createSkillFromCommand` MUST require `resourceType: 'commands'`; any other input MUST throw `HarnessConfigError` with a safe message.
- **REQ-003**: Destination naming MUST be deterministic: `destinationName = slugifyLogicalName(label)`, falling back to the source logical `name`. `slugifyLogicalName` MUST lowercase, keep ASCII `[a-z0-9]`, collapse every other character run into a single `-`, trim leading/trailing `-`, and truncate to 80 characters with trailing `-` trimmed. An empty result MUST throw `HarnessConfigError` with the `invalid-name` code defined by Step 2.
- **REQ-004**: `createCommandFromSkill` MUST return `{ destinationResourceType: 'commands', destinationName, content }` where `content` is exactly:

  ```md
  ---
  description: <description>
  ---

  Use the <destinationName> skill.

  <!-- Converted by Tatsu from <agentKind> skills <relativePath> -->
  ```

  `<description>` MUST be `extractFrontMatterDescription(source.content)` when that returns a non-empty value, otherwise `Run the <destinationName> skill`. `extractFrontMatterDescription` MUST scan only a leading `---` front-matter block (at most its first 50 lines), return the trimmed value of the first line matching `^description:\s*(.*)$`, and return `null` when no block, no closing delimiter, or no `description` line exists.
- **REQ-005**: `createSkillFromCommand` MUST return `{ destinationResourceType: 'skills', destinationName, content }` where `content` is exactly:

  ```md
  # <destinationName>

  Use this skill when the user requests the `<destinationName>` command behavior.

  <!-- Converted by Tatsu from <agentKind> commands <relativePath> -->
  ```
- **REQ-006**: Generated content MUST contain no timestamp, UUID, hash, or randomness so regeneration is byte-identical and re-deriving a draft never manufactures synthetic drift.
- **REQ-007**: Source metadata MUST appear only in the trailing HTML comment naming `agentKind`, source resource type, and source root-relative path; the comment MUST be the last line followed by a terminating newline. Generated content MUST NOT embed the source file body.
 - **REQ-008**: The service conversion prepare methods `prepareCommandFromSkill(scope, id)` and `prepareSkillFromCommand(scope, id)` in `src/main/harness-config/harness-config.ts` MUST be non-mutating: resolve the source ref from a fresh disk inventory within the requested scope, require the source canonical resource type to match the direction, read fresh UTF-8 source content only after alias/existing resolution requires generation, and return one `HarnessConfigConversionResult`. They MUST NOT create a mutation plan and MUST NOT write disk or Tatsu config.
- **REQ-009**: For a Claude skill-to-command request, `prepareCommandFromSkill` MUST resolve the command logical view as an alias and return `{ status: 'alias', ref }` carrying the skill's existing physical ref (canonical `skills`, alias `commands`). The returned ref MUST retain the same stable resource identity and underlying physical path that the Skills and Commands views resolve to, per Step 1 REQ-017. The create-command action MUST never invoke generation or create, copy, or modify a file for this alias.
- **REQ-009a**: For a Claude command-to-skill request, `prepareSkillFromCommand` MUST resolve the skill logical view as an alias and return `{ status: 'alias', ref }` carrying the command's existing physical ref (canonical `commands`, alias `skills`). The alias invariant from Step 1 REQ-017 is bidirectional: create-skill and create-command each return the existing resource reference when the target logical alias already exists; neither direction may allocate a new identity/path or create a duplicate file.
- **REQ-010**: After Claude alias resolution, when the derived destination path (`commands/<name>.md`, Codex `prompts/<name>.md`, `skills/<name>/SKILL.md`) already exists in the fresh disk inventory, the prepare method MUST return `{ status: 'existing', ref }` with that ref and MUST NOT overwrite it. This makes conversion idempotent: a second conversion returns the first result.
- **REQ-011**: Otherwise the prepare method MUST return `{ status: 'draft', scope, name, content }`, where `scope` is `{ agentKind: source.agentKind, resourceType: <destinationResourceType> }` and `name`/`content` come from the matching pure generator. The destination `agentKind` MUST equal the source `agentKind` and the requested scope's `agentKind`; no code path may derive a destination harness from plugin provenance, Tatsu config, disk inventory entries in another harness, or any other field.
- **REQ-012**: A conversion request MUST carry exactly `{ scope, id }` and MUST originate from the user's explicit `Create command` or `Create skill` action. Source-type mismatch, a source that resolves outside the requested `${agentKind}:${resourceType}` scope, `pi`, unsupported agent values, a config-only source (`existsOnDisk: false`), and any extra authority-bearing field (destination harness, path, name override, plan ID, content, plugin, or provenance) MUST be rejected with a safe structured error before alias resolution or generation. Disk-inventory refresh, Tatsu-config refresh, sync to disk, adopt from disk, conflict resolution, and plugin discovery MUST NOT invoke conversion. The only conversion channels are Step 6's `harnessConfig:prepareCommandFromSkill` and `harnessConfig:prepareSkillFromCommand`; both are single-phase prepare-only requests with no mutation-plan binding and no apply phase.
- **REQ-013**: The Config resource list MUST expose one conversion action per row: `Create command` on Skills-tab rows and `Create skill` on Commands-tab rows. The action MUST be disabled when the destination capability for that harness is unsupported per `getAgentInfo(agentKind).configCapabilities`, when the row is config-only (`existsOnDisk: false`), or while a conversion request is in flight; disabled controls MUST expose the reason accessibly.
 - **REQ-014**: Only clicking a row's conversion action MAY call the matching renderer method with `{ scope, id }`: `prepareHarnessConfigCommandFromSkill` maps one-to-one to `harnessConfig:prepareCommandFromSkill`, and `prepareHarnessConfigSkillFromCommand` maps one-to-one to `harnessConfig:prepareSkillFromCommand`. Loading a row or completing another workflow MUST NOT call either channel. An `alias` or `existing` result MUST show the inline notice `Already available as a command at <relativePath>` (or `...as a skill...`) and perform zero mutation. A `draft` result MUST enter conversion create mode; the conversion response itself MUST never apply it.
- **REQ-015**: Conversion create mode MUST reuse the Step 7 create flow pre-filled from the draft: the destination logical name and generated content seed the local drafts, the editor shows a destination-scope label plus a generation source line, the submit button is labeled `Create command` or `Create skill`, and submitting MUST run the existing two-phase `createHarnessConfigFile` prepare/apply with `confirmed: true`. The explicit row action followed by the explicit submit click is the only supported conversion path and the submit click is the sole mutation confirmation; nothing may auto-prepare or auto-apply. The user MUST be able to edit both name and content before submitting, and the Step 7 dirty guard MUST apply.
- **REQ-016**: Conversion MUST be non-optimistic: no local inventory, badge, or plan mutation. State updates come only from Step 6's post-apply rescan, followed by the fresh scoped comparison required by Step 7 REQ-022.
- **REQ-017**: Claude alias identity MUST be preserved per Step 1 REQ-017: Claude skill and command synonymy is modeled as two logical views of the same underlying physical resource — one physical Claude resource MAY appear in both Skills and Commands views, and both views MUST resolve to one stable resource identity and one underlying path. An alias result MUST NOT create a second physical disk-inventory entry, file, Tatsu-config record, or rewritten ID; the UI renders only the notice and reuses the existing ref.
- **REQ-018**: Draft content MUST remain request-scoped: it exists only in the conversion response and the local editor draft. It MUST NOT enter `AppState`, a state event, a persisted sync plan, a log line, or the persisted config.
- **REQ-019**: Every asynchronous conversion chain MUST capture the active backend ID and backend-session generation at its start and re-check both after every await, ignoring stale results before any local state update, exactly as Step 7's stale-result guard and Step 9 REQ-021 require.
 - **REQ-020**: Shared contracts MUST be updated: define `HarnessConfigConversionResult` in `src/shared/state/harness-config/types.ts` as the discriminated `alias | existing | draft` union of REQ-009 through REQ-011 (including the bidirectional alias cases of REQ-009a), change the conversion request type to the `{ scope, id }` shape, use the transport channel names `harnessConfig:prepareCommandFromSkill` and `harnessConfig:prepareSkillFromCommand` (matching Step 6 REQ-001; the renderer methods `prepareHarnessConfigCommandFromSkill`/`prepareHarnessConfigSkillFromCommand` map onto these channels one-to-one), and type both `ElectronAPI` conversion methods as `Promise<HarnessConfigRequestResult<HarnessConfigConversionResult>>`.
- **SEC-001**: The renderer MUST never supply filesystem authority. Conversion requests accept only scope and stable source ID; destination harness, path, name, and content are derived in main.
- **SEC-002**: The two prepare-only conversion channels perform zero harness-directory writes, zero Tatsu-config writes, create no mutation-plan binding, and expose no conversion apply phase. The only write for a returned draft is the later user-confirmed direct create through the existing create channel, which retains Step 2's backup, atomic-write, and rollback invariants.
- **SEC-003**: No resource may be generated across different `agentKind` values. The managed resource union remains exactly `agents | skills | commands`; plugins are provenance metadata only, never a fourth resource type, a conversion source/destination, or an automatic cross-harness payload. Repository-local, Pi, and plugin resources do not participate in conversion.
- **CON-001**: Add no runtime or development dependency; `conversion.ts` imports only package-internal types and the `HarnessConfigError` contract.
- **CON-002**: Do not change the persistence schema, the `harnessConfig` slice fields or events, sync/adopt planning, the Step 9 conflict dialog, or navigation ownership.
- **CON-003**: Keep the four Config presentational components prop-driven; conversion orchestration lives only in `Config.tsx`, and the conversion notice and draft state are renderer-local.
- **CON-004**: Do not implement cross-harness copying, plugin translation or management, repository-local resources, or Pi management in this step. No sync to disk, adopt from disk, or conflict workflow may implicitly perform a supported conversion; every conversion begins with its explicit direct row action.
- **GUD-001**: Unit-test `slugifyLogicalName` and `extractFrontMatterDescription` directly through the package barrel, separate from service-level coverage.
- **PAT-001**: Follow package/barrel conventions: external code imports `src/main/harness-config` and `src/renderer/components/Config`, never implementation files; conversion tests live in `src/main/harness-config/harness-config.test.ts` as Step 11's table specifies.
- **PAT-002**: Follow the Step 7 smart/dumb boundary and the existing `window.confirm`-free create flow; do not introduce a second confirmation mechanism.

## 2. Implementation Steps

### Implementation Phase 1: Deterministic conversion generators

- **GOAL-001**: Establish pure, byte-stable content generation with deterministic naming, independent of service, transport, and UI.

- [ ] **TASK-001**: Extend `src/main/harness-config/types.ts` with `HarnessConfigConversionSource` and the service-level draft shape; import the shared `HarnessConfigConversionResult` once it exists in Phase 2 and re-export it from the barrel so main and shared declarations never diverge.
- [ ] **TASK-002**: Implement `slugifyLogicalName()` and `extractFrontMatterDescription()` in `src/main/harness-config/conversion.ts` exactly as REQ-003 and REQ-004 specify, throwing `HarnessConfigError` (`invalid-name`) on an empty slug.
- [ ] **TASK-003**: Implement `createCommandFromSkill(skill)` returning the REQ-004 shape, wired through the two helpers, with `HarnessConfigError` on non-`skills` sources.
- [ ] **TASK-004**: Implement `createSkillFromCommand(command)` returning the REQ-005 shape, with `HarnessConfigError` on non-`commands` sources.
- [ ] **TASK-005**: Export both generators (not the private helpers) from `src/main/harness-config/index.ts`.

### Implementation Phase 2: Service and transport conversion contract

- **GOAL-002**: Make conversion prepare a read-only alias/existing/draft resolution and remove the dead conversion apply phase from the transport contract.

 - [ ] **TASK-006**: Rework the service conversion methods in `harness-config.ts` into `prepareCommandFromSkill(scope, id)` and `prepareSkillFromCommand(scope, id)` implementing REQ-008 through REQ-012: fresh-inventory source resolution, bidirectional Claude alias resolution before content reads or generators, reuse of the same stable identity/path in the returned alias ref, resolver-derived destination path lookup for the `existing` result, and generator invocation only for a supported `draft` result. Reuse Step 2's injected dependencies and structured errors; add no new error codes unless none fits. Reject any destination harness or plugin/provenance input rather than translating or copying it.
- [ ] **TASK-007**: Add `HarnessConfigConversionResult` and the `{ scope, id }` conversion request type to `src/shared/state/harness-config/types.ts`; remove the conversion members from the prepare-or-apply discriminated union so the two channels accept only the prepare shape.
- [ ] **TASK-008**: Update `src/main/harness-config-transport/harness-config-transport.ts`: register `harnessConfig:prepareCommandFromSkill` and `harnessConfig:prepareSkillFromCommand`, route them one-to-one to the correspondingly named service methods, return the conversion result through the standard result envelope, expose no conversion apply handler, create no plan binding, and enforce REQ-012 boundary validation (exact scope, source-type match, unknown-field rejection, and rejection of destination-harness/plugin/provenance authority). Preserve post-apply rescan behavior only for the separate direct-create path that finalizes a draft; do not call conversion from sync to disk, adopt from disk, conflict, inventory, or plugin paths.
 - [ ] **TASK-009**: Update `src/renderer/types/types.ts` and `src/renderer/build-backend/build-backend.ts` so `prepareHarnessConfigCommandFromSkill` maps only to `harnessConfig:prepareCommandFromSkill` and `prepareHarnessConfigSkillFromCommand` maps only to `harnessConfig:prepareSkillFromCommand`, both with the new result type and neither with an apply phase or `reqLocal` routing.
- [ ] **TASK-010**: Verify the upstream plan documents already reconciled with this contract remain consistent: [step-02](./step-02-main-process-harness-config-service.md) REQ-027/TASK-008 were updated to prepare-only conversion methods returning a `HarnessConfigConversionResult` (no conversion plan), and [step-06](./step-06-transport-request-handlers.md) REQ-001/REQ-007/REQ-009/REQ-026 were updated to the single-phase `{ scope, id }` conversion request with no apply phase and no plan binding. Confirm no residual prepare/apply conversion wording survives in either file; fix only conflicting clauses if any remain after later plan edits.

### Implementation Phase 3: Config-page conversion UX

- **GOAL-003**: Let the user trigger conversion, see alias/existing outcomes as notices, and edit the generated draft before the single confirmed save.

- [ ] **TASK-011**: Create `src/renderer/components/Config/config-conversion.ts` as a package-internal pure helper returning one render-ready outcome per `HarnessConfigConversionResult`: `already-available` with the exact notice text and relative path, or `draft` with destination scope, name, and content. Extend `src/renderer/components/Config/types.ts` with the conversion action props (`onCreateCommand`/`onCreateSkill`, per-row disabled reasons) and the conversion create-mode fields.
- [ ] **TASK-012**: Add the row conversion actions to `ConfigResourceList.tsx` per REQ-013, including disabled states with accessible reasons and stable button labels.
- [ ] **TASK-013**: Implement conversion orchestration in `Config.tsx`: only the direct row actions may start the REQ-014 prepare flow; add backend-session guards, the inline alias/existing notice beside the initiating control, and conversion create mode entered from a draft result with pre-filled name/content per REQ-015, reusing the existing dirty guard, create submission two-phase handler, and REQ-016/REQ-017/REQ-018/REQ-019 boundaries. Do not trigger conversion from mount, tab selection, disk-inventory or Tatsu-config changes, sync to disk, adopt from disk, conflict completion, or plugin metadata.
- [ ] **TASK-014**: Compose the new action and notice surfaces through the existing `Config.tsx` JSX so the presentational components stay dumb and no conversion logic leaks into `ConfigTabs.tsx`, `ConfigEditor.tsx`, or `ConfigSyncDialog.tsx`.

### Implementation Phase 4: Prove behavior and deliver

- **GOAL-004**: Verify generators, service rules, transport contract, and the real conversion flow before committing.

- [ ] **TASK-015**: Add conversion coverage to `src/main/harness-config/harness-config.test.ts` using Vitest and temporary harness roots: byte-exact generated content for every REQ-004/REQ-005 template, description extraction and fallback, slug rules and `invalid-name` rejection, bidirectional Claude alias returns that reuse the same physical ref identity/path with zero writes and zero duplicate files (skill-to-command per REQ-009 AND command-to-skill per REQ-009a), existing-destination no-op and idempotency, draft results for supported non-alias Codex/OpenCode conversions, same-harness and source-type enforcement, config-only source rejection, and rejection of plugin/provenance or destination-harness input.
- [ ] **TASK-016**: Update `src/main/harness-config-transport/harness-config-transport.test.ts`: conversion prepare returns the three result shapes through the envelope, no apply phase exists for the two channels, extra authority fields (including destination harness, plugin, and provenance) are rejected without invoking any service method, no sync-to-disk/adopt-from-disk/conflict/inventory handler dispatches a conversion, and a successful draft create still triggers the post-apply rescan.
- [ ] **TASK-017**: Add `src/renderer/components/Config/config-conversion.test.ts` covering the pure outcome helper, and extend `ConfigResourceList.test.ts` for conversion action presence and capability/config-only/queue-disabled derivation. Add `Config.tsx` orchestration coverage proving prepare is dispatched only by an explicit enabled row action, Claude alias results retain the returned ref without entering create mode, and unrelated refresh/sync/adopt/conflict/plugin state changes dispatch no conversion or copying.
- [ ] **TASK-018**: Run `npx vitest run src/main/harness-config/harness-config.test.ts src/main/harness-config-transport/harness-config-transport.test.ts src/renderer/components/Config/config-conversion.test.ts src/renderer/components/Config/ConfigResourceList.test.ts`, then `pnpm typecheck` and `pnpm build`; resolve every failure without weakening validation or confirmation rules.
- [ ] **TASK-019**: Smoke-test the real surface: launch `pnpm dev` with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `OPENCODE_CONFIG_DIR` pointed at disposable fixture directories; exercise a Codex skill-to-command conversion end to end (explicit row action, prepare, draft prefill, edit name and content, submit, confirm the file appears under the Commands tab), a supported OpenCode command-to-skill conversion, a repeated conversion returning the existing ref without a second file, and both Claude alias directions returning the same stable resource identity/path with no duplicate file. Then exercise sync to disk, adopt from disk, conflict handling, inventory refresh, and plugin-bearing provenance without clicking a conversion action and confirm none creates or copies a skill/command; verify cross-harness/plugin authority is rejected, an unsupported destination capability is disabled, and a dirty draft can be canceled. Remove all fixtures afterward; no real user harness file may be touched.
- [ ] **TASK-020**: Review the final change against Steps 1, 2, 6, 7, 9, and 11: verify same-harness-only generation, zero conversion writes outside the confirmed direct create, bidirectional Claude alias identity preservation (one stable resource identity/path across both logical views and no duplicate resource), request-scoped draft content, no automatic conversion from disk inventory, Tatsu config, sync to disk, adopt from disk, conflict, or plugin provenance, reconciled upstream docs, and that Step 11's skill-command generation cases are all covered. Run identifier-declaration and relative-link validation for this plan before committing.
- [ ] **TASK-021**: Commit the conversion feature and focused tests as one change with message `feat: add skill-command conversion`, then run `git push origin <current-branch>` immediately after the commit succeeds. Include only this step's files and the TASK-010 document reconciliation; exclude smoke fixtures and unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Keep Step 6's prepare/apply conversion plan and have the UI apply the unedited draft. Rejected because the product requires the user to edit the generated draft before the final save; two finalization paths (apply plan vs. edited create) would leave a dead UI apply phase and ambiguous confirmation semantics.
- **ALT-002**: Apply the conversion plan directly without draft review. Rejected for the same reason plus Step 1's explicit-confirmation matrix, which this step preserves through the existing create channel.
- **ALT-003**: Place the pure generators in a shared browser-safe package so the renderer could preview drafts without a round trip. Rejected because the source brief mandates `src/main/harness-config/`, a second template owner risks divergence, and the request-scoped draft keeps content out of shared code.
- **ALT-004**: Suffix the destination name on collision instead of returning the existing ref. Rejected because the source brief requires returning the existing file ref, and returning it keeps conversion idempotent and deterministic.
- **ALT-005**: Embed a generation timestamp in the source-metadata comment. Rejected because nondeterministic content would make regeneration produce hash changes and false drift on an otherwise identical draft.
- **ALT-006**: Copy the full source front matter into the generated command. Rejected because vendor front-matter schemas vary and are unverified across harnesses; extracting only `description` is deterministic and safe.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk-versus-Tatsu source-of-truth rules, and the Claude skills/commands synonymy caveat.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines alias identity, the no-cross-harness rule, and the explicit-confirmation matrix that the conversion flow must preserve.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) provides the service, resolvers, physical IDs, logical-name validation, fresh inventory/read, structured errors, injected dependencies, and the create path with backup/atomic-write/rollback that finalizes drafts.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) provides the capability metadata used to enable or disable conversion actions.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) provides the shared `HarnessConfigScope`, `HarnessConfigFileRef`, and mirrored slice consumed by the Config page.
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) provides the persisted Tatsu config updated by the confirmed create that finalizes a draft.
- **DEP-007**: [Step 6](./step-06-transport-request-handlers.md) provides the two conversion channels, the result envelope, boundary validation patterns, and post-apply rescan semantics.
- **DEP-008**: [Step 7](./step-07-config-page-shell.md) provides the Config shell, create flow, dirty guards, list, editor, and smart/dumb boundary extended here.
- **DEP-009**: [Step 9](./step-09-sync-conflict-ux.md) provides the backend-session guard pattern and the conflict dialog this step must not alter.
- **DEP-010**: [Step 11](./step-11-tests.md) defines the skill-command generation cases (idempotency, alias returns, confirmation) that this step's tests must satisfy.

## 5. Files

- **FILE-001**: `src/main/harness-config/conversion.ts` — new pure generator module with `createCommandFromSkill`, `createSkillFromCommand`, and private slug/description helpers.
- **FILE-002**: `src/main/harness-config/types.ts` — `HarnessConfigConversionSource`, service draft shape, and shared result re-export.
 - **FILE-003**: `src/main/harness-config/harness-config.ts` — `prepareCommandFromSkill(scope, id)` / `prepareSkillFromCommand(scope, id)` alias/existing/draft resolution.
- **FILE-004**: `src/main/harness-config/index.ts` — barrel exports for the generators and conversion types.
- **FILE-005**: `src/main/harness-config/harness-config.test.ts` — generator, slug, alias, existing, draft, idempotency, and enforcement coverage.
- **FILE-006**: `src/shared/state/harness-config/types.ts` — `HarnessConfigConversionResult` and the `{ scope, id }` conversion request type.
- **FILE-007**: `src/main/harness-config-transport/harness-config-transport.ts` — conversion handler routing, validation, and apply-phase removal for the two channels.
- **FILE-008**: `src/main/harness-config-transport/harness-config-transport.test.ts` — conversion contract and rejection coverage.
- **FILE-009**: `src/renderer/types/types.ts` — updated conversion method return types.
- **FILE-010**: `src/renderer/build-backend/build-backend.ts` — conversion method mappings with the new result type.
- **FILE-011**: `src/renderer/components/Config/config-conversion.ts` — new pure conversion-outcome helper.
- **FILE-012**: `src/renderer/components/Config/config-conversion.test.ts` — outcome helper coverage.
- **FILE-013**: `src/renderer/components/Config/types.ts` — conversion action props and conversion create-mode fields.
- **FILE-014**: `src/renderer/components/Config/ConfigResourceList.tsx` — per-row conversion actions with disabled reasons.
- **FILE-015**: `src/renderer/components/Config/ConfigResourceList.test.ts` — conversion action derivation coverage.
- **FILE-016**: `src/renderer/components/Config/Config.tsx` — conversion orchestration, notices, and conversion create mode.
- **FILE-017**: `plans/skills-agents-command-center/step-02-main-process-harness-config-service.md` — TASK-010 reconciliation of conversion method names, no-overwrite wording, and draft semantics.
- **FILE-018**: `plans/skills-agents-command-center/step-06-transport-request-handlers.md` — TASK-010 reconciliation of the conversion request shape and apply-phase removal.

## 6. Testing

- **TEST-001**: Generator tests prove byte-exact command and skill templates, description extraction from a leading front-matter block, fallback description, and the trailing source-metadata comment.
- **TEST-002**: Slug tests prove lowercasing, invalid-character collapsing, trimming, 80-character truncation, label-over-name precedence, and `invalid-name` rejection.
- **TEST-003**: Bidirectional service alias tests prove Claude skill-to-command and command-to-skill actions both return the existing physical ref with the same stable identity/path, perform zero disk and Tatsu-config writes, and never create a duplicate physical resource.
- **TEST-004**: Existing-destination tests prove the derived destination is never overwritten, the existing ref is returned, and repeated conversion is idempotent.
- **TEST-005**: Draft tests prove correct destination layouts for supported non-alias conversions (including Codex `prompts/<name>.md` and OpenCode `commands/<name>.md`) with same-`agentKind` scopes; no Claude alias case may return a draft.
- **TEST-006**: Enforcement tests prove source-type mismatch, out-of-scope sources, config-only sources, `pi`, cross-harness destination fields, plugin/provenance fields, and extra authority fields are rejected without alias resolution, generation, copying, or writes.
- **TEST-007**: Transport tests prove the envelope carries the three result shapes, the two channels accept only `{ scope, id }`, only an explicit conversion request can dispatch either prepare method, sync-to-disk/adopt-from-disk/conflict/inventory paths never dispatch conversion, and a confirmed draft finalize triggers the standard post-apply rescan.
- **TEST-008**: Renderer tests prove the outcome helper's notice text and draft mapping, conversion action gating by capability/config-only rows/in-flight requests, explicit-action-only dispatch, alias-ref reuse without create mode, and no conversion on unrelated Tatsu-config, disk-inventory, conflict, sync/adopt, or plugin state changes.
- **TEST-009**: The Electron smoke proves the end-to-end explicit draft edit-and-save flow, both Claude alias directions without writes or duplicate resources, idempotent repeat, rejection of cross-harness/plugin copying, no automatic conversion during sync/adopt/conflict/inventory flows, and disabled unsupported conversions against disposable harness roots.
- **TEST-010**: `npx vitest run` on the targeted files, `pnpm typecheck`, and `pnpm build` all exit successfully.
- **TEST-011**: Identifier-declaration validation reports no duplicate TASK/GOAL declarations and no duplicate bullet-style declaration identifiers.
- **TEST-012**: Every relative Markdown link resolves to an existing plan or repository file, and this plan retains an explicit link to `implementation-details.md`.

## 7. Risks & Assumptions

- **RISK-001**: Two different sources can slug to the same destination name; the second conversion returns the first source's existing ref. The notice names the exact relative path so the user sees which file exists, and naming stays deterministic; no automatic suffixing is performed.
- **RISK-002**: Harness vendors may change command or skill file conventions. Generated shapes stay minimal (front-matter `description` plus body plus comment) so a vendor change requires updating one template in one module.
- **RISK-003**: If bidirectional alias resolution occurs after generation or only in one direction, a Claude create-command/create-skill action could create a separate physical file with a distinct ID, violating Step 1 REQ-017. REQ-009 and REQ-009a require alias resolution first and return the existing ref in both directions; both logical views may display the resource, but its stable identity/path remains singular.
- **RISK-004**: Steps 2 through 9 are not implemented at plan time. Implementation MUST follow the prerequisite-first assumption below and stop rather than invent substitutes.
- **RISK-005**: The source-metadata comment is informational only; generated files are never parsed back to recover provenance, so hand-edited comments cannot corrupt conversion behavior.
- **ASSUMPTION-001**: Steps 2 through 9 land first with the exact shared types, service methods, capability metadata, and Config surface declared in their plans; this step adds no compatibility aliases or partial local substitutes.
- **ASSUMPTION-002**: Step 2's injected dependency surface (clock, UUID, filesystem adapter, Tatsu-config callbacks) remains available; content generation itself needs none of them.
- **ASSUMPTION-003**: The explicit draft-submit click is the user confirmation for the resulting create, consistent with Step 1's operation matrix and Step 7's create confirmation.
- **ASSUMPTION-004**: Draft content reaches the renderer only through the conversion prepare response; no new shared-state field, event, or persistence field is required.

## 8. Related Specifications / Further Reading

- [Implementation details and product goals](./implementation-details.md)
- [Parent Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md)
- [Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)
- [Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)
- [Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)
- [Step 4: Shared state slice](./step-04-shared-state-slice.md)
- [Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)
- [Step 6: Transport request handlers](./step-06-transport-request-handlers.md)
- [Step 7: Config page shell](./step-07-config-page-shell.md)
- [Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)
- [Step 11: Tests](./step-11-tests.md)
- [Repository architecture and workflow rules](../../AGENTS.md)
