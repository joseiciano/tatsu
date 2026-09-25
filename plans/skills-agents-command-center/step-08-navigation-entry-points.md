---
goal: Add desktop navigation entry points for the harness Config workbench
date_created: 2026-09-25
last_updated: 2026-09-25
status: 'Planned'
tags: [feature, renderer, react, navigation, harness-config]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan implements Step 8 of the larger [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It makes the Config workbench from [Step 7](./step-07-config-page-shell.md) reachable from the desktop application through a renderer-local full-screen overlay, a persistent expanded-sidebar footer button, and a button on the no-repository onboarding/home surface. The work follows the feature goals and Config terminology in [implementation-details.md](./implementation-details.md).

This step is navigation-only. It does not implement Config resource behavior, sync conflict resolution, skill-command conversion, backend methods, shared state, or mobile navigation. Steps 9 through 11 remain follow-up work, so completing this plan does not complete the overarching feature.

## 1. Requirements & Constraints

- **REQ-001**: Add `const [showConfig, setShowConfig] = useState(false)` to `DesktopApp` in `src/renderer/App/App.tsx`, beside the existing renderer-local overlay flags such as `showSettings`.
- **REQ-002**: Config overlay visibility MUST remain per-client renderer state. Do not add `showConfig` to `AppState`, a shared slice, transport contracts, persistence, preload, the main process, or a backend request.
- **REQ-003**: Import `Config` only through the Step 7 package barrel `src/renderer/components/Config`; do not deep-import `Config.tsx` or its internal presentational modules.
- **REQ-004**: Define a conditional `configOverlay` beside `settingsOverlay` in `DesktopApp`. When `showConfig` is true, render `<Config onClose={() => setShowConfig(false)} />` inside the same `fixed inset-0 z-50` wrapper pattern used by Settings.
- **REQ-005**: Render `configOverlay` in both desktop return paths: the `repoRoots.length === 0 || previewOnboarding` early-return branch and the normal workspace branch. The no-repository early return MUST NOT make an opened Config overlay unreachable.
- **REQ-006**: Do not replace the normal workspace, unmount worktree terminal trees, or add `showConfig` to the workspace visibility predicates. Config is an overlay, matching Settings, so the underlying desktop tree remains mounted while it is open.
- **REQ-007**: Treat `ConfigProps.onClose` as the authoritative close callback. Step 7 owns any dirty-editor discard guard; `DesktopApp` changes `showConfig` only after `Config` invokes `onClose`.
- **REQ-008**: Extend `SidebarProps` in `src/renderer/components/Sidebar/Sidebar.tsx` with `onOpenConfig: () => void`, destructure it in `Sidebar`, and pass it from the single expanded `Sidebar` call site in `DesktopApp`.
- **REQ-009**: Add a dedicated bottom Config control after `BackendChipStrip` in the expanded Sidebar. The current expanded Sidebar has no bottom icon row, despite the `BackendChipStrip` comment referring to one, so the implementation MUST create a footer container rather than assume an existing element.
- **REQ-010**: The Sidebar Config control MUST be an icon-only button with a `Tooltip` label of `Config`, an explicit `aria-label="Open Config"`, the existing launcher hover/focus classes, and a Lucide `SlidersHorizontal` icon using `className="icon-sm"`.
- **REQ-011**: The expanded Sidebar opener passed by `DesktopApp` MUST close Command Center with `setShowCommandCenter(false)` before setting `showConfig` to true, matching the existing Settings launcher behavior and preventing Config from returning to a stale Command Center surface on close.
- **REQ-012**: Add a visible onboarding/home button inside the `repoRoots.length === 0 || previewOnboarding` branch. Its click handler MUST only set `showConfig` to true; it MUST NOT start repository selection, create a project, mutate onboarding progress, or write harness files.
- **REQ-013**: Place the onboarding Config action after the onboarding cards and before the existing worktree-guide link so it is available without competing with the required `Open Repository` step. Use visible copy that names the destination and scope: `Open Config` with supporting text or an accessible label identifying agents, skills, and commands.
- **REQ-014**: Reuse `SlidersHorizontal` for the onboarding action and apply a canonical `icon-*` class. New text MUST use only repository-approved sizes (`text-xs`, `text-sm`, `text-base`, `text-lg`, `text-2xl`, or `text-3xl`); do not add pixel text sizes or Lucide `size` props.
- **REQ-015**: Use existing semantic theme utilities and button patterns from App and Sidebar. Do not add Config-specific global CSS, a new theme token, a gradient, a runtime dependency, or a generic navigation abstraction for these two call sites.
- **REQ-016**: Preserve all existing Settings, onboarding, repository, sidebar, Command Center, backend-chip, and worktree callbacks. Config is additive and MUST NOT rename or repurpose Settings.
- **REQ-017**: Do not add a Config entry to `CollapsedSidebar`, `MobileApp`, application menus, hotkeys, or CommandPalette in this step. A user with the desktop sidebar collapsed can expand it to reach the required expanded-sidebar entry point; broader navigation requires a separate explicit scope decision.
- **CON-001**: Step 7 MUST be implemented first and expose `Config` plus `ConfigProps { onClose: () => void }` from `src/renderer/components/Config/index.ts`.
- **CON-002**: The Config overlay remains desktop-only because `showConfig` is owned by `DesktopApp`; do not alter the viewport dispatcher or `MobileApp`.
- **CON-003**: Keep the implementation in the requested order: local state, overlay composition, expanded-sidebar entry, then no-repository onboarding entry.
- **GUD-001**: Keep callback plumbing explicit in `DesktopApp` and `SidebarProps`; two call sites do not justify a context, router, overlay manager, or shared hook.
- **PAT-001**: Follow `settingsOverlay` in `src/renderer/App/App.tsx` for overlay wrapper, conditional rendering, and placement in both desktop render branches.
- **PAT-002**: Follow the existing Sidebar Settings launcher for Tooltip and button interaction styling, while honoring this step's explicit bottom placement after `BackendChipStrip`.

## 2. Implementation Steps

### Implementation Phase 1: Add local overlay ownership

- **GOAL-001**: Mount the Step 7 Config workbench as a renderer-local Settings-style desktop overlay without changing shared state or workspace lifecycle.

- [ ] **TASK-001**: Add the Config imports and local visibility state in `src/renderer/App/App.tsx`.
  - Dependency: CON-001.
  - Import `Config` from `../components/Config`.
  - Add `SlidersHorizontal` to the existing `lucide-react` import for the onboarding action.
  - Declare `showConfig` and `setShowConfig` immediately beside `showSettings` so overlay ownership remains discoverable.
  - Do not add an effect, persistence call, store hook, or backend request for this boolean.
- [ ] **TASK-002**: Define and mount `configOverlay` in `DesktopApp`.
  - Dependency: TASK-001.
  - Define the conditional overlay beside `settingsOverlay` using the exact outer wrapper class `fixed inset-0 z-50`.
  - Render `Config` from its package barrel and pass an `onClose` callback that sets `showConfig` to false.
  - Add `{configOverlay}` next to `{settingsOverlay}` in the no-repository/onboarding return before modal overlays, and in the normal workspace return before transient command-palette/hotkey overlays.
  - Do not add `showConfig` to `closeFullscreenViews`, worktree `isVisible`, right-column visibility conditions, or terminal mounting conditions; a fixed overlay does not need to tear down the underlying UI.

### Implementation Phase 2: Add the expanded-sidebar entry

- **GOAL-002**: Provide the required persistent Config launcher at the bottom of the expanded desktop Sidebar.

- [ ] **TASK-003**: Extend the Sidebar callback contract in `src/renderer/components/Sidebar/Sidebar.tsx`.
  - Dependency: TASK-002.
  - Add `onOpenConfig: () => void` to `SidebarProps` next to the other overlay launchers and destructure it in `Sidebar`.
  - Add `SlidersHorizontal` to the existing `lucide-react` import.
  - Do not import `Config`, read App state, or call the backend from Sidebar.
- [ ] **TASK-004**: Render the bottom Config icon button in `Sidebar`.
  - Dependency: TASK-003.
  - Insert a shrink-safe footer container after `<BackendChipStrip onAddBackend={onOpenAddBackend} />` and before the conditional `SnoozeCalendar` rendering.
  - Give the footer a top border and the same compact centering/padding language as existing Sidebar action rows.
  - Wrap the button in `<Tooltip label="Config" side="top">`.
  - Set `onClick={onOpenConfig}`, `aria-label="Open Config"`, the existing launcher interaction classes, and `<SlidersHorizontal className="icon-sm" />`.
  - Preserve BackendChipStrip auto-hide behavior and the scrollable worktree list's `flex-1` ownership so the new footer remains pinned to the bottom.
- [ ] **TASK-005**: Wire the expanded Sidebar callback from `DesktopApp`.
  - Dependency: TASK-004.
  - At the existing `<Sidebar>` call in `src/renderer/App/App.tsx`, pass `onOpenConfig={() => { setShowCommandCenter(false); setShowConfig(true) }}` beside `onOpenSettings`.
  - Keep the callback local and explicit; do not add it to transport or shared types.
  - Leave `CollapsedSidebar` unchanged per REQ-017.

### Implementation Phase 3: Add the onboarding/home entry

- **GOAL-003**: Let a user configure agent definitions, skills, and commands before selecting the first repository.

- [ ] **TASK-006**: Add the no-repository Config action in `src/renderer/App/App.tsx`.
  - Dependency: TASK-002.
  - In the `repoRoots.length === 0 || previewOnboarding` branch, add a secondary action block after the four onboarding cards and before the existing `New to multi-agent workflows?` guide link.
  - Render a real `<button type="button">` with `onClick={() => setShowConfig(true)}`, a `SlidersHorizontal` icon using `icon-base` or `icon-sm`, visible `Open Config` text, and concise supporting copy identifying agents, skills, and commands.
  - Use semantic theme tokens and canonical text sizes already present in the onboarding surface; do not reuse the repository-opening handler or mark any onboarding step complete.
  - Keep the action visible in development `previewOnboarding` because that branch is the supported way to smoke-test the no-repository surface without deleting local app data.

### Implementation Phase 4: Verify and deliver navigation

- **GOAL-004**: Prove both entry points open and close the real Config surface without regressing desktop navigation, renderer builds, or UI scaling.

- [ ] **TASK-007**: Run static and bundle validation after all TSX edits.
  - Dependency: TASK-005 and TASK-006.
  - Run `pnpm typecheck` and resolve every error in the Config barrel import, Sidebar prop contract, App callback wiring, and Lucide imports.
  - Run `pnpm build` and verify the desktop renderer and web-client bundles both resolve the Config package and new icon imports.
  - Do not add a snapshot, source-text, or callback-forwarding test merely to assert JSX wiring; those tests would duplicate implementation rather than defend behavior.
- [ ] **TASK-008**: Smoke-test the actual Electron desktop navigation with `pnpm dev`.
  - Dependency: TASK-007.
  - In the normal workspace, confirm the bottom Sidebar Config button remains pinned below the scrollable worktree list and BackendChipStrip, exposes its Tooltip and accessible label, opens the full-screen Config overlay, and returns to the workspace when Config's Back/Close control completes its close guard.
  - Open Command Center, invoke the Sidebar Config entry, close Config, and confirm Command Center does not reappear.
  - Use `Help → Debug → Preview Onboarding` to exercise the no-repository branch without deleting persisted repositories. Confirm `Open Config` opens the same overlay and closing it returns to the onboarding surface without changing theme/agent/hook selections or starting the repository picker.
  - Repeat the two entry-point checks at the default UI scale and one larger configured UI scale; confirm both `SlidersHorizontal` icons scale and the onboarding action remains readable.
  - Recheck Settings, Open Repository, New Project, worktree selection, and sidebar collapse/expand once to confirm their existing handlers remain intact.
- [ ] **TASK-009**: Review scope and commit the completed Step 8 change.
  - Dependency: TASK-008.
  - Confirm no shared-state, main-process, preload, transport, Config business-logic, mobile, collapsed-sidebar, menu, hotkey, or CommandPalette files changed.
  - Confirm both desktop return branches include `configOverlay` and all new text/icon sizing follows repository rules.
  - Run the identifier and relative-link validation described in TEST-004 and TEST-005.
  - Commit only the Step 8 implementation and this plan with message `feat: add harness config navigation`, then immediately run `git push origin "$(git branch --show-current)"`.

## 3. Alternatives

- **ALT-001**: Store `showConfig` in a shared state slice or persisted settings. Rejected because overlay visibility is per-client UI focus; a second window or remote client may legitimately show a different surface.
- **ALT-002**: Replace Settings with Config or add the new resource tabs inside Settings. Rejected because [implementation-details.md](./implementation-details.md) defines Config as a distinct agents/skills/commands workbench, and Step 7 exports it as its own component.
- **ALT-003**: Render Config as an in-flow fullscreen view and add it to every workspace/right-panel visibility predicate. Rejected because the requested pattern is the fixed Settings overlay, which keeps terminals and the underlying desktop tree mounted.
- **ALT-004**: Put the expanded Sidebar Config control in the current top launcher row beside Settings. Rejected because this step explicitly requires a bottom icon button and the current `BackendChipStrip` comment already establishes a footer row as the intended lower boundary.
- **ALT-005**: Add the same launcher to `CollapsedSidebar`, `MobileApp`, menus, hotkeys, and CommandPalette in the same change. Rejected because those entry points are not requested and would expand prop, UX, accessibility, and verification scope; the expanded desktop Sidebar remains reachable through the existing expand control.
- **ALT-006**: Add a renderer test that searches source text for `showConfig` or asserts that a mocked callback was forwarded. Rejected because it would pin implementation details without proving that the actual overlay is reachable; typecheck/build plus the real Electron smoke cover this wiring more directly.

## 4. Dependencies

- **DEP-001**: [implementation-details.md](./implementation-details.md) defines the Config feature goal, Agents/Skills/Commands resource views, and the end-state home-page navigation requirement.
- **DEP-002**: [Step 7: Config page shell](./step-07-config-page-shell.md) must provide the browser-safe `src/renderer/components/Config` barrel and `ConfigProps { onClose: () => void }` contract before this plan is implemented.
- **DEP-003**: `src/renderer/App/App.tsx` provides `DesktopApp`, renderer-local overlay state, `settingsOverlay`, the early-return onboarding/home surface, and the single expanded Sidebar call site.
- **DEP-004**: `src/renderer/components/Sidebar/Sidebar.tsx` provides the expanded desktop Sidebar, `SidebarProps`, `BackendChipStrip`, Tooltip pattern, and launcher styling.
- **DEP-005**: `src/renderer/components/Tooltip/` and `lucide-react` provide the existing accessible tooltip wrapper and `SlidersHorizontal` icon; no dependency installation is required.
- **DEP-006**: [Step 9](./step-09-sync-conflict-ux.md), [Step 10](./step-10-skill-command-conversion.md), and [Step 11](./step-11-tests.md) remain responsible for conflict resolution, conversion behavior, and domain-level regression coverage after navigation exists.

## 5. Files

- **FILE-001**: `src/renderer/App/App.tsx` — import Config and its onboarding icon, own `showConfig`, compose the fixed overlay in both desktop branches, wire the expanded Sidebar callback, and add the no-repository Config action.
- **FILE-002**: `src/renderer/components/Sidebar/Sidebar.tsx` — add the `onOpenConfig` prop and the bottom Tooltip-wrapped icon button after BackendChipStrip.
- **FILE-003**: `plans/skills-agents-command-center/step-08-navigation-entry-points.md` — this executable Step 8 implementation plan.

## 6. Testing

- **TEST-001**: `pnpm typecheck` exits successfully, proving the Config barrel, `SidebarProps`, App callback, and Lucide icon types are correct.
- **TEST-002**: `pnpm build` exits successfully for Electron main/preload/renderer and the web client, proving the new renderer import graph is browser-safe and bundle-complete.
- **TEST-003**: The `pnpm dev` Electron smoke verifies the expanded Sidebar footer and no-repository onboarding button each open the same fixed Config overlay, Config closes through its own close guard, underlying state remains mounted, Command Center does not reappear, and existing desktop launchers still work.
- **TEST-004**: Run a declaration-aware identifier scan over this plan and confirm duplicate TASK/GOAL declarations and duplicate bullet-style declaration identifiers both produce zero rows.
- **TEST-005**: Validate every relative Markdown link in this plan resolves to an existing file and confirm the plan retains an explicit link to `implementation-details.md`.
- **TEST-006**: No new permanent UI test is required for this callback wiring. Step 11 retains the domain-level reducer, capability, path-safety, sync, conversion, backup, confirmation, and scope-isolation test responsibilities.

## 7. Risks & Assumptions

- **RISK-001**: The onboarding surface is an early return. Omitting `configOverlay` from that return would make the new home button update state without rendering Config; REQ-005 and the onboarding smoke explicitly prevent that failure.
- **RISK-002**: The current expanded Sidebar has its existing overlay launchers at the top and no bottom icon row. Adding Config to the top row would violate the requested placement, while inserting the footer before the scroll region would allow it to scroll away; TASK-004 fixes the footer after BackendChipStrip.
- **RISK-003**: Mounting Config as an in-flow fullscreen view could unmount terminals or require edits to many visibility predicates. The Settings-style fixed overlay avoids that lifecycle regression.
- **RISK-004**: Step 7 may not yet exist in the working tree when Step 8 begins. Do not create a placeholder Config component or compatibility import; implement Step 7 first and consume its declared barrel contract cleanly.
- **RISK-005**: Config may contain an unsaved editor draft. The parent MUST wait for Config's `onClose` callback and MUST NOT force-hide the overlay from an unrelated App cleanup path, preserving Step 7's dirty-discard guard.
- **ASSUMPTION-001**: Step 7 implements the public `Config` component and `onClose` contract exactly as declared in its plan.
- **ASSUMPTION-002**: The source instruction's “sidebar bottom icon button” refers to the expanded `Sidebar.tsx` footer named in the step, not the separate `CollapsedSidebar.tsx` component.
- **ASSUMPTION-003**: Config navigation is intentionally desktop-only for this step; mobile and additional entry points require explicit follow-up requirements.
- **ASSUMPTION-004**: Development Preview Onboarding is an acceptable smoke path for the no-repository branch and does not change persisted repository configuration.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Skills-Agents-Commands-Sync roadmap](./skills-agents-commands-sync.md)

[Step 7: Config page shell](./step-07-config-page-shell.md)

[Step 9: Sync conflict UX](./step-09-sync-conflict-ux.md)

[Step 10: Skill-command conversion](./step-10-skill-command-conversion.md)

[Step 11: Tests](./step-11-tests.md)

[Repository architecture and workflow rules](../../AGENTS.md)
