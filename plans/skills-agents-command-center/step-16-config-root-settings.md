---
goal: Let users choose the harness configuration folders and the template source folder in Settings
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Completed'
tags: [feature, settings, main-process, harness-config, templates]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan is Step 16 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md) and the first step of the template track (Steps 16 to 22). It wires the existing but unused `knownRoots` dependency of the harness config service to a persisted setting, so users can say where each harness keeps its agents, skills, and commands. It also adds the setting for the template source folder that [Step 18](./step-18-template-source-model.md) reads and writes. Terminology follows [implementation-details.md](./implementation-details.md).

Today `src/main/index.ts` constructs the service without `knownRoots`, so every root falls back to `defaultRoots()` in `src/main/harness-config/harness-config.ts`. Users whose configuration lives elsewhere see "The resolver known root is unavailable" with no way to fix it.

## 1. Requirements & Constraints

- **REQ-001**: Add `harnessConfigRoots: Partial<Record<HarnessConfigRootKey, string>>` to the `settings` slice. `HarnessConfigRootKey` is the closed union of resolver root keys: `claudeAgents`, `claudeSkills`, `claudeCommands`, `codexHome`, `codexSkills`, `opencodeAgents`, `opencodeSkills`, `opencodeCommands`.
- **REQ-002**: Add `harnessConfigSourceDir: string | null` to the `settings` slice. `null` means the default, `<userData>/harness-config-source`.
- **REQ-003**: Both values are shared state per [AGENTS.md](../../AGENTS.md): a second client of the same workspace must see the same folders. Follow the full "Adding a new piece of shared state" checklist, including `mergeWireSnapshot`.
- **REQ-004**: Export `HarnessConfigRootKey` and the root-key list from `src/shared/state/harness-config` so the service, the settings slice, and the UI share one definition. The service's `defaultRoots()` keys MUST be typed against it.
- **REQ-005**: The main-process request handler MUST reject a value that is not an absolute path. It MUST NOT require the folder to exist at save time; the service already reports a missing root as unavailable.
- **REQ-006**: An empty or cleared entry removes the override and restores the default for that key. The UI MUST show the effective default path as the placeholder.
- **REQ-007**: The service MUST read roots live. Replace the static `knownRoots` record with a getter (`knownRoots: () => Partial<Record<HarnessConfigRootKey, string>>`) that reads the current store settings, so a change applies without restart.
- **REQ-008**: Changing a root MUST trigger a rescan of every scope whose root key changed. Pending sync plans for those scopes become stale automatically because `resolverIdentity()` already hashes the resolved root.
- **REQ-009**: Explicit `opencode*` overrides MUST satisfy the existing `OPENCODE_CONFIG_DIR` guard: when the user sets an opencode root, `configured !== undefined` and the scope becomes available.
- **CON-001**: Do not add per-repository roots. Repo-local discovery remains an open resolver question in [Step 15](./step-15-open-questions.md).
- **CON-002**: This step does not change symlink handling; [Step 17](./step-17-symlink-aware-inventory.md) owns that.
- **SEC-001**: Root overrides widen where Tatsu may write. Writes stay limited to the resolved root plus the existing path-safety checks; the renderer still never supplies resource paths.
- **PAT-001**: Follow the existing settings reducer pattern in `src/shared/state/settings/settings.ts` and the existing Settings section layout in `src/renderer/components/Settings/Settings.tsx`.

## 2. Implementation Steps

### Implementation Phase 1: Shared state

- **GOAL-001**: Make both folder settings part of `AppState` and persisted config.

- [x] **TASK-001**: Add the root-key union and list to `src/shared/state/harness-config/types.ts` and export them from the barrel.
- [x] **TASK-002**: Add `harnessConfigRoots` and `harnessConfigSourceDir` to the settings `State`, initial state, events (`settings/harnessConfigRootsChanged`, `settings/harnessConfigSourceDirChanged`), and reducer.
- [x] **TASK-003**: Persist both fields in `src/main/persistence/types.ts` and seed them in `src/main/build-initial-state/build-initial-state.ts`. Drop unknown keys and non-absolute values when loading.
- [x] **TASK-004**: Add both fields to `mergeWireSnapshot` in `src/shared/state/index.ts`.

### Implementation Phase 2: Service and transport

- **GOAL-002**: Make the service resolve user-chosen roots live.

- [x] **TASK-005**: Change `HarnessConfigServiceDeps.knownRoots` to a getter and update `resolveRoot()` to call it. Update service tests that pass a static record.
- [x] **TASK-006**: In `src/main/index.ts`, pass `knownRoots: () => store.getState().settings.harnessConfigRoots`.
- [x] **TASK-007**: Add `settings:setHarnessConfigRoot` (`{ key, path | null }`) and `settings:setHarnessConfigSourceDir` (`path | null`) handlers. Validate, persist, dispatch, then rescan the affected scopes.
- [x] **TASK-008**: Add both methods to `ElectronAPI` in `src/renderer/types/types.ts`.

### Implementation Phase 3: UI

- **GOAL-003**: Let users see and change the folders.

- [x] **TASK-009**: Add a "Config folders" section to Settings with one path input per root key, grouped by harness, plus the template source folder. Show the default as placeholder, a reset button per row, and a "Choose…" button that uses the existing folder picker.
- [x] **TASK-010**: On the Config page, make the "known root is unavailable" message link to that Settings section.

## 3. Alternatives

- **ALT-001**: Keep roots in environment variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). Rejected as the only mechanism: they are invisible in the UI and apply to every tool on the machine. They remain the default when no override is set.
- **ALT-002**: One override for each harness's home folder instead of one per resource type. Rejected: real setups (including symlinked dotfiles) point individual resource folders at different places.
- **ALT-003**: Store roots in renderer `useState` or `localStorage`. Rejected: the main process needs them, and other clients must agree.

## 4. Dependencies

- **DEP-001**: [Step 2](./step-02-main-process-harness-config-service.md) service and its `knownRoots` dependency.
- **DEP-002**: [Step 4](./step-04-shared-state-slice.md) harness-config slice for the root-key type.
- **DEP-003**: [Step 6](./step-06-transport-request-handlers.md) rescan behavior.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/types.ts`, `index.ts` — root-key union.
- **FILE-002**: `src/shared/state/settings/settings.ts`, `types.ts`, `settings.test.ts` — new fields, events, tests.
- **FILE-003**: `src/shared/state/index.ts`, `src/shared/state/wire-merge.test.ts` — wire merge.
- **FILE-004**: `src/main/persistence/types.ts`, `src/main/persistence/persistence.ts`, `src/main/build-initial-state/build-initial-state.ts` — persistence and boot seeding.
- **FILE-005**: `src/main/harness-config/harness-config.ts`, `types.ts`, tests — live root getter.
- **FILE-006**: `src/main/index.ts` — handlers and service wiring.
- **FILE-007**: `src/renderer/types/types.ts`, `src/renderer/components/Settings/Settings.tsx`, `src/renderer/components/Config/Config.tsx` — UI.

## 6. Testing

- **TEST-001**: Reducer tests for both new events, including clearing a key.
- **TEST-002**: Wire-merge test: an old server snapshot without the fields yields the defaults.
- **TEST-003**: Service test: changing the getter's return value between two scans changes the scanned root and makes a previously generated plan stale.
- **TEST-004**: Service test: an explicit opencode override is honored while `OPENCODE_CONFIG_DIR` is set.
- **TEST-005**: Handler test: a relative path is rejected and nothing is dispatched.
- **TEST-006**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: A user points a root at a large or unrelated folder. The walker's `maxDepth` and resource patterns bound the scan; writes still need confirmation.
- **RISK-002**: Two root keys pointed at the same folder (for example Claude skills and Opencode skills) make a sync in one scope visible in the other. This is the user's explicit choice; the UI SHOULD warn when two keys resolve to the same path.
- **ASSUMPTION-001**: The existing folder picker request can be reused for directory selection.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 17: Symlink-aware inventory](./step-17-symlink-aware-inventory.md)

[Step 18: Template source model](./step-18-template-source-model.md)

[Repository architecture and workflow rules](../../AGENTS.md)
