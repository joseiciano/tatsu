---
goal: Implement scoped sync conflict review, confirmation, and stale-plan recovery in the Config page
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, renderer, react, harness-config, sync, conflict-ux]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 9 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It turns Step 7's read-only drift preview into the explicit conflict-resolution boundary defined by [implementation-details.md](./implementation-details.md): users review disk-only, config-only, and content-changed files for one `${agentKind}:${resourceType}` scope, then choose exactly one outcome: `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, or `Cancel` without mutation.

This step completes the first-version sync conflict UX, including fresh direction-specific planning, confirmed apply requests, safe stale-plan recovery, detailed file metadata, and non-optimistic success/error handling. It does not complete the larger feature: Step 10 still owns skill-command conversion, while Step 11 retains end-to-end coverage across the service, persistence, transport, shared state, and renderer. At plan time, the runtime `src/renderer/components/Config/` package and harness-config contracts are prerequisites declared by Steps 2 through 8 rather than files already present in the repository; implementation MUST begin only after those prerequisite contracts exist.

The visual direction remains Step 7's compact, utilitarian configuration workbench. The dialog is an operational diff review, not a decorative modal: dense but readable file groups, explicit source labels, restrained status color, and clear consequence copy must make the selected scope and mutation direction unambiguous.

## 1. Requirements & Constraints

- **REQ-001**: Every conflict comparison, confirmed plan, dialog instance, and request MUST be scoped to exactly one `HarnessConfigScope` containing one managed `agentKind` (`claude | codex | opencode`) and one logical `resourceType` (`agents | skills | commands`). Store and retrieve every comparison and plan by the `${agentKind}:${resourceType}` scope key from Step 4 (`harnessConfigScopeKey`), never by resource type alone and never as an unscoped or global current value. No action may broaden mutation to another harness, another resource type, `pi`, or an `all` scope.
- **REQ-002**: Clicking a harness group's Sync action MUST call non-authorizing `compareHarnessConfig({ scope })` for that exact group. A returned `HarnessConfigComparison` with `status: 'synced'` MUST keep the dialog closed and show an inline `Already in sync` notice; any drift status MUST open `ConfigSyncDialog` with that comparison. The comparison has no `planId`, direction, fingerprint, or apply authority and MUST never be sent to a mutation method.
- **REQ-003**: The dialog footer MUST expose exactly these three user outcomes: `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel`. There is no fourth action. The close icon, Escape key, and backdrop dismissal invoke the same no-op cancellation path as `Cancel`; they are alternate controls for that outcome, not additional outcomes.
- **REQ-004**: `ConfigSyncDialog` MUST group every conflict entry into exactly one of three difference categories in stable order: `disk-only`, `config-only`, and `content-changed`. Render them under the headings `Disk only`, `Config only`, and `Content changed`. Each section MUST show its count and an explicit empty state when its list is empty so the user can review the complete scoped comparison; refs inside config-only rows use `Tatsu config` as their source label.
- **REQ-005**: Sort disk-only and config-only rows by `relativePath`, then `id`. Sort content-changed pairs by the disk `relativePath`, then config `relativePath`, then physical `id`. Rendering MUST NOT mutate or re-sort arrays stored in the shared comparison or plan object.
- **REQ-006**: Every entry in all three groups MUST carry and display the originating harness and logical resource type from the review's exact `${agentKind}:${resourceType}` scope; never infer either value from the active tab or a global selection. Every row MUST also display `label`, root-relative `relativePath`, source (`Disk` or `Tatsu config`), last-modified time, and SHA-256 metadata from its `HarnessConfigFileRef`.
- **REQ-007**: Format a finite non-negative `updatedAt` with `new Date(updatedAt).toLocaleString()`. Render `Modified time unavailable` for a non-finite, negative, or invalid timestamp. Render the hash visually as `sha256:<first 12 characters>` while exposing the complete hash in the element's `title` and accessible label; never recompute a hash or request file content in the renderer.
- **REQ-008**: Content-changed entries MUST render the disk ref and Tatsu config ref as two explicitly labeled sides of one row so differing hashes and timestamps can be compared without implying that either side has already won.
- **REQ-009**: The dialog MUST explain both directions before the action controls. Sync to disk creates config-only files, overwrites content-changed disk files, and removes disk-only files, with service-owned backups before overwrite/delete. Adopt from disk replaces only the selected Tatsu config scope, including adding disk-only entries, replacing content-changed desired content, and removing config-only desired entries; it performs no harness-directory writes.
- **REQ-010**: `Config.tsx` MUST remain the smart component. It alone reads `useBackend`, `useActiveBackend`, registry capability metadata, and shared store hooks and invokes harness-config backend methods. `ConfigSyncDialog.tsx` MUST remain presentational and receive render-ready scope labels, comparison sections, busy/error/notice state, and callbacks through props.
- **REQ-011**: Extend Step 7's local open-dialog React state with an explicit stage (`idle | planning | applying`), action error, action notice, and review usability. Store the monotonically increasing action token and other non-rendered request bookkeeping in `useRef`, not `useState`. The main-owned mirrored slice holds only disk inventory, comparisons, loading, error, and scan/sync timestamps; it never mirrors a confirmed plan. `HarnessConfigSyncPlan` is a request-scoped, main-bound response (per step-04 REQ-007 and DEP-009): obtain it freshly from a direction-specific planner, keep it in the dialog's request-scoped state/refs, and never copy it into or derive it from shared state.
- **REQ-012**: Clicking either mutation outcome MUST request a fresh direction-bound confirmed plan for the displayed comparison's exact scope. `Sync Tatsu config to disk` calls `planHarnessConfigSyncToDisk({ scope })`; `Adopt current disk files into Tatsu config` calls `planHarnessConfigAdoptFromDisk({ scope })`. Never synthesize a plan from the comparison, use one planner for the opposite outcome, or treat `compareHarnessConfig` as mutation authority.
- **REQ-013**: Add a package-internal pure `configSyncReviewKey(review)` helper that accepts either `HarnessConfigComparison` or `HarnessConfigSyncPlan` and produces one deterministic review key from the review's `${agentKind}:${resourceType}` scope, status, and sorted public difference refs. Include every public `HarnessConfigFileRef` field on disk-only/config-only refs and both sides of content-changed pairs; sort `aliasResourceTypes` before serialization. Deliberately exclude comparison/plan envelope fields—`comparedAt`, `planId`, `direction`, `generatedAt`, and opaque `fingerprint`—so a direction-bound plan can match the non-authorizing comparison the user reviewed when the visible conflict is identical, while the main service remains authoritative for stale fingerprint enforcement.
- **REQ-014**: Apply only when a freshly generated direction-bound plan has drift and `configSyncReviewKey(freshPlan) === configSyncReviewKey(displayedReview)`. Any new scan that changes either the disk inventory side or the Tatsu config side of the compared scope MUST invalidate the displayed review. Applying after invalidation is blocked until the review is regenerated, displayed, and explicitly reconfirmed. If the fresh plan is synced, close the dialog and show `Already in sync` without sending an apply request. If the review keys differ, replace the displayed review with the fresh plan's public comparison data, discard that plan's apply authority, show `Files changed. Review the refreshed plan and choose an action again.`, return to `idle`, and send no apply request; the next click MUST generate another direction-bound plan.
- **REQ-015**: For a review-equivalent fresh plan, call exactly one matching apply method with `{ scope: freshPlan.scope, planId: freshPlan.planId, confirmed: true }`: `syncHarnessConfigToDisk` only after `planHarnessConfigSyncToDisk`, or `adoptHarnessConfigFromDisk` only after `planHarnessConfigAdoptFromDisk`. Do not submit the comparison, fingerprint, paths, refs, operations, content, or a renderer-constructed plan.
- **REQ-016**: Treat every plan as single-use. Disable both mutation actions while planning or applying, never retain a plan for replay after an apply attempt, and never retry an apply request automatically.
- **REQ-017**: When an apply request fails, preserve its original safe `error.message` as the action error and request one fresh non-authorizing `compareHarnessConfig({ scope })` because the failed operation may have partially applied and Step 6 has already performed authoritative rescans. If recovery comparison returns drift, replace the consumed plan with that comparison, require another explicit direction-button click and a new direction-bound plan, and retain the original apply error above the refreshed review. If it returns synced, close the dialog and report the apply error plus `A fresh comparison now reports this scope is in sync.`; do not claim the apply succeeded. If recovery comparison also fails, keep the dialog open, mark the consumed plan unusable, disable mutation actions, and instruct the user to Cancel and start Sync again.
- **REQ-018**: A `stale-plan` or `unknown-plan` error, including a plan lost after process restart or already consumed, follows the same non-authorizing comparison, regeneration, and reconfirmation path as any apply failure. Recovery comparison MUST NOT create apply authority, and regeneration MUST NOT silently apply the replacement plan.
 - **REQ-019**: A successful apply MUST close the dialog, clear dialog-local error state, and show direction-specific inline feedback for the exact scope: `Synced <Harness> <Resource> to disk` or `Adopted current disk <Resource> into Tatsu config`. Do not optimistically patch resources, drift badges, plans, or `lastSyncedAt`; Step 6's post-apply rescan and `comparisonLoaded` event remain authoritative.
- **REQ-020**: `Cancel`, close-icon, Escape, and backdrop dismissal in `idle` or `planning` MUST be mutation no-ops: invalidate the current action token, clear only dialog-local state, and send no apply, scan, sync, adopt, persistence, or filesystem request. If dismissal occurs while direction-specific planning is in flight, token checks after the await MUST prevent the subsequent apply call. Once the apply request has been dispatched, set stage `applying` and disable all dismissal controls until it settles because the renderer cannot cancel an in-progress main-process mutation.
- **REQ-021**: Check the action token, active backend ID, open-dialog identity, scope, and chosen direction after every awaited comparison/planner/apply/recovery request before issuing a later request or committing local UI state. A backend change MUST invalidate pending dialog work and clear the dialog immediately; an apply already dispatched remains an explicitly confirmed operation against the backend to which it was sent, but its late response MUST NOT update the new backend's UI.
- **REQ-022**: Sync actions and dialog mutation actions MUST stay disabled when the registry capability for the exact harness/resource pair is unsupported. Capability support and notes come only from `getAgentInfo(agentKind).configCapabilities`; the renderer MUST NOT infer support from paths, installed CLIs, or agent-kind conditionals.
- **REQ-023**: Preserve Claude physical alias identity. A Claude skill reviewed from the Commands tab retains the logical Commands scope and the service-issued physical `id`; the dialog and handlers MUST NOT duplicate, canonicalize, or apply the resource through another logical or harness scope.
- **REQ-024**: `ConfigSyncDialog` MUST use `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, and `aria-describedby`. Initial focus MUST move to Cancel as the safe default, focus MUST remain within the dialog while open, and closing MUST restore focus to the invoking Sync button when it still exists.
- **REQ-025**: There MUST be no global Enter-to-apply shortcut. Native Enter/Space activation is allowed only when one of the two action buttons itself has focus. Escape and backdrop follow REQ-020, and every icon-only close control requires an accessible label.
- **REQ-026**: The dialog body MUST be bounded by the viewport and independently scrollable, content-changed rows MUST stack at narrow widths without horizontal page overflow, long paths/hashes MUST wrap or truncate with full metadata accessible, and footer actions MUST remain visible. Verify default and increased `uiScale` values.
- **REQ-027**: Follow repository sizing and theme rules. Text classes are restricted to `text-xs`, `text-sm`, `text-base`, `text-lg`, `text-2xl`, and `text-3xl`; Lucide icons use `icon-*` utilities; styling uses existing semantic background, border, foreground, success, warning, danger, info, and accent tokens. Add no Config-specific global CSS, font, gradient, or dependency.
- **REQ-028**: Surface only shared safe request-envelope messages. Never render arbitrary thrown objects, stack traces, file contents, backup bytes, executable operations, or opaque fingerprints. Absolute paths remain display metadata elsewhere in the editor and MUST NOT be added to an apply request.
- **SEC-001**: A renderer action is never filesystem authority. `HarnessConfigComparison` is observation-only. The only mutation authority sent by this step is the exact fresh plan's `scope`, `planId`, and literal `confirmed: true` through the apply method paired with the direction-specific planner that created it.
- **SEC-002**: No mutation may occur from initial comparison, dialog open, dialog render, action hover/focus, Enter outside a focused action button, Cancel, close, Escape, backdrop dismissal, stale-plan regeneration, or backend switching.
- **CON-001**: Add no main-process handler, service behavior, persistence field, shared-state field/event, preload method, transport method, runtime dependency, or development dependency. Steps 2 through 6 already own these contracts and invariants.
- **CON-002**: Do not modify navigation ownership in `src/renderer/App/App.tsx`, `src/renderer/components/Sidebar/Sidebar.tsx`, or onboarding/home components. Step 8 owns how the Config overlay opens and closes.
- **CON-003**: Do not implement skill-command conversion controls, plugin management, cross-harness copying, repository-local resources, or Pi config management. Those concerns remain outside Step 9.
- **GUD-001**: Use the product terms `disk inventory`, `Tatsu config`, `sync to disk`, `adopt from disk`, `conflict`, and `confirmed plan` consistently in component copy and tests.
- **GUD-002**: Every disk-only, config-only, and content-changed conflict entry carries the originating harness and logical resource type so the user can identify the exact `${agentKind}:${resourceType}` mutation scope.
- **PAT-001**: Follow the established smart/dumb package boundary from Step 7 and the modal shell interaction pattern in `src/renderer/components/ResolveRepoModal/ResolveRepoModal.tsx`, while adding the stronger ARIA, focus, and no-global-Enter requirements in this plan.

## 2. Implementation Steps

### Implementation Phase 1: Define review and dialog contracts

- **GOAL-001**: Establish deterministic, renderer-local review models and comparison helpers without duplicating shared harness-config domain types.

- [ ] **TASK-001**: Update `src/renderer/components/Config/types.ts` with Step 9's renderer-local contracts.
  - Extend `ConfigSyncDialogProps` with the exact `${agentKind}:${resourceType}`-keyed, non-authorizing displayed review (either the returned `HarnessConfigComparison` or a render-only projection of a discarded `HarnessConfigSyncPlan`), harness/resource display labels, pre-sorted disk-only/config-only/content-changed view models, `stage`, `reviewUsable`, action error/notice, `onSyncToDisk`, `onAdoptFromDisk`, and `onCancel`.
  - Define only render-ready wrappers around shared `HarnessConfigComparison`, `HarnessConfigSyncPlan`, `HarnessConfigFileRef`, and `HarnessConfigChangedRef`; stamp every entry with its originating harness and logical resource type from the review scope, but do not restate shared domain fields or export these internal types from `src/renderer/components/Config/index.ts`.
  - Keep backend methods, plan IDs, fingerprints, and store state out of the presentational prop contract.
- [ ] **TASK-002**: Create `src/renderer/components/Config/config-sync-review.ts` as a package-internal pure helper module.
  - Implement immutable category sorting from REQ-005, `configSyncReviewKey(review)` from REQ-013, timestamp formatting from REQ-007, conversion of either shared review shape into render-ready sections, and removal of plan authority when a review-different plan becomes the next displayed review.
  - Add a pure decision function that returns exactly `already-synced`, `review-refreshed-plan`, or `apply-fresh-plan` from a displayed review and successful fresh direction-bound plan; `apply-fresh-plan` is possible only when the plan has drift and its review key equals the displayed review key.
  - Keep all helpers browser-safe and free of React hooks, backend access, store access, filesystem APIs, and module-level mutable caches.
- [ ] **TASK-003**: Update Step 7's Config package internal imports to consume `config-sync-review.ts` directly within the package.
  - Preserve `src/renderer/components/Config/index.ts` as the public `Config`/`ConfigProps` barrel only.
  - Do not expose comparison keys, dialog sections, or internal dialog props to App, Sidebar, or other packages.

### Implementation Phase 2: Build the detailed conflict review surface

- **GOAL-002**: Replace the read-only count preview with an accessible, scoped conflict review that communicates both source states and both possible mutation directions.

- [ ] **TASK-004**: Extend `src/renderer/components/Config/ConfigSyncDialog.tsx` to render the full review.
  - Render a header naming the exact harness and resource label, a concise generated-time/status summary, and consequence copy for both directions from REQ-009.
  - Render `Disk only`, `Config only`, and `Content changed` sections in that order with counts, explicit empty states, and rows built from TASK-002; label refs in config-only rows as sourced from `Tatsu config`.
  - Repeat the originating harness and logical resource type on every entry. For content-changed rows, render paired `Disk` and `Tatsu config` metadata blocks; never fetch or display file content.
- [ ] **TASK-005**: Replace Step 7's single Close footer with exactly the three outcomes from REQ-003 and no fourth action.
  - Render buttons labeled exactly `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel`. Wire them only to props. The dialog MUST NOT import `useBackend`, the renderer store, registry helpers, or main-process modules.
  - Keep all three controls visible during planning/applying, disable only the two mutation controls (`Sync Tatsu config to disk` and `Adopt current disk files into Tatsu config`) whenever stage is not `idle` or `reviewUsable` is false, and expose the current operation with an accessible busy label.
  - Keep Cancel, the close icon, Escape dismissal, and backdrop dismissal enabled at all times except while stage is `applying`, when REQ-020 disables them until the apply settles; Cancel must remain enabled in `idle` (including `reviewUsable: false`) and during `planning` so it can invalidate the pending direction-specific planner continuation.
- [ ] **TASK-006**: Implement modal focus and keyboard behavior in `ConfigSyncDialog.tsx`.
  - On mount, remember the previously focused element and focus Cancel. Trap Tab/Shift+Tab among enabled dialog controls, restore focus on unmount when the prior element remains connected, and clean up listeners.
  - Add the dialog ARIA relationships from REQ-024 and an `aria-live="polite"` status region for refreshed-review, busy, success-adjacent, and safe error messages.
  - Do not register an Enter handler. Stop backdrop propagation at the dialog panel and route allowed Escape/backdrop dismissals only through `onCancel`.

### Implementation Phase 3: Orchestrate fresh planning and confirmed application

- **GOAL-003**: Connect the dialog outcomes to current, direction-bound plans while preventing stale, cross-scope, duplicate, canceled, or optimistic mutations.

- [ ] **TASK-007**: Extend `src/renderer/components/Config/Config.tsx` with the Step 9 dialog state machine.
  - Track the displayed conflict review together with its `${agentKind}:${resourceType}` scope key, plus stage, review usability, local dialog error/notice, and chosen direction as per-client React state. Reject any comparison or plan whose computed key differs from the open dialog key. Keep the action token, current dialog identity, and active-backend request identity in refs because they are race-control bookkeeping rather than render inputs.
  - Continue deriving shared disk inventory, comparisons, loading, errors, and timestamps from `useHarnessConfig()`; do not copy those values into a local cache. The shared slice contains no plans: every confirmed plan is freshly requested from its direction-specific planner (TASK-009) and held only in the dialog's request-scoped state/refs, never derived from shared state.
  - Reset and invalidate dialog state on scope replacement, accepted page close, and active-backend change, preserving Step 7's dirty-editor guards independently from the dialog.
- [ ] **TASK-008**: Retain and harden the group Sync entry handler in `Config.tsx`.
  - Always request a fresh non-authorizing `compareHarnessConfig({ scope })` for the clicked supported group and capture the invoking button for focus restoration.
  - On `synced`, close any previous dialog for that scope and show `Already in sync`; on drift, construct sections from TASK-002 and open the dialog with the returned `HarnessConfigComparison`.
  - Treat the request result envelope as authoritative, show only its safe error message, and never open a dialog from a stale comparison or from any plan held in shared state, because shared state never mirrors plans (REQ-011).
- [ ] **TASK-009**: Implement one outcome-dispatching fresh-plan handler in `Config.tsx`.
  - On either mutation action click, capture the current token/backend/dialog identity, set stage `planning`, clear only the prior action notice/error, and call exactly one planner with the exact displayed scope: `planHarnessConfigSyncToDisk({ scope })` for sync to disk or `planHarnessConfigAdoptFromDisk({ scope })` for adopt from disk.
  - After the await, enforce every identity/token check in REQ-021 and apply TASK-002's pure decision to the displayed review and returned direction-bound plan.
  - Close with an already-synced notice, strip authority and replace/reconfirm a review-different plan, or advance a review-equivalent fresh plan to TASK-010; no comparison or other branch may call an apply method.
- [ ] **TASK-010**: Implement confirmed direction-matched application in `Config.tsx`.
  - Set stage `applying` immediately before dispatch. Call `syncHarnessConfigToDisk` only for a fresh plan from `planHarnessConfigSyncToDisk`, or `adoptHarnessConfigFromDisk` only for a fresh plan from `planHarnessConfigAdoptFromDisk`, passing the fresh `scope`, fresh `planId`, and `confirmed: true`.
  - Prevent a second submission while the promise is pending. Do not use a comparison, reuse the displayed review's prior plan ID, use any plan that was not freshly returned by the matching direction-specific planner, or pass renderer-derived metadata.
  - On success, close the dialog and emit the exact direction-specific notice from REQ-019 while relying on Step 6 events for disk inventory, comparison, badge, and timestamp updates.
- [ ] **TASK-011**: Implement consumed/stale/partial-failure recovery in `Config.tsx`.
  - Preserve the original apply error, mark the attempted plan unusable, and request one non-authorizing `compareHarnessConfig({ scope })` without generating or applying another plan.
  - Handle refreshed drift, refreshed synced state, and recovery-comparison failure exactly as specified in REQ-017 and REQ-018.
  - Require a new explicit action click and a new matching direction planner for every replacement review, including recovery from `stale-plan` and `unknown-plan`; never loop, automatically regenerate/apply, or replace the original apply error with a refresh error.
- [ ] **TASK-012**: Implement no-op cancellation, dismissal, and late-response guards.
  - Cancel in `idle` closes immediately. Cancel in `planning` increments the action token before closing so the planning continuation cannot apply. Applying cannot be dismissed until its request settles.
  - Route the close icon, Escape, and backdrop dismissal through the same path as Cancel. Invalidate pending work on backend change and ignore late state/results belonging to the prior backend or dialog identity.
  - Keep every cancellation or dismissal path a renderer-only mutation no-op: do not issue a comparison, planner, apply, scan, persistence, or filesystem request and do not alter disk inventory or Tatsu config.
- [ ] **TASK-013**: Compose the enhanced dialog from `Config.tsx` without moving rendering into the smart component.
  - Pass render-ready sections, labels, stage, `reviewUsable`, error/notice, and callbacks into `ConfigSyncDialog`.
  - Keep `Config.tsx` JSX limited to Step 7's page composition and conditional dialog mount; keep detailed rows, metadata, consequence copy, focus behavior, and action button markup in `ConfigSyncDialog.tsx`.

### Implementation Phase 4: Prove behavior and deliver

- **GOAL-004**: Verify detailed review rendering, observation-only comparison, direction-specific confirmed planning, cancellation, stale recovery, exact scope routing, and real renderer usability before committing.

- [ ] **TASK-014**: Create `src/renderer/components/Config/config-sync-review.test.ts` with focused pure behavioral coverage.
  - Use complete `${agentKind}:${resourceType}`-keyed `HarnessConfigComparison` and `HarnessConfigSyncPlan` fixtures with deterministic IDs, paths, hashes, aliases, and timestamps across disk-only, config-only, and content-changed groups.
  - Prove category sorting, content-changed-pair ordering, originating harness/resource attribution, timestamp/hash formatting, and immutability of input comparisons and plans.
  - Prove `comparedAt`/direction/planId/generatedAt/fingerprint-only changes remain review-equivalent, while a change from a new scan to either the disk inventory side or Tatsu config side—including scope, status, category membership, ref identity, path, hash, timestamp, managed/existence flag, canonical type, alias, or displayed label—invalidates the displayed review and requires regeneration and reconfirmation.
  - Prove the decision function blocks apply for `synced`, stale, or review-different plans; discards authority from a review-different plan; and returns `apply-fresh-plan` only for a review-equivalent plan returned by the selected direction-specific planner.
- [ ] **TASK-015**: Create `src/renderer/components/Config/ConfigSyncDialog.test.tsx` using the existing React/ReactDOM and Vitest dependencies only.
  - Render representative props to static markup and assert the observable dialog contract: the exact `${agentKind}:${resourceType}` scope, originating harness/resource on every entry, all three named groups and counts, paired content-changed sides, last-modified/hash metadata, safe error/status region, ARIA dialog relationships, and exactly the three outcome labels from REQ-003 with no fourth action.
  - Keep keyboard/focus/action sequencing out of source-text assertions; verify those interactions in TASK-017 against the actual renderer.
  - Add no Testing Library, DOM shim, snapshot package, or other dependency.
- [ ] **TASK-016**: Run focused automated verification.
  - Run `npx vitest run src/renderer/components/Config/config-sync-review.test.ts src/renderer/components/Config/ConfigSyncDialog.test.tsx src/renderer/components/Config/ConfigResourceList.test.ts`.
  - Run `pnpm typecheck` and `pnpm build` after the focused tests.
  - Resolve every failure without duplicating shared contracts, weakening scope/confirmation checks, adding deep cross-package imports, or suppressing type errors.
- [ ] **TASK-017**: Smoke-test the actual Config surface in Electron against disposable harness roots and app data.
  - Launch `pnpm dev` with a temporary home/config environment so no real user harness file or persisted Tatsu config can be modified. Seed one supported resolver scope with disk-only, config-only, and content-changed fixtures using the exact layouts implemented by Step 2.
  - Exercise Sync's observation-only compare and already-synced paths, detailed three-group review, both direction-specific planners, both paired apply methods, and Cancel/close/Escape/backdrop mutation no-op behavior. While the dialog is displayed, change the disk inventory side and the Tatsu config side in separate scans; prove each stale review/plan is blocked, regenerated, and cannot apply until the refreshed review is explicitly reconfirmed through a new direction-specific plan. Also cover cancellation during planning, disabled dismissal during applying, safe apply failure, and successful post-event badge/list refresh.
  - Switch active backends with a comparison, plan request, or dialog pending and verify late responses cannot update or apply against the new backend UI. Exercise a Claude skill alias from Commands and confirm it retains one physical identity and the exact Commands scope.
  - Verify focus starts on Cancel and returns to the invoking Sync button, Tab remains trapped, Enter outside a focused action never applies, long paths/hashes remain usable, narrow-window scrolling works, semantic contrast is clear, and default/increased `uiScale` values scale canonical text/icons together.
  - Remove all disposable fixtures and any temporary development instrumentation after the smoke; rerun `pnpm typecheck` and `pnpm build` if source was temporarily instrumented.
- [ ] **TASK-018**: Review the final Step 9 change against its prerequisite and follow-up boundaries.
  - Verify every conflict comparison, confirmed plan, and sync/adopt request preserves its exact `${agentKind}:${resourceType}` scope key; compare never creates apply authority; each outcome uses only its matching direction-specific planner/apply pair; every new scan that changes either side invalidates the displayed review and requires regeneration/reconfirmation; cancellation and modal dismissal perform no mutation; and no optimistic shared-state update exists.
  - Verify no main/shared/transport/navigation/conversion code changed, no unsupported capability became actionable, no alias was duplicated, no content or opaque fingerprint is rendered, and only safe error messages reach the dialog.
  - Run declaration-aware identifier validation and relative-link validation for this plan before committing.
- [ ] **TASK-019**: Commit the renderer conflict UX and focused tests as one change with message `feat: add harness config sync conflict UX`, then run `git push origin <current-branch>` immediately after the commit succeeds.
  - Include only the Step 9 runtime/test files and any necessary internal Config type updates; do not include disposable smoke fixtures, temporary instrumentation, or unrelated working-tree changes.

## 3. Alternatives

- **ALT-001**: Apply the initial `HarnessConfigComparison` directly when the user clicks an outcome. Rejected because a comparison is deliberately non-authorizing and contains no direction binding, plan ID, or fingerprint.
- **ALT-002**: Generate a direction-bound plan and always apply it immediately. Rejected because drift may have changed after the user reviewed the dialog; review-key comparison and reconfirmation prevent mutation of unseen differences.
- **ALT-003**: Compare opaque fingerprints to decide whether the reviewed comparison is unchanged. Rejected because comparisons have no fingerprint and plan fingerprints are intentionally opaque and direction-specific; the renderer compares only complete public review data while the service independently enforces authoritative fingerprints.
- **ALT-004**: Prepare both sync-to-disk and adopt-from-disk plans when the dialog opens. Rejected because the initial review is observation-only, either process-local plan can become stale before selection, unnecessary plans consume memory/bindings, and each clicked outcome still needs a current direction-specific plan.
- **ALT-005**: Automatically retry an apply after `stale-plan` or `unknown-plan`. Rejected because a replacement plan has not been reviewed or confirmed and may describe different files.
- **ALT-006**: Close the dialog immediately on every apply failure. Rejected because partial multi-file application can change the inventory; an explicit refreshed review makes the resulting state visible without hiding the primary error.
- **ALT-007**: Update resource rows and drift badges optimistically after apply. Rejected because Step 6 rescans after success and partial failure, Claude aliases can refresh multiple logical views, and only the main-owned store can provide an authoritative result to every client.
- **ALT-008**: Add a global Sync All action. Rejected because first-version plans are isolated by harness and resource type and every harness requires its own explicit confirmation.
- **ALT-009**: Add a new modal library or React test library. Rejected because the existing component patterns, ReactDOM server rendering, Vitest, and actual Electron smoke are sufficient for this focused step without dependency weight.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the feature goal, disk inventory versus Tatsu config source-of-truth rules, conflict requirement, explicit mutation boundary, and backup caveat.
- **DEP-002**: [Step 1](./step-01-product-boundary-source-of-truth.md) defines exact scope isolation, the three outcomes, visible conflict categories, current confirmed plans, stale invalidation, cancellation as a no-op, alias identity, and no cross-harness actions.
- **DEP-003**: [Step 2](./step-02-main-process-harness-config-service.md) provides direction-specific plan generation, stable refs and hashes, timestamps, backups, single-use/stale plan enforcement, apply results, and partial-apply semantics.
- **DEP-004**: [Step 3](./step-03-harness-capability-metadata.md) provides the managed resource union, supported capability matrix, labels/notes, and Claude alias metadata through the shared registry barrel.
- **DEP-005**: [Step 4](./step-04-shared-state-slice.md) provides `HarnessConfigScope`, `HarnessConfigFileRef`, `HarnessConfigChangedRef`, scope keying, mirrored inventory and non-authorizing comparisons, loading/error state, and `lastScannedAt`/`lastSyncedAt` semantics. `HarnessConfigSyncPlan` is a request/response DTO only: confirmed, direction-bound plans remain request-scoped and main-bound and are never mirrored in shared state (per step-04 REQ-007 and DEP-009).
- **DEP-006**: [Step 5](./step-05-persist-tatsu-managed-config.md) provides durable Tatsu config desired state and exact scoped replacement for adopt from disk.
- **DEP-007**: [Step 6](./step-06-transport-request-handlers.md) provides typed active-backend `compareHarnessConfig`, `planHarnessConfigSyncToDisk`, `planHarnessConfigAdoptFromDisk`, and paired apply methods; safe result envelopes and error codes; direction/scope bindings; post-attempt rescans; and post-success fresh-comparison events.
- **DEP-008**: [Step 7](./step-07-config-page-shell.md) provides `Config.tsx`, `ConfigSyncDialog.tsx`, renderer-local `types.ts`, the smart/dumb boundary, group Sync entry point, local operation feedback, shared slice hook, and Config visual system.
- **DEP-009**: [Step 8](./step-08-navigation-entry-points.md) mounts Config as per-client overlay state and provides real Sidebar/home access for the smoke test.
- **DEP-010**: `src/renderer/components/ResolveRepoModal/ResolveRepoModal.tsx` provides the existing modal/backdrop/Escape styling pattern; this step strengthens it with ARIA, focus containment/restoration, and no global Enter apply.
- **DEP-011**: `src/renderer/backend/` and `src/renderer/store/` provide active-backend request routing and the per-backend mirrored store; Step 9 must preserve backend-session isolation.
- **DEP-012**: Step 10 consumes the completed Config surface for skill-command conversion without changing Step 9's scoped sync contract.

## 5. Files

- **FILE-001**: `src/renderer/components/Config/types.ts` — extend renderer-local comparison/plan review models and callback/busy/error contracts.
- **FILE-002**: `src/renderer/components/Config/config-sync-review.ts` — new package-internal immutable sorting, formatting, comparison/plan review-key, authority-stripping, and fresh-plan decision helpers.
- **FILE-003**: `src/renderer/components/Config/ConfigSyncDialog.tsx` — detailed accessible conflict review and the three prop-driven outcomes.
- **FILE-004**: `src/renderer/components/Config/Config.tsx` — smart compare/direction-plan/paired-apply/recovery/cancellation orchestration and backend/scope race guards.
- **FILE-005**: `src/renderer/components/Config/config-sync-review.test.ts` — pure comparison/plan review-equivalence, sorting, formatting, and decision coverage.
- **FILE-006**: `src/renderer/components/Config/ConfigSyncDialog.test.tsx` — observable static rendering and accessibility-contract coverage.
- **FILE-007**: `src/renderer/components/Config/ConfigResourceList.test.ts` — existing Step 7 focused tests rerun to guard drift badges and grouped Sync behavior; modify only if Step 9 changes an observable list contract.

## 6. Testing

- **TEST-001**: Review-model tests prove deterministic immutable ordering and complete metadata formatting across `HarnessConfigComparison` and `HarnessConfigSyncPlan` for the disk-only, config-only, and content-changed groups, including originating harness and logical resource type on every entry.
- **TEST-002**: Review-equivalence tests change the disk inventory side and Tatsu config side independently and prove each new scan invalidates the displayed review; stale apply is blocked until a regenerated review is displayed and explicitly reconfirmed through a new direction-specific plan.
- **TEST-003**: Decision tests prove a comparison has no apply authority; synced, stale, and review-different plans never apply; authority is discarded from review-different plans; and only a review-equivalent fresh drift plan reaches the apply branch.
- **TEST-004**: Dialog rendering tests prove exact `${agentKind}:${resourceType}` identity, all three named groups/counts, paired content-changed sides, timestamp/hash information, safe error/status output, ARIA relationships, and exactly `Sync Tatsu config to disk`, `Adopt current disk files into Tatsu config`, and `Cancel` with no fourth action.
- **TEST-005**: Actual renderer smoke proves `compareHarnessConfig` is observation-only; each outcome invokes its matching direction-specific planner before its paired apply method; apply requests carry exact scope/fresh plan ID/literal confirmation; stale reviews/plans are blocked and regenerate without auto-apply; duplicate submission is blocked; and post-apply state comes from main events.
- **TEST-006**: Race coverage in the smoke proves Cancel, close-icon, Escape, and backdrop dismissal are mutation no-ops; comparison/planning cancellation, backend switching, scope replacement, and late results cannot apply or update the wrong dialog/backend; applying cannot be dismissed after dispatch.
- **TEST-007**: Failure smoke proves the original safe apply error survives recovery, recovery uses a non-authorizing comparison, refreshed drift requires another click and matching direction planner, refreshed synced state is not reported as apply success, and recovery-comparison failure leaves the consumed plan disabled.
- **TEST-008**: Accessibility/visual smoke proves safe initial focus, focus containment/restoration, no global Enter apply, no-op Escape/backdrop dismissal, viewport-bounded scrolling, narrow content-changed-row stacking, semantic contrast, and canonical `uiScale` behavior.
- **TEST-009**: Alias/scope smoke proves a Claude skill shown from Commands retains its stable physical ID and Commands scope and no request reaches another harness/resource scope.
- **TEST-010**: `npx vitest run src/renderer/components/Config/config-sync-review.test.ts src/renderer/components/Config/ConfigSyncDialog.test.tsx src/renderer/components/Config/ConfigResourceList.test.ts` exits successfully.
- **TEST-011**: `pnpm typecheck` exits successfully across desktop, preload, renderer, shared, and web-client TypeScript projects.
- **TEST-012**: `pnpm build` exits successfully for desktop and web-client bundles, proving the new helper and dialog remain browser-safe.
- **TEST-013**: Declaration-aware identifier validation reports no duplicate TASK/GOAL declarations and no duplicate bullet-style declaration identifiers.
- **TEST-014**: Every relative Markdown link resolves to an existing plan or repository context file, and this plan retains an explicit link to `implementation-details.md`.

## 7. Risks & Assumptions

- **RISK-001**: A direction-bound plan can become stale between generation and apply. The main service's fingerprint check remains authoritative; Step 9 treats rejection as a consumed plan, obtains a non-authorizing comparison, and requires another explicit outcome click and fresh direction-specific plan.
- **RISK-002**: A multi-file sync can partially apply before failure. Step 6's mandatory post-attempt rescan plus Step 9's fresh recovery comparison expose the resulting state while preserving the original error and creating no automatic apply authority.
- **RISK-003**: Adopt and sync plans may use different opaque fingerprints even for identical visible drift, while comparisons have none. REQ-013 intentionally ignores envelope-only fields for UI equivalence while never sending or interpreting them as mutation authority.
- **RISK-004**: A user can switch backends while a comparison, plan, or apply request is pending. Action tokens and backend/dialog identity checks prevent UI contamination; an already dispatched apply cannot be canceled but remains scoped to the explicitly confirmed original backend.
- **RISK-005**: Global shared `loading` and `error` fields cannot express which dialog action is pending. Step 9 keeps minimal per-client stage/error state for the initiating control while continuing to treat shared disk inventory, comparisons, and timestamps as authoritative.
- **RISK-006**: Long paths and three-category conflicts can make the dialog exceed the viewport. The bounded scroll body, sticky/visible footer, wrapping metadata, and narrow layout smoke are required acceptance checks.
- **RISK-007**: Focus-trap code can conflict with Monaco or page-level Escape handlers. The dialog is modal, owns keyboard handling only while mounted, restores prior focus, and Step 7's page Escape handler must remain inactive while the dialog is open.
- **ASSUMPTION-001**: Steps 2 through 8 are implemented first and use the exact shared types, safe error codes, renderer method names, and Config smart/dumb boundary declared in their plans; Step 9 adds no compatibility aliases for partial prerequisite implementations.
- **ASSUMPTION-002**: `HarnessConfigFileRef.updatedAt` is milliseconds since the Unix epoch: disk refs use `stat.mtimeMs`, and config-only refs use the persisted timestamp.
- **ASSUMPTION-003**: Step 6 returns an apply result only after its required rescan/fresh-plan work has completed or been attempted, and returns the original safe apply error when refresh also fails.
- **ASSUMPTION-004**: The product's explicit action-button click confirms the selected direction after review; no additional fourth confirmation dialog is required when the fresh public drift is review-equivalent.
- **ASSUMPTION-005**: The Config page is available through Step 8 for desktop smoke, while all imports and active-backend calls remain compatible with the remote web client.

## 8. Related Specifications / Further Reading

[Feature implementation details and source-of-truth rules](./implementation-details.md)

[Parent Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md)

[Step 1: Product boundary and source of truth](./step-01-product-boundary-source-of-truth.md)

[Step 2: Main-process harness config service](./step-02-main-process-harness-config-service.md)

[Step 3: Harness capability metadata](./step-03-harness-capability-metadata.md)

[Step 4: Shared harness-config state slice](./step-04-shared-state-slice.md)

[Step 5: Persist Tatsu-managed config](./step-05-persist-tatsu-managed-config.md)

[Step 6: Transport request handlers](./step-06-transport-request-handlers.md)

[Step 7: Config page shell](./step-07-config-page-shell.md)

[Step 8: Navigation entry points](./step-08-navigation-entry-points.md)

[Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)

[Step 11: Cross-layer tests](./step-11-tests.md)

[Step 14: Acceptance criteria](./step-14-acceptance-criteria.md)

[Repository architecture and workflow rules](../../AGENTS.md)
