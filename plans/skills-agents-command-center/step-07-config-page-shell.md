---
goal: Build the renderer Config page shell for harness agents, skills, and commands
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, renderer, react, harness-config, smart-dumb]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 7 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It adds the renderer-side Config page shell that lists Claude, Codex, and OpenCode agent definitions, skills, and commands; exposes safe create, edit, and delete flows through the typed active-backend API; and previews scoped disk-versus-Tatsu-config drift. It consumes the feature goals and source-of-truth rules in [implementation-details.md](./implementation-details.md), the shared state from Step 4, and the transport contract from Step 6. Steps 2 through 6 are planned prerequisites and are not present in the repository at plan time, so implementation of this step MUST begin only after their declared shared types, state integration, service, persistence, and renderer API outputs exist; this step MUST NOT backfill them or add compatibility aliases. Navigation entry points, confirmed sync/adopt resolution, and skill-command conversion remain follow-up work in Steps 8 through 10, so completing this plan does not complete the overarching feature.

The visual direction is a compact, utilitarian configuration workbench consistent with Tatsu's existing Settings and file-editor surfaces: a restrained title/tab toolbar, a grouped resource rail, and a full-height Monaco editor. The page MUST use existing semantic theme tokens and existing typography rather than introducing a separate visual system.

## 1. Requirements & Constraints

- **REQ-001**: Create the runtime package `src/renderer/components/Config/` with `index.ts`, `Config.tsx`, `ConfigTabs.tsx`, `ConfigResourceList.tsx`, `ConfigEditor.tsx`, `ConfigSyncDialog.tsx`, and `types.ts`; add one focused colocated `ConfigResourceList.test.ts` for deterministic list derivation.
- **REQ-002**: `Config.tsx` MUST be the smart component and the only Config-package module that calls `useBackend`, renderer store hooks, or harness-config backend methods. It owns selected tab, agent filter, search text, selected resource, create/edit mode, loaded content, saved content, local draft, logical create name, request state, operation feedback, and the open sync-preview plan.
- **REQ-003**: `ConfigTabs.tsx`, `ConfigResourceList.tsx`, `ConfigEditor.tsx`, and `ConfigSyncDialog.tsx` MUST be prop-driven presentational components. They MUST NOT import the renderer backend, renderer store, shared store singleton, or main-process code. UI-only behavior such as emitting input events, closing a dialog on Escape, and rendering passed status is allowed.
- **REQ-004**: `index.ts` MUST export `Config` as the package's public component and export only the public `ConfigProps` contract needed by Step 8. The list, editor, tabs, dialog, and their internal prop types remain package-internal.
- **REQ-005**: Add `useHarnessConfig()` to `src/renderer/store/store.ts` as `useAppState((state) => state.harnessConfig)`. `Config.tsx` MUST read inventory, sync plans, loading, error, and timestamps from that mirrored slice rather than maintaining a renderer-local copy of shared state.
- **REQ-006**: The page MUST expose exactly three tabs in the stable order `Agents`, `Skills`, `Commands`, mapped to the canonical shared `HarnessConfigResourceType` values `agents`, `skills`, and `commands`. Plugins are not a fourth tab.
- **REQ-007**: The agent filter MUST expose exactly `All`, `Claude`, `Codex`, and `Opencode`. It MUST map to `all | ManagedHarnessKind`, where managed kinds are `claude | codex | opencode`; it MUST NOT create a `pi` scope.
- **REQ-008**: Support and disabled behavior MUST come from `getAgentInfo(agentKind).configCapabilities` for the active resource type. The renderer MUST NOT infer capabilities from paths, installed directories, CLI availability, or agent-kind conditionals. If a managed harness/resource capability becomes unsupported, keep its harness group visible, disable Scan/Create/Sync/Edit/Delete for that group, and render its non-empty capability note.
- **REQ-009**: `Config.tsx` MUST use `useActiveBackend().id` as a page-session boundary and pair it with a monotonically increasing backend-session generation. When the active backend changes, immediately invalidate pending page-local work; clear selected resource, create/edit draft, request state, local operation feedback, open dialog state, and the per-session scanned-scope set; then load scopes from the newly active backend. Every asynchronous request chain MUST capture the initiating backend ID and generation, ignore page-local results after either changes, and stop before a later phase; in particular, a prepare response from one backend MUST never trigger an apply request after routing switches to another backend.
- **REQ-010**: On first display of a supported `{ agentKind, resourceType }` scope during the current page/backend session, call `scanHarnessConfig({ scope })`; after a successful scan, call `planHarnessConfigSync({ scope, direction: 'sync-to-disk' })` as a read-only comparison so drift badges can be derived. `All` scans the three visible managed harness scopes independently. Re-rendering or changing search text MUST NOT rescan an already loaded scope.
- **REQ-011**: Every read, create, update, delete, scan, and sync-plan request MUST use the exact selected `{ agentKind, resourceType }` scope and the typed Step 6 `ElectronAPI` method. No renderer action may broaden to every harness, use `reqLocal`, submit an absolute path, submit a destination harness, or call a generic filesystem API.
- **REQ-012**: The resource rail MUST render one group per visible managed harness in registry order and sort rows within a group by `relativePath`, then `id`. Group headers MUST display the existing `AgentIcon`, harness display name, scoped Create action, and scoped Sync action.
- **REQ-013**: The displayed rows for a scope MUST combine disk-backed refs from `harnessConfig.resources[activeTab]` with every public ref for that exact scope in the latest plan at `harnessConfigScopeKey(scope)`: `diskOnly`, `configOnly`, and both `disk` and `config` sides of `changed`. Deduplicate by `agentKind + id`, prefer the disk-backed ref when both sides exist, exclude refs outside the active logical scope, and never create a second physical row for a Claude skill alias already represented in the current logical view.
- **REQ-014**: Search MUST be case-insensitive, trim surrounding whitespace, and match `label`, `relativePath`, or display-only `absolutePath`. Search filters rows inside each visible harness group; it MUST NOT change the selected scope, perform backend requests, or hide an unsupported-capability explanation.
- **REQ-015**: Every row MUST show exactly one inline drift badge: `Synced`, `Disk only`, `Config only`, or `Conflict`. Derive `Conflict` from membership in `plan.changed`, `Disk only` from `plan.diskOnly`, `Config only` from `plan.configOnly`, and `Synced` otherwise. A scope-level `conflict` status MUST NOT incorrectly mark every unchanged row as conflicting.
- **REQ-016**: Selecting a disk-backed row MUST call `readHarnessConfigFile({ scope, id })`, then store the returned content only in local editor state. Guard the asynchronous response with a monotonically increasing request token or equivalent cancellation so a slow response cannot replace a newer selection's draft.
- **REQ-017**: A config-only row MUST remain visible but read-only because Step 6 does not expose persisted desired content through `readHarnessConfigFile`. The editor MUST explain that the user must resolve/sync the scope before the file can be edited on disk. It MUST NOT send an update or delete request for a ref with `existsOnDisk: false`.
- **REQ-018**: `ConfigEditor` MUST show the selected resource's normalized absolute path in a read-only, selectable field. That path is display metadata only and MUST never be included in a mutation request. Create mode instead shows a logical-name field and a resolver-neutral explanation that the main process chooses the final path.
- **REQ-019**: Clicking a group's Create action MUST enter create mode for that exact supported scope, clear any selected resource, and initialize empty logical-name and content drafts. Submitting the editor's `Create` action MUST call `createHarnessConfigFile` first with `{ phase: 'prepare', scope, name, content }`, then call the same method with `{ phase: 'apply', scope, planId, confirmed: true }` only when preparation succeeds. The explicit Create submission is the user confirmation for a brand-new file.
- **REQ-020**: Saving an existing disk-backed resource MUST require an explicit `window.confirm` that identifies the file and states that Tatsu creates a backup before overwrite. After confirmation, call `updateHarnessConfigFile` with the prepare payload `{ phase: 'prepare', scope, id, content }`, then apply the returned plan through the same method with `{ phase: 'apply', scope, planId, confirmed: true }`.
- **REQ-021**: Deleting an existing disk-backed resource MUST require an explicit `window.confirm` that identifies the file and states that Tatsu creates a backup before removal. After confirmation, call `deleteHarnessConfigFile` with `{ phase: 'prepare', scope, id }`, then apply the returned plan through the same method with `{ phase: 'apply', scope, planId, confirmed: true }`.
- **REQ-022**: Create, update, and delete MUST be non-optimistic. Do not insert, patch, or remove shared inventory locally. Treat each `HarnessConfigRequestResult` envelope as authoritative for the initiating action and let Step 6's post-apply rescan update the mirrored slice. After successful direct mutation, request a fresh read-only sync plan for each affected logical scope so badges do not retain the pre-mutation comparison.
- **REQ-023**: After successful create, select the resulting ref for the active logical view when the apply result provides one; otherwise clear the editor and let the refreshed list drive the next selection. After successful update, reload the selected file through `readHarnessConfigFile` and reset the saved-content baseline. After successful delete, clear selection and editor state.
- **REQ-024**: Preserve file-level alias identity. When a Claude skill appears in the Commands tab, requests MUST retain the current logical Commands scope and the ref's stable physical `id`; the renderer MUST NOT rewrite the ID, invent a second desired resource, or canonicalize the request into another harness. Step 6 owns canonical/alias refresh.
- **REQ-025**: Track editor dirtiness as `draft !== savedContent` in edit mode and as a non-empty name or content in create mode. Before tab changes, agent-filter changes that would remove the active scope, resource changes, entering create mode, or closing the page, require a discard confirmation when dirty. Canceling the confirmation leaves the current editor and selection unchanged. An externally initiated active-backend change cannot be canceled from this page; clear the old backend's draft immediately so it can never be submitted to the new backend.
- **REQ-026**: `ConfigEditor` MUST use the existing `MonacoEditor` with `filePath` set to the selected absolute path or a synthetic `<name>.md` display path in create mode, `onChange` bound to the local draft, and font family/size set from `useSettings().terminalFontFamily` and `useSettings().terminalFontSize`. Pass `onSave` only when the parent marks the editor actionable, and have the smart save/create handler re-check actionability because Monaco's Cmd/Ctrl-S command invokes its callback independently of the `readOnly` option. Editing and mutation buttons MUST be disabled while content is loading, a request is active, the capability is unsupported, or the selected ref is config-only.
- **REQ-027**: The Sync action MUST always generate a fresh `sync-to-disk` comparison for the exact group scope. If the returned plan is `synced`, keep the dialog closed and render an inline success notice. If it has drift, open `ConfigSyncDialog` with that plan. Step 7's dialog is a read-only preview that displays scope, status, and counts for disk-only/config-only/changed entries and provides only Close/Cancel behavior; Step 9 adds the confirmed Sync-to-disk and Adopt-from-disk outcomes and detailed conflict review.
- **REQ-028**: Closing or dismissing `ConfigSyncDialog` MUST be a no-op for disk and Tatsu config. It MUST never call `syncHarnessConfigToDisk` or `adoptHarnessConfigFromDisk` in this step, and pressing Enter MUST NOT apply a plan.
- **REQ-029**: Surface safe request-envelope errors beside the relevant editor or dialog action and surface the shared slice error in the page shell. Never render file content, stack traces, backup bytes, or arbitrary thrown objects as an error message. A later successful request may clear local feedback for that action but MUST NOT fabricate success from shared-state timing.
- **REQ-030**: Use semantic HTML and keyboard behavior: the resource tabs use `role="tablist"`, `role="tab"`, and `aria-selected`; resource rows are keyboard-focusable buttons; icon-only controls have accessible labels; inputs have visible or programmatic labels; disabled controls expose the capability explanation; the sync preview uses `role="dialog"`, `aria-modal="true"`, Escape-to-close, backdrop dismissal, initial focus on Close, and focus restoration to the invoking Sync control.
- **REQ-031**: Follow renderer sizing rules exactly. Text classes are restricted to `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-2xl`, and `text-3xl`. Lucide and `AgentIcon` instances use `icon-*` classes; no Lucide `size` prop or raw `w-N h-N` icon sizing is allowed. Monaco's pixel font-size prop remains an allowed editor exception.
- **REQ-032**: Use only existing semantic theme utilities, including `bg-app`, `bg-panel`, `bg-panel-raised`, `bg-surface`, `bg-surface-hover`, `text-fg`, `text-fg-bright`, `text-muted`, `text-dim`, `text-faint`, `text-success`, `text-warning`, `text-danger`, `text-info`, `text-accent`, and matching existing border tokens. Do not add Config-specific global CSS, a new font, a new color token, gradients, decorative card framing, or a runtime dependency.
- **REQ-033**: The page layout MUST be full-height and min-size safe: a Settings-style title bar and tab/filter/search toolbar above a two-pane body, a fixed-width scrollable resource rail, and a `min-w-0 min-h-0` editor pane so Monaco resizes without overflowing. The presentational components own the detailed JSX; `Config.tsx` should only compose them and pass render-ready props/callbacks.
- **SEC-001**: Renderer values are never filesystem authority. The renderer may submit only scope, stable resource ID, logical create name, draft content, prepared plan ID, phase, and confirmation as allowed by Step 6.
- **SEC-002**: No mutation may skip prepare/apply, reuse a plan across channels or scopes, or send `confirmed: true` before the explicit Create/Save/Delete user gate described above.
- **CON-001**: The delivered change MUST NOT modify `src/renderer/App/App.tsx`, `src/renderer/components/Sidebar/Sidebar.tsx`, or onboarding/home components. Step 8 owns overlay visibility and navigation entry points; TASK-016's temporary development-only mount MUST be removed before verification and commit.
- **CON-002**: Do not implement `syncHarnessConfigToDisk`, `adoptHarnessConfigFromDisk`, detailed conflict resolution, stale-plan reconfirmation, or sync-direction action buttons in this step. Step 9 owns those behaviors.
- **CON-003**: Do not call or render `createHarnessConfigCommandFromSkill` or `createHarnessConfigSkillFromCommand` in this step. Step 10 owns conversion generation, generated-draft review, and alias no-op behavior.
- **CON-004**: Do not add main-process handlers, filesystem access, persistence logic, state events, reducer cases, preload wiring, or duplicated transport/domain types. Steps 2 through 6 are prerequisites and remain authoritative. Because their outputs are absent from the repository at plan time, stop implementation rather than inventing local substitutes if any declared prerequisite symbol or typed backend method is still missing when this step begins.
- **GUD-001**: Keep the four presentational modules small and focused. Shared domain types come from `src/shared/state/harness-config` and `src/shared/agent-registry`; `types.ts` defines only renderer-local view models and prop contracts.
- **PAT-001**: Follow the package/barrel convention used throughout `src/renderer/components/`: Step 8 imports `Config` through `src/renderer/components/Config`, and no code outside the package deep-imports an implementation file.
- **PAT-002**: Follow the existing Settings title-bar, CommandPalette search/list, ResolveRepoModal dialog, AgentIcon, and MonacoEditor interaction patterns without copying their business logic or creating a second generic component system.

## 2. Implementation Steps

### Implementation Phase 1: Define renderer contracts and store access

- **GOAL-001**: Establish browser-safe view models, public package boundaries, and one renderer hook for the shared harness-config slice.

- [ ] **TASK-001**: Create `src/renderer/components/Config/types.ts` using canonical imports from `src/shared/agent-registry` and `src/shared/state/harness-config`.
  - Define `ConfigProps { onClose: () => void }`.
  - Define `ConfigAgentFilter = 'all' | ManagedHarnessKind`, `ConfigEditorMode = 'empty' | 'create' | 'edit'`, and `ConfigDriftBadge = 'synced' | 'disk-only' | 'config-only' | 'conflict'`.
  - Define render-ready `ConfigResourceRow` and `ConfigResourceGroup` view models containing the shared ref/plan/capability objects plus derived badge, selected, disabled, and explanatory values; do not restate any shared domain object field-by-field.
  - Define exact prop interfaces for the four presentational components, including all labels, disabled/busy state, data, and callbacks required by REQ-003 and REQ-030.
- [ ] **TASK-002**: Add `useHarnessConfig()` to `src/renderer/store/store.ts` beside the other whole-slice hooks.
  - Return `useAppState((state) => state.harnessConfig)` directly so snapshot reference identity remains stable.
  - Do not add a second subscription path, renderer reducer, context, or local cache; `src/renderer/store/index.ts` already re-exports `store.ts`.
- [ ] **TASK-003**: Create `src/renderer/components/Config/index.ts`.
  - Export `Config` from `./Config` and `ConfigProps` from `./types`.
  - Keep `ConfigTabs`, `ConfigResourceList`, `ConfigEditor`, `ConfigSyncDialog`, list-derivation helpers, and internal prop types unexported from the package barrel.

### Implementation Phase 2: Build prop-driven Config surfaces

- **GOAL-002**: Implement the tabs, grouped resource rail, editor, and read-only sync preview as pure rendering surfaces with no backend or store ownership.

- [ ] **TASK-004**: Implement `ConfigTabs.tsx` as the page title and toolbar surface.
  - Render the Settings-style drag-region title row with Back/Close and `Config` title, then the three ARIA tabs in REQ-006.
  - Render a labeled agent-filter control for All/Claude/Codex/Opencode and a controlled search field with Search and clear icons.
  - Emit only `onClose`, `onTabChange`, `onAgentFilterChange`, and `onSearchChange`; leave dirty-state gating to `Config.tsx`.
  - Use stable button/input labels and preserve Escape for the smart component's close guard rather than closing independently.
- [ ] **TASK-005**: Implement deterministic list derivation and rendering in `ConfigResourceList.tsx`.
  - Export a package-internal `buildConfigResourceGroups` helper for the focused test. Accept one typed object containing the active `HarnessConfigResourceType`, `ConfigAgentFilter`, normalized query, the active view's `HarnessConfigFileRef[]`, `HarnessConfigState['syncPlans']`, an exact `{ scope, id } | null` selection, and the managed `AgentInfo[]` registry entries. Produce registry-ordered groups and sorted/deduplicated rows as required by REQ-012 through REQ-015; merge refs from `diskOnly`, `configOnly`, and both sides of `changed` before filtering search results.
  - Render every visible harness header with `AgentIcon`, display name, scope-level status, Create, and Sync. Disable actions and render notes for unsupported capabilities.
  - Render resource buttons with label, relative path, selected styling, and one exact drift badge. Use success for Synced, warning for Disk only, info for Config only, and danger for Conflict.
  - Render a per-group empty state with a Create button when search is empty and no resources exist; render `No matching resources` without a Create duplicate when a non-empty search removes all rows.
  - Keep loading/error decisions in props and invoke callbacks with exact scope/ref values rather than reconstructing them from DOM data attributes.
- [ ] **TASK-006**: Implement `ConfigEditor.tsx` around the existing `MonacoEditor`.
  - Render explicit empty, loading, unsupported, config-only, create, and edit states from props.
  - In create mode, render the controlled logical-name input, read-only target-scope label, Monaco editor, Cancel, and Create buttons.
  - In edit mode, render selected label, read-only absolute path, drift badge, Monaco editor, dirty indicator, Delete, Reset/Cancel, and Save buttons.
  - Pass the parent callbacks straight through; do not compare content, call confirmation APIs, invoke backend methods, infer capability, or alter resource identity.
  - Ensure Cmd/Ctrl-S reaches the provided save callback only when the parent marks the editor actionable; pass `undefined` to Monaco and keep the parent handler guarded when the editor is loading, busy, unsupported, config-only, clean, or otherwise non-actionable.
- [ ] **TASK-007**: Implement `ConfigSyncDialog.tsx` as the read-only Step 7 preview.
  - Render the exact scope's harness display name, resource label, plan status, and counts for `diskOnly`, `configOnly`, and `changed`.
  - Render Close as the only footer action. Move focus to Close when the dialog opens, restore focus to the invoking Sync control when it closes, and make Escape and backdrop click call `onClose`; Enter performs no action.
  - Do not import or call sync/adopt methods and do not render disabled future-action placeholders. Step 9 will extend this component with the three product outcomes.

### Implementation Phase 3: Orchestrate scoped loading and editing

- **GOAL-003**: Connect the Config workbench to the active backend and mirrored slice while preserving exact scope, confirmation, draft, and alias boundaries.

- [ ] **TASK-008**: Implement the smart component state and derived view models in `Config.tsx`.
  - Dependency: GOAL-001 and GOAL-002.
  - Read `useBackend`, `useHarnessConfig`, `useSettings`, and `useActiveBackend`; initialize the page to Agents, All, no search, and no selected resource.
  - Keep only per-client UI state locally. Derive resource groups with `buildConfigResourceGroups`; do not copy shared resource or plan maps into `useState`.
  - Track the selected identity as exact scope plus ID, editor mode, returned ref, draft/saved content, logical create name, editor read/mutation busy and safe-error state, per-scope scan/comparison busy-error-notice maps keyed by `HarnessConfigScopeKey`, open sync plan, read request token, a backend-session generation ref, and a per-backend set of scopes scanned in the current page session.
- [ ] **TASK-009**: Implement initial scoped scan/comparison and active-backend reset behavior.
  - Dependency: TASK-008.
  - For each newly visible supported scope, issue `scanHarnessConfig` and, only on its success, issue the read-only `planHarnessConfigSync` comparison required by REQ-010. Use `Promise.allSettled` or independent tasks so one harness failure does not hide successful groups; do not issue either request for an unsupported capability.
  - Mark a scope scanned only after its scan request settles; retain its request error visibly and allow the group's Sync action to retry a fresh comparison.
  - On active backend change, increment the backend-session generation before clearing page-local editor/dialog/request state and the scanned-scope set. Capture backend ID plus generation at the start of scans, comparisons, reads, and mutations; after every `await`, ignore the result and stop the chain when either no longer matches. Load the new backend's visible scopes without reusing an old selection, draft, feedback, or plan object.
- [ ] **TASK-010**: Implement dirty-state guards, tab/filter/search behavior, and selection reads.
  - Dependency: TASK-009.
  - Search changes never trigger the discard guard or backend work. Tab, filter, selection, create-mode, and close transitions use one guard that calls `window.confirm` only when the current editor is dirty.
  - Clear selection/create state after an accepted tab change. Preserve selection on an agent-filter change only when the selected harness remains visible; otherwise clear it after accepted discard.
  - On disk-row selection, increment the read token, capture the backend ID/generation, enter loading state, call `readHarnessConfigFile`, and apply the result only if the backend session, token, and exact selected identity still match. Set returned content as both draft and saved baseline.
  - On config-only selection, skip the read request and pass the read-only explanation from REQ-017 to `ConfigEditor`.
  - When a mirrored inventory refresh removes the selected disk ref, clear selection without attempting to read or mutate the missing ID.
- [ ] **TASK-011**: Implement direct create and update handlers with exact prepare/apply sequencing.
  - Dependency: TASK-010.
  - Create requires a non-empty trimmed logical name, passes that trimmed name to the backend, and sends draft content byte-for-byte without trimming or normalization; empty content is allowed because the Step 6 contract accepts any string. Then execute the two `createHarnessConfigFile` phases from REQ-019.
  - Update is a no-op when the draft equals the saved baseline. Otherwise show the backup confirmation from REQ-020, execute the two `updateHarnessConfigFile` phases, and stop immediately on a failed result envelope.
  - Disable duplicate submission while either phase is pending. Capture exact scope, resource ID/name, backend ID, and backend generation before prepare; after every response envelope, re-check the session before updating feedback or issuing apply. Never retain a prepared plan after cancellation, scope change, backend change, or a failed apply.
  - On success, follow REQ-022 and REQ-023: wait for the transport request, use `HarnessConfigApplyResult.resultingRefs` only to choose a ref matching the current logical scope, select/reload it when present, and otherwise clear the editor. Request a new scoped comparison for every affected logical scope without mutating local inventory.
- [ ] **TASK-012**: Implement confirmed delete and read-only sync-preview handlers.
  - Dependency: TASK-010.
  - Delete shows the backup/removal confirmation, then executes the prepare/apply `deleteHarnessConfigFile` sequence from REQ-021. Apply the same backend-session checks before apply and before consuming either response. Clear the editor only after a successful apply result; retain the draft and safe envelope error when preparation or application fails in the same session.
  - Sync always captures the exact group scope and backend session, then calls a fresh `planHarnessConfigSync({ scope, direction: 'sync-to-disk' })`. Ignore stale-session results; otherwise show a success notice for `synced` or store the returned plan in local dialog state.
  - Closing the preview clears only the local open-dialog state. Do not call either sync/adopt apply method in Step 7.
- [ ] **TASK-013**: Compose `ConfigTabs`, `ConfigResourceList`, `ConfigEditor`, and conditional `ConfigSyncDialog` in `Config.tsx`.
  - Dependency: TASK-011 and TASK-012.
  - Keep composition JSX limited to the full-height shell and two-pane layout from REQ-033; pass render-ready props and callbacks to the four presentational components.
  - Give local action errors precedence beside the initiating control while retaining the shared slice error as a page-level status.
  - Add an Escape listener that returns when `event.defaultPrevented` is true or the target is an input, textarea, select, contenteditable element, or Monaco control; otherwise route through the dirty close guard only while the sync dialog is closed. The dialog owns Escape while open.

### Implementation Phase 4: Prove renderer behavior and deliver

- **GOAL-004**: Verify grouped drift presentation, exact scope routing, editor safety, visual integration, and desktop/web bundle compatibility without pulling later feature steps into this change.

- [ ] **TASK-014**: Create `src/renderer/components/Config/ConfigResourceList.test.ts` with focused pure-data tests for `buildConfigResourceGroups`.
  - Dependency: TASK-005.
  - Prove managed harness group order, exact agent filtering, case-insensitive label/relative/absolute path search, deterministic row sorting, and visible empty groups.
  - Prove refs from `diskOnly`, `configOnly`, and both sides of `changed` appear even when absent from scan inventory; disk refs win same-ID deduplication; changed membership alone produces Conflict; and unrelated rows remain Synced even when the overall scope plan is conflict.
  - Prove a Claude alias retains one stable ID in the active logical view, refs from another logical scope are excluded, and an unsupported capability remains visible with disabled actions and its note.
- [ ] **TASK-015**: Run `npx vitest run src/renderer/components/Config/ConfigResourceList.test.ts`, then run `pnpm typecheck` and `pnpm build`.
  - Dependency: TASK-013 and TASK-014.
  - Resolve every failure without duplicating shared contracts, weakening scope checks, using deep imports, or adding renderer-only shared-state mutations.
- [ ] **TASK-016**: Smoke-test the actual renderer surface before finalizing the step.
  - Dependency: TASK-015.
  - Temporarily mount `Config` from the package barrel as the desktop root in `src/renderer/App/App.tsx`, launch `pnpm dev` with `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, and `OPENCODE_CONFIG_DIR` pointed at temporary fixture directories, and inspect the real Electron renderer at default and increased `uiScale` values. The temporary root mount and fixture paths are development-only and MUST NOT enter the delivered diff.
  - Exercise all three tabs, All and individual agent filters, search/clear, harness-group empty states, row selection/read, create-mode entry/cancel, dirty-discard cancellation, Cmd/Ctrl-S gating, and read-only sync preview. Do not confirm Create/Save/Delete; no smoke action may write to real or fixture harness directories.
  - Verify keyboard tab order, focus visibility/restoration, Escape/backdrop behavior, Enter no-op in the preview, long absolute paths, narrow-window overflow, Monaco resizing, semantic theme contrast, and that every icon scales with `uiScale`.
  - Remove the temporary App mount and temporary fixture directories after the smoke, then rerun `pnpm typecheck` plus `pnpm build` so the delivered tree retains the Step 8 navigation boundary.
- [ ] **TASK-017**: Review the final change against Steps 3, 4, 6, 8, 9, and 10.
  - Dependency: TASK-016.
  - Verify capability support comes only from registry metadata; shared inventory/plans remain store-owned; file content remains request-local; all mutation requests use exact typed prepare/apply payloads; display paths are never submitted; aliases retain service-issued IDs; and every async chain stops when its captured backend session becomes stale.
  - Verify no Config code calls sync/adopt apply or conversion methods, no delivered navigation source changed, no new global CSS/dependency was added, and no disallowed text/icon sizing appears.
  - Run the identifier and relative-link validation described in TEST-007 and TEST-008 before committing.
- [ ] **TASK-018**: Commit the Config package, renderer hook, and focused list test with message `feat: add harness config page shell`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Dependency: TASK-017.
  - Do not include the temporary smoke mount or unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Keep a renderer-local copy of inventories and update it optimistically after mutations. Rejected because the main process owns shared state, post-apply rescans are authoritative after partial failures, and a second client must observe the same inventory.
- **ALT-002**: Build one monolithic `Config.tsx` containing backend calls, list rendering, editor markup, and dialogs. Rejected because the requested smart/dumb split requires business orchestration in the smart component and prop-driven rendering in focused components.
- **ALT-003**: Expose one global Sync button for all harnesses in the active tab. Rejected because every plan and mutation is scoped by both `agentKind` and `resourceType`, and first-version sync requires separate confirmation per harness.
- **ALT-004**: Read or mutate resources by the absolute path shown in the editor. Rejected because renderer paths are display metadata, not filesystem authority; Step 6 accepts only validated scope and stable IDs/logical names.
- **ALT-005**: Hide config-only resources because they are absent from disk scan results. Rejected because they are real Tatsu desired state, must carry a Config only badge, and are necessary for an accurate drift preview even though Step 6 cannot read their content for editing.
- **ALT-006**: Implement the full Sync-to-disk/Adopt-from-disk dialog and conversion buttons in this step. Rejected because Steps 9 and 10 own those behaviors and require additional stale-plan, generated-draft, and confirmation contracts.
- **ALT-007**: Add React Testing Library or another UI dependency for the shell. Rejected because the high-risk list derivation can be tested as a pure function with existing Vitest, while the actual Electron smoke verifies layout and interaction without expanding the dependency surface.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, three resource views, disk-versus-Tatsu-config model, and backup caveat. Its early statement that Commands syncs the skills directory is superseded by the exact scoped resolver and transport contracts in Steps 2 and 6.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines the managed harness boundary, explicit mutation gates, scope isolation, conflict semantics, backup requirement, and Claude alias rule.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) is a not-yet-implemented prerequisite that must provide stable file identity, resolver behavior, plan generation, prepare/apply mutation semantics, backups, stale-plan rejection, and post-apply results before Step 7 begins.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) is a not-yet-implemented prerequisite that must export `HarnessConfigResourceType`, `AgentConfigCapability`, and required `AgentInfo.configCapabilities` rows through `src/shared/agent-registry`; the current registry does not contain them.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) is a not-yet-implemented prerequisite that must add the content-free `harnessConfig` slice with `resources`, `syncPlans`, `loading`, `error`, `lastScannedAt`, and `lastSyncedAt`; export `ManagedHarnessKind`, `HarnessConfigScope`, `HarnessConfigFileRef`, `HarnessConfigSyncPlan`, and `harnessConfigScopeKey`; and wire the slice into `AppState`, events, reducers, initial state, and wire-snapshot merging. None of those symbols exist in the current tree.
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) is a not-yet-implemented prerequisite that must persist the canonical desired-resource records consumed by Step 6 and represented as config-side refs in sync plans; Step 7 does not read persisted config directly.
- **DEP-007**: [Step 6](./step-06-transport-request-handlers.md) is a not-yet-implemented prerequisite that must add the ten one-object `ElectronAPI` methods and active `buildBackend` mappings. Step 7 uses scan `{ scope }`, read `{ scope, id }`, plan `{ scope, direction }`, and create/update/delete prepare/apply unions, each returning the canonical `Promise<HarnessConfigRequestResult<T>>`; it MUST NOT create fallback methods if those contracts are absent.
- **DEP-008**: `src/renderer/components/MonacoEditor/` provides the controlled editor, file-path language detection, read-only option, and Cmd/Ctrl-S callback. Its save command calls `onSave` independently of `readOnly`, so Step 7 must gate both the callback and smart handler.
- **DEP-009**: `src/renderer/components/AgentIcon/`, `src/shared/agent-registry/`, `src/renderer/backend/`, and `src/renderer/store/` provide existing icons, display metadata, active-backend request routing, and mirrored state access. `useActiveBackend().id` exists now; `useHarnessConfig()` is added by this step after the Step 4 slice exists.
- **DEP-010**: [Step 8](./step-08-navigation-entry-points.md) will mount `Config` as per-client overlay state and add Sidebar/home entry points after this package exists.
- **DEP-011**: [Step 9](./step-09-sync-conflict-ux.md) will extend `ConfigSyncDialog` and `Config.tsx` with detailed differences, fresh direction-specific plans, confirmed Sync-to-disk/Adopt-from-disk application, stale-plan recovery, and Cancel no-op behavior.
- **DEP-012**: [Step 10](./step-10-skill-command-conversion.md) will add same-harness conversion actions and generated-draft review without changing Step 7's identity or capability boundaries.

## 5. Files

- **FILE-001**: `src/renderer/components/Config/index.ts` — public package barrel exporting the smart Config component and public props.
- **FILE-002**: `src/renderer/components/Config/Config.tsx` — smart orchestration, backend requests, page-local selection/drafts, confirmations, and component composition.
- **FILE-003**: `src/renderer/components/Config/ConfigTabs.tsx` — title row, tabs, agent filter, and resource search rendering.
- **FILE-004**: `src/renderer/components/Config/ConfigResourceList.tsx` — deterministic group/row derivation and grouped resource rail rendering.
- **FILE-005**: `src/renderer/components/Config/ConfigEditor.tsx` — empty/create/edit/read-only editor states around MonacoEditor.
- **FILE-006**: `src/renderer/components/Config/ConfigSyncDialog.tsx` — read-only scoped drift preview for Step 7.
- **FILE-007**: `src/renderer/components/Config/types.ts` — renderer-local view models and presentational prop contracts.
- **FILE-008**: `src/renderer/components/Config/ConfigResourceList.test.ts` — pure list/search/group/drift derivation regression coverage.
- **FILE-009**: `src/renderer/store/store.ts` — `useHarnessConfig()` selector hook over the active backend's mirrored slice.

## 6. Testing

- **TEST-001**: Focused list tests prove exact managed-harness grouping/filtering, deterministic ordering, search fields, and unsupported-capability visibility.
- **TEST-002**: Drift tests prove refs from every plan difference collection are merged into the visible list, disk refs win same-ID deduplication, badges reflect per-resource membership rather than scope status, out-of-scope refs are excluded, and Claude aliases retain one physical ID.
- **TEST-003**: `npx vitest run src/renderer/components/Config/ConfigResourceList.test.ts` exits successfully.
- **TEST-004**: `pnpm typecheck` exits successfully across main, preload, renderer, shared, and web-client TypeScript projects.
- **TEST-005**: `pnpm build` exits successfully for desktop main/preload/renderer and the web client, proving Config imports remain browser-safe.
- **TEST-006**: The temporary real-renderer smoke in TASK-016 verifies tabs, filters, search, scoped groups, editor states, dirty guards, gated Cmd/Ctrl-S, read-only sync preview, focus restoration, keyboard behavior, theme tokens, overflow, and `uiScale` icon/text scaling; the temporary App mount and fixture roots are absent from the delivered diff.
- **TEST-007**: Run a declaration-aware identifier scan over this plan and confirm duplicate TASK/GOAL table declarations and duplicate bullet-style declaration identifiers both produce zero rows.
- **TEST-008**: Validate every relative Markdown link in this plan resolves to an existing file and confirm the plan retains an explicit link to `implementation-details.md`.

## 7. Risks & Assumptions

- **RISK-001**: Step 4's scanned resource arrays contain disk inventory, so config-only resources would disappear if the renderer used only `resources`. REQ-013 requires merging refs from the latest scoped plan without copying content into state.
- **RISK-002**: Auto-comparison creates process-local plans that are not applied. Limit comparison to first scope display, direct-mutation refresh, and explicit Sync clicks; always generate a fresh plan on Sync and never assume an older preview remains applicable.
- **RISK-003**: The slice exposes global loading/error fields rather than per-scope request state. `Config.tsx` therefore needs small local busy/error state for the initiating control while treating the shared fields as page-wide backend status.
- **RISK-004**: A delayed response can overwrite a newer selection or mutate page-local state after an active-backend switch; a two-phase chain can be worse by preparing on one backend and applying on another because `useBackend()` routes each call lazily. REQ-009 requires every async chain to capture backend ID/generation, re-check after every await, and stop stale work before apply or local state updates; REQ-016 adds the narrower read-token and selected-identity checks.
- **RISK-005**: A config-only desired resource cannot be edited because Step 6 intentionally keeps desired content out of shared state and exposes read-by-disk-ID only. Step 7 renders it read-only; Step 9's confirmed sync/adopt flow is the supported resolution path.
- **RISK-006**: Claude skills may appear in both Skills and Commands while native Claude commands also exist. Treat file refs and their canonical/alias metadata as authoritative; capability-level alias metadata alone is insufficient to identify an individual alias row.
- **ASSUMPTION-001**: Implementation begins only after Steps 2 through 6 land and expose the exact shared contracts and renderer method names declared in their plans. The current repository does not contain those outputs, and Step 7 does not add compatibility aliases or partial local substitutes.
- **ASSUMPTION-002**: `HarnessConfigApplyResult.resultingRefs` contains enough public ref metadata to select a newly created resource when available. If it is empty, the renderer safely clears the editor and relies on Step 6's authoritative rescan.
- **ASSUMPTION-003**: The Step 1 confirmation matrix is authoritative: the Create submission itself confirms a non-destructive new-file creation, while update and delete require an additional explicit confirmation before apply.
- **ASSUMPTION-004**: Config is initially a desktop overlay reached through Step 8, but all Step 7 imports and request routing remain compatible with the remote web client and active-backend switching.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)

[Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)

[Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)

[Step 4: Shared state slice](./step-04-shared-state-slice.md)

[Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)

[Step 6: Transport request handlers](./step-06-transport-request-handlers.md)

[Step 8: Navigation entry points](./step-08-navigation-entry-points.md)

[Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)

[Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)

[Step 11: Tests](./step-11-tests.md)

[Repository architecture and workflow rules](../../AGENTS.md)
