# Smart-dumb refactor plan

## Summary

### Goal

Refactor `src/renderer` so orchestration logic lives in smart components and rendering logic lives in dumb components, without changing runtime behavior. First pass stays structural: identify mixed-responsibility files, split them at clear seams, keep public imports stable, and verify typecheck/build/tests after each batch.

### Why

- Reduce very large JSX-heavy files that also own store/backend logic
- Make UI easier to test with prop-driven presentational components
- Make stateful behavior easier to reason about by concentrating hooks/effects in container layer
- Improve reuse of renderer-only view pieces across desktop/mobile/right-panel surfaces
- Match repo convention of keeping business logic out of rendering layer

## Scope

This plan covers `src/renderer` only.

Included:
- every file under `src/renderer` listed in the full coverage inventory below
- `App/App.tsx` and all `components/**/*.tsx` as smart/dumb assessment candidates
- `hooks/**/*.ts*` as supporting orchestration layer inputs to smart components
- renderer-only utilities, tests, declarations, CSS, and HTML as support files when needed to preserve imports, view-model shaping, styling, and verification

Explicitly out of scope:
- `src/main/**`
- `src/shared/state/**`
- behavior changes to pane/worktree/chat/review flows
- state ownership changes that belong in shared slices
- visual redesign beyond small markup extraction needed for split

## Full renderer coverage inventory

Coverage rule: every file below is in scope. Primary component files follow their component-specific seam notes. Secondary component files must be assessed for hook/backend/store usage before edit; split only when mixed responsibility appears. Presentational components, barrels, tests, declarations, CSS, HTML, and utilities are support files: keep imports stable, update when their covered feature changes, and do not force smart/dumb files where no component boundary exists.

- `root files`: `ambient.d.ts`, `highlight-common.d.ts`, `hydrate-remote-backend.test.ts`, `index.html`, `modules.d.ts`, `styles.css`, `transport-websocket.test.ts`, `vite-env.d.ts`
- `App`: `App/App.tsx`, `App/index.ts`
- `components/Activity`: `components/Activity/Activity.tsx`, `components/Activity/index.ts`
- `components/ActivityCosts`: `components/ActivityCosts/ActivityCosts.tsx`, `components/ActivityCosts/index.ts`
- `components/AddBackendModal`: `components/AddBackendModal/AddBackendModal.tsx`, `components/AddBackendModal/index.ts`
- `components/AgentIcon`: `components/AgentIcon/AgentIcon.tsx`, `components/AgentIcon/index.ts`
- `components/AllFilesPanel`: `components/AllFilesPanel/AllFilesPanel.tsx`, `components/AllFilesPanel/index.ts`
- `components/BackendChipStrip`: `components/BackendChipStrip/BackendChipStrip.tsx`, `components/BackendChipStrip/index.ts`
- `components/BranchCommitsPanel`: `components/BranchCommitsPanel/BranchCommitsPanel.tsx`, `components/BranchCommitsPanel/index.ts`
- `components/BrowserPanel`: `components/BrowserPanel/BrowserPanel.tsx`, `components/BrowserPanel/index.ts`
- `components/ChangedFilesPanel`: `components/ChangedFilesPanel/ChangedFilesPanel.tsx`, `components/ChangedFilesPanel/index.ts`
- `components/Cleanup`: `components/Cleanup/Cleanup.tsx`, `components/Cleanup/index.ts`
- `components/CollapsedRightPanel`: `components/CollapsedRightPanel/CollapsedRightPanel.tsx`, `components/CollapsedRightPanel/index.ts`
- `components/CollapsedSidebar`: `components/CollapsedSidebar/CollapsedSidebar.tsx`, `components/CollapsedSidebar/index.ts`
- `components/CommandCenter`: `components/CommandCenter/CommandCenter.tsx`, `components/CommandCenter/index.ts`
- `components/CommandPalette`: `components/CommandPalette/CommandPalette.tsx`, `components/CommandPalette/constants.ts`, `components/CommandPalette/index.ts`, `components/CommandPalette/types.ts`
- `components/CostPanel`: `components/CostPanel/CostPanel.tsx`, `components/CostPanel/index.ts`
- `components/CreatingWorktreeScreen`: `components/CreatingWorktreeScreen/CreatingWorktreeScreen.tsx`, `components/CreatingWorktreeScreen/index.ts`
- `components/DeletingWorktreeScreen`: `components/DeletingWorktreeScreen/DeletingWorktreeScreen.tsx`, `components/DeletingWorktreeScreen/index.ts`
- `components/DiffView`: `components/DiffView/DiffView.tsx`, `components/DiffView/index.ts`
- `components/ErrorBoundary`: `components/ErrorBoundary/ErrorBoundary.tsx`, `components/ErrorBoundary/index.ts`
- `components/FileView`: `components/FileView/FileView.tsx`, `components/FileView/index.ts`
- `components/Guide`: `components/Guide/Guide.tsx`, `components/Guide/index.ts`
- `components/HotkeyBadge`: `components/HotkeyBadge/HotkeyBadge.tsx`, `components/HotkeyBadge/index.ts`
- `components/HotkeyCheatsheet`: `components/HotkeyCheatsheet/HotkeyCheatsheet.tsx`, `components/HotkeyCheatsheet/index.ts`
- `components/InterfaceToggle`: `components/InterfaceToggle/InterfaceToggle.tsx`, `components/InterfaceToggle/index.ts`
- `components/JsonClaudeApprovalCard`: `components/JsonClaudeApprovalCard/JsonClaudeApprovalCard.tsx`, `components/JsonClaudeApprovalCard/index.ts`
- `components/JsonClaudeTodosPanel`: `components/JsonClaudeTodosPanel/JsonClaudeTodosPanel.tsx`, `components/JsonClaudeTodosPanel/index.ts`
- `components/JsonModeChat`: `components/JsonModeChat/JsonModeChat.tsx`, `components/JsonModeChat/index.ts`, `components/JsonModeChat.test.ts`
- `components/JsonModeChatImageThumb`: `components/JsonModeChatImageThumb/JsonModeChatImageThumb.tsx`, `components/JsonModeChatImageThumb/index.ts`
- `components/JsonModeMentionPopover`: `components/JsonModeMentionPopover/JsonModeMentionPopover.tsx`, `components/JsonModeMentionPopover/index.ts`
- `components/LinuxWindowControls`: `components/LinuxWindowControls/LinuxWindowControls.tsx`, `components/LinuxWindowControls/index.ts`
- `components/MobileApp`: `components/MobileApp/MobileApp.tsx`, `components/MobileApp/index.ts`
- `components/MobileRightPanel`: `components/MobileRightPanel/MobileRightPanel.tsx`, `components/MobileRightPanel/index.ts`
- `components/MobileTerminal`: `components/MobileTerminal/MobileTerminal.tsx`, `components/MobileTerminal/index.ts`
- `components/MonacoDiffEditor`: `components/MonacoDiffEditor/MonacoDiffEditor.tsx`, `components/MonacoDiffEditor/index.ts`
- `components/MonacoEditor`: `components/MonacoEditor/MonacoEditor.tsx`, `components/MonacoEditor/index.ts`
- `components/MonacoWorkerFailedBanner`: `components/MonacoWorkerFailedBanner/MonacoWorkerFailedBanner.tsx`, `components/MonacoWorkerFailedBanner/index.ts`
- `components/NewProjectScreen`: `components/NewProjectScreen/NewProjectScreen.tsx`, `components/NewProjectScreen/index.ts`
- `components/NewWorktreeScreen`: `components/NewWorktreeScreen/NewWorktreeScreen.tsx`, `components/NewWorktreeScreen/index.ts`
- `components/PRStatusPanel`: `components/PRStatusPanel/PRStatusPanel.test.ts`, `components/PRStatusPanel/PRStatusPanel.tsx`, `components/PRStatusPanel/index.ts`
- `components/PendingScreenParts`: `components/PendingScreenParts/PendingScreenParts.tsx`, `components/PendingScreenParts/index.ts`
- `components/PerfMonitorHUD`: `components/PerfMonitorHUD/PerfMonitorHUD.tsx`, `components/PerfMonitorHUD/index.ts`
- `components/QuestCard`: `components/QuestCard/QuestCard.tsx`, `components/QuestCard/index.ts`
- `components/RemoteBrowserView`: `components/RemoteBrowserView/RemoteBrowserView.tsx`, `components/RemoteBrowserView/index.ts`
- `components/RemoteFilePicker`: `components/RemoteFilePicker/RemoteFilePicker.tsx`, `components/RemoteFilePicker/index.ts`
- `components/RepoAddErrorModal`: `components/RepoAddErrorModal/RepoAddErrorModal.tsx`, `components/RepoAddErrorModal/index.ts`
- `components/RepoIcon`: `components/RepoIcon/RepoIcon.tsx`, `components/RepoIcon/index.ts`
- `components/ReportIssueScreen`: `components/ReportIssueScreen/ReportIssueScreen.tsx`, `components/ReportIssueScreen/index.ts`
- `components/ResizeHandle`: `components/ResizeHandle/ResizeHandle.tsx`, `components/ResizeHandle/index.ts`
- `components/ResolveRepoModal`: `components/ResolveRepoModal/ResolveRepoModal.tsx`, `components/ResolveRepoModal/index.ts`
- `components/ReviewDiffPane`: `components/ReviewDiffPane/ReviewDiffPane.tsx`, `components/ReviewDiffPane/index.ts`
- `components/ReviewFileTree`: `components/ReviewFileTree/ReviewFileTree.tsx`, `components/ReviewFileTree/index.ts`
- `components/ReviewScreen`: `components/ReviewScreen/ReviewScreen.tsx`, `components/ReviewScreen/index.ts`
- `components/ReviewSummaryBar`: `components/ReviewSummaryBar/ReviewSummaryBar.tsx`, `components/ReviewSummaryBar/index.ts`
- `components/RightColumn`: `components/RightColumn/RightColumn.tsx`, `components/RightColumn/index.ts`
- `components/RightColumnToolbar`: `components/RightColumnToolbar/RightColumnToolbar.tsx`, `components/RightColumnToolbar/index.ts`
- `components/RightPanel`: `components/RightPanel/RightPanel.tsx`, `components/RightPanel/index.ts`
- `components/ScratchpadPanel`: `components/ScratchpadPanel/ScratchpadPanel.tsx`, `components/ScratchpadPanel/index.ts`
- `components/Settings`: `components/Settings/Settings.tsx`, `components/Settings/index.ts`
- `components/Sidebar`: `components/Sidebar/Sidebar.tsx`, `components/Sidebar/index.ts`
- `components/SnoozeCalendar`: `components/SnoozeCalendar/SnoozeCalendar.tsx`, `components/SnoozeCalendar/index.ts`
- `components/TerminalPanel`: `components/TerminalPanel/TerminalPanel.tsx`, `components/TerminalPanel/index.ts`
- `components/Tooltip`: `components/Tooltip/Tooltip.tsx`, `components/Tooltip/index.ts`
- `components/WeeklyWrappedScreen`: `components/WeeklyWrappedScreen/WeeklyWrappedScreen.tsx`, `components/WeeklyWrappedScreen/index.ts`
- `components/WorkspaceView`: `components/WorkspaceView/WorkspaceView.tsx`, `components/WorkspaceView/index.ts`
- `components/WorktreeTab`: `components/WorktreeTab/WorktreeTab.tsx`, `components/WorktreeTab/index.ts`
- `components/XTerminal`: `components/XTerminal/XTerminal.tsx`, `components/XTerminal/index.ts`
- `components/json-mode-cards`: `components/json-mode-cards/BashCard.tsx`, `components/json-mode-cards/EditCard.tsx`, `components/json-mode-cards/GenericToolCard.tsx`, `components/json-mode-cards/GlobCard.tsx`, `components/json-mode-cards/GrepCard.tsx`, `components/json-mode-cards/MultiEditCard.tsx`, `components/json-mode-cards/ReadCard.tsx`, `components/json-mode-cards/TaskCard.tsx`, `components/json-mode-cards/TodoWriteCard.tsx`, `components/json-mode-cards/ToolGroup.tsx`, `components/json-mode-cards/UnifiedDiff.tsx`, `components/json-mode-cards/WriteCard.tsx`, `components/json-mode-cards/diff-util.test.ts`, `components/json-mode-cards/diff-util.ts`, `components/json-mode-cards/grouping.test.ts`, `components/json-mode-cards/grouping.ts`, `components/json-mode-cards/index.tsx`
- `components/worktree-detail`: `components/worktree-detail/index.ts`, `components/worktree-detail/worktree-detail.test.ts`, `components/worktree-detail/worktree-detail.ts`
- `backend`: `backend/backend.ts`, `backend/index.ts`
- `branch-name`: `branch-name/branch-name.ts`, `branch-name/index.ts`
- `build-backend`: `build-backend/build-backend.ts`, `build-backend/index.ts`
- `fuzzy`: `fuzzy/fuzzy.ts`, `fuzzy/index.ts`
- `hooks`: `hooks/useActiveTheme/index.ts`, `hooks/useActiveTheme/useActiveTheme.ts`, `hooks/useHotkeyHandlers/index.ts`, `hooks/useHotkeyHandlers/useHotkeyHandlers.ts`, `hooks/useHotkeys/index.ts`, `hooks/useHotkeys/useHotkeys.ts`, `hooks/useJsonClaudeApprovals/index.ts`, `hooks/useJsonClaudeApprovals/useJsonClaudeApprovals.ts`, `hooks/useMetaHeld/index.ts`, `hooks/useMetaHeld/useMetaHeld.ts`, `hooks/useSystemColorScheme/index.ts`, `hooks/useSystemColorScheme/useSystemColorScheme.ts`, `hooks/useTabHandlers/index.ts`, `hooks/useTabHandlers/useTabHandlers.ts`, `hooks/useTailLineBuffer/index.ts`, `hooks/useTailLineBuffer/useTailLineBuffer.ts`, `hooks/useViewport/index.ts`, `hooks/useViewport/useViewport.ts`, `hooks/useWatchedQuery/index.ts`, `hooks/useWatchedQuery/useWatchedQuery.ts`, `hooks/useWorktreeHandlers/index.ts`, `hooks/useWorktreeHandlers/useWorktreeHandlers.ts`
- `hotkeys`: `hotkeys/constants.ts`, `hotkeys/hotkeys.ts`, `hotkeys/index.ts`, `hotkeys/types.ts`
- `main`: `main/index.ts`, `main/main.tsx`
- `monaco-setup`: `monaco-setup/index.ts`, `monaco-setup/monaco-setup.ts`
- `pending-tool`: `pending-tool/index.ts`, `pending-tool/pending-tool.ts`
- `render-metrics`: `render-metrics/index.ts`, `render-metrics/render-metrics.ts`
- `store`: `store/constants.ts`, `store/index.ts`, `store/store.ts`, `store/types.ts`
- `syntax`: `syntax/index.ts`, `syntax/syntax.ts`
- `theme-apply`: `theme-apply/index.ts`, `theme-apply/theme-apply.ts`
- `themes`: `themes/index.ts`, `themes/themes.ts`
- `types`: `types/index.ts`, `types/types.ts`
- `worktree-detail-override`: `worktree-detail-override/index.ts`, `worktree-detail-override/worktree-detail-override.ts`
- `worktree-sort`: `worktree-sort/index.ts`, `worktree-sort/worktree-sort.test.ts`, `worktree-sort/worktree-sort.ts`

## Smart-dumb rules

### Smart component
- public import target
- owns hook calls
- owns backend/store access
- owns effects, async actions, derived view-models, local non-render state
- renders dumb component only

### Dumb component
- prop-driven
- owns JSX, HTML, CSS classes, render-only branching
- no backend/store access
- no async side effects
- no query/state orchestration except tiny UI-only state when extraction cost not worth new file

## Current renderer map

### Infrastructure layer — keep outside dumb layer
- `store/store.ts`
- `backend/backend.ts`
- `build-backend/build-backend.ts`
- `hooks/useTabHandlers/useTabHandlers.ts`
- `hooks/useWorktreeHandlers/useWorktreeHandlers.ts`
- `hooks/useHotkeyHandlers/useHotkeyHandlers.ts`
- `hooks/useHotkeys/useHotkeys.ts`
- `hooks/useTailLineBuffer/useTailLineBuffer.ts`
- `hooks/useMetaHeld/useMetaHeld.ts`
- `hooks/useViewport/useViewport.ts`
- `hooks/useActiveTheme/useActiveTheme.ts`
- `hooks/useSystemColorScheme/useSystemColorScheme.ts`
- `hooks/useJsonClaudeApprovals/useJsonClaudeApprovals.ts`
- renderer utilities like `hotkeys/hotkeys.ts`, `worktree-sort/worktree-sort.ts`, `theme-apply/theme-apply.ts`, `themes/themes.ts`

### Already mostly dumb/presentational — use as reference shapes
- `components/Tooltip/Tooltip.tsx`
- `components/HotkeyBadge/HotkeyBadge.tsx`
- `components/AgentIcon/AgentIcon.tsx`
- `components/RepoIcon/RepoIcon.tsx`
- `components/SnoozeCalendar/SnoozeCalendar.tsx`
- `components/ReviewSummaryBar/ReviewSummaryBar.tsx`
- `components/ReviewFileTree/ReviewFileTree.tsx`
- `components/MonacoEditor/MonacoEditor.tsx`
- `components/MonacoDiffEditor/MonacoDiffEditor.tsx`
- most `components/json-mode-cards/*`

### Highest-value smart/dumb targets
- `App/App.tsx`
- `components/Settings/Settings.tsx`
- `components/JsonModeChat/JsonModeChat.tsx`
- `components/WorkspaceView/WorkspaceView.tsx`
- `components/TerminalPanel/TerminalPanel.tsx`
- `components/Sidebar/Sidebar.tsx`
- `components/CommandCenter/CommandCenter.tsx`
- `components/ReviewScreen/ReviewScreen.tsx`
- `components/RightColumn/RightColumn.tsx`

## Target structure

Mixed-responsibility renderer components should move toward package-style folders.

```
src/renderer/components/
  Foo/
    index.ts            # public export of smart component + public types
    Foo.tsx             # smart component/container
    FooView.tsx         # dumb component/presentational shell
    Foo.types.ts        # optional
    parts/              # optional presentational subparts
```

For root app shell:

```
src/renderer/App/
  index.ts              # public export for existing import surface
  App.tsx               # smart root container
  AppView.tsx           # dumb root layout
  App.types.ts          # optional
```
## Package rules

### Required
- smart component remains public import target
- dumb component lives in separate file
- public exports go through `index.ts` for packaged components

### Optional
- `*.types.ts` for prop/view-model types shared by smart and dumb layers
- `parts/` for render-only subcomponents inside large views
- `view-model.ts` only when shaping props becomes non-trivial and reusable

Do not create empty helper files.

## Refactor strategy

### Phase 0 — define boundaries
For each target component:
1. classify hook/store/backend calls
2. classify local state as orchestration state vs tiny UI state
3. identify stable presentational prop boundary
4. identify subviews worth extracting before full smart/dumb split

### Phase 1 — extract dumb views without behavior change
For each target:
1. keep existing public component name as smart container
2. move JSX-heavy render body into `*View.tsx`
3. pass render-ready props and callbacks only
4. keep existing business logic, effects, async work in smart file
5. avoid touching shared-state ownership

### Phase 2 — split large views into presentational parts
After `*View.tsx` exists:
- extract repeated sections into `parts/`
- keep parts dumb and prop-driven
- move display-only formatting helpers next to view when useful

### Phase 3 — tighten boundaries
- remove leftover backend/store imports from dumb files
- remove business logic from presentational callbacks where possible
- rename ambiguous components to make smart vs view role obvious

## Component-by-component seams

### `App/App.tsx`
Target split:
- `App/App.tsx` stays smart root container
- `app/AppView.tsx` becomes dumb desktop/mobile layout shell

Move into smart layer:
- slice subscriptions
- all `useState` for active worktree, panes, modal visibility, widths, collapsed groups/repos
- `useTabHandlers`, `useWorktreeHandlers`, `useHotkeyHandlers`
- menu and IPC effects
- aggregate derivations like worktree statuses, pending tools, shell activity

Move into dumb layer:
- root layout JSX
- conditional placement of sidebar, workspace, right panel, overlays
- markup-only branching based on props

Phase 0 notes:
- hook/store/backend calls: `useSettings`, `usePrs`, `useOnboarding`, `useHooks`, `useWorktrees`, `useTerminals`, `usePanes`, `useLastActive`, `useUpdater`, `useRepoConfigs`, `useSnooze`, `useAnnouncements`, `useBackend`, `useTailLineBuffer`, `useTabHandlers`, `useHotkeyHandlers`, `useWorktreeHandlers`, `useActiveTheme`, `useViewport`
- orchestration state: active worktree/pane, sidebar/right-panel sizing, collapsed groups/repos, unified repos, modal/open-screen flags, review mode selection
- tiny UI state: banner dismissals, onboarding preview toggles, announcement menu open state, local theme/agent chooser staging
- stable prop boundary: derived layout props for sidebar, workspace, right column, overlays, onboarding, review state
- first subviews: root layout shell, onboarding/welcome surface, stacked banners/overlays

### `components/Sidebar/Sidebar.tsx`
Target split:
- `Sidebar/Sidebar.tsx` smart container
- `Sidebar/SidebarView.tsx` dumb list/layout renderer
- optional `parts/SidebarGroup.tsx`, `parts/SidebarFooter.tsx`

Keep smart:
- `useBackend`
- continue-worktree state and submit flow
- snooze/unsnooze actions
- repo/group derivations

Move dumb:
- group headers
- worktree row mapping
- footer buttons
- continue form rendering
- calendar anchoring markup

Phase 0 notes:
- hook/store/backend calls: `useBackend` with snooze/unsnooze actions only
- orchestration state: continue-worktree flow state (`continueTarget`, branch draft, pending/error)
- tiny UI state: snooze calendar anchor/popover target
- stable prop boundary: grouped worktree/status/PR props plus action callbacks already passed into sidebar
- first subviews: continue form, repo header, group header; keep `WorktreeTab` dumb

### `components/TerminalPanel/TerminalPanel.tsx`
Target split:
- `TerminalPanel/TerminalPanel.tsx` smart container
- `TerminalPanel/TerminalPanelView.tsx` dumb tab strip
- optional `parts/SortableTabView.tsx`

Keep smart:
- `useBackend`
- sortable/droppable wiring
- rename state and commit handlers
- scroll calculations
- spectator/session lookups

Move dumb:
- tab button markup
- scroll button markup
- menu markup
- rename input markup

Phase 0 notes:
- hook/store/backend calls: `useBackend`, `useTerminalProgress`, `useTerminalSession`, `useDroppable`, `useSortable`
- orchestration state: alt-click agent cycling, scroll capability state, rename commit handlers
- tiny UI state: context menu position, inline rename draft
- stable prop boundary: pane-local tabs, statuses, shell activity, selection/close/add callbacks
- first subviews: sortable tab view, tab strip controls, scroll buttons, rename/menu surfaces

### `components/WorkspaceView/WorkspaceView.tsx`
Target split:
- `WorkspaceView/WorkspaceView.tsx` smart container
- `WorkspaceView/WorkspaceView.tsx` may stay mostly smart initially
- first extraction should be dumb recursive split renderer, likely `parts/WorkspaceSplitView.tsx`

Keep smart:
- `useBackend`
- slot ref management
- wake/resize effects
- drag-over/drag-end logic

Move dumb:
- recursive split/pane render JSX
- resize handle placement
- pane shell markup

Phase 0 notes:
- hook/store/backend calls: `useBackend` for wake and split-ratio updates
- orchestration state: slot ref registry, previous active-tab bookkeeping, drag-over/end handlers, resize commit flow
- tiny UI state: none worth splitting yet; file mostly orchestration plus layout render
- stable prop boundary: pane tree, focused pane id, tab statuses/activity, pane callbacks
- first subviews: recursive split renderer, pane shell wrapper, portal slot placement surface

### `components/RightColumn/RightColumn.tsx`
Target split:
- `RightColumn/RightColumn.tsx` smart container
- `RightColumn/RightColumnView.tsx` dumb ordered panel renderer

Keep smart:
- `useBackend`
- repo-config lookups
- hidden/order derivation

Move dumb:
- toolbar placement
- ordered panel rendering
- empty-state markup

Phase 0 notes:
- hook/store/backend calls: `useBackend` with repo-config persistence only
- orchestration state: none local; smartness lives in backend writes and panel ordering derivation
- tiny UI state: none
- stable prop boundary: width, active worktree, PR data, refresh/open callbacks already enough for dumb renderer
- first subviews: optional extracted panel switch renderer only if file needs more shrinking

### `components/ReviewScreen/ReviewScreen.tsx`
Target split:
- `ReviewScreen/ReviewScreen.tsx` smart container
- `ReviewScreen/ReviewScreenView.tsx` dumb review layout

Keep smart:
- changed-files fetch
- selected/reviewed/comment state
- collapse bookkeeping

Move dumb:
- summary bar layout
- file tree placement
- diff pane placement

Phase 0 notes:
- hook/store/backend calls: `useBackend` with changed-files fetch APIs
- orchestration state: loaded files, selected file, reviewed-file set, comment map
- tiny UI state: collapsed directory state
- stable prop boundary: repo/worktree identity, review mode, selected/reviewed/comment view models, callbacks
- first subviews: already mostly `ReviewScreenView`; keep extraction focus on file tree and summary pieces if needed

### `components/CommandCenter/CommandCenter.tsx`
Target split:
- `CommandCenter/CommandCenter.tsx` smart container
- `CommandCenter/CommandCenterView.tsx` dumb dashboard shell
- optional `parts/HistoryChart.tsx`, `parts/WorktreeStatusList.tsx`

Keep smart:
- backend polling
- history sample derivation
- snooze data lookup
- tick/interval management

Move dumb:
- cards
- chart markup
- grouped status lists

Phase 0 notes:
- hook/store/backend calls: `useBackend`, `useSettings`, `useSnooze`, interval polling for activity log
- orchestration state: log/history/count/section derivation, polling tick, unified repo derivation
- tiny UI state: collapsed sections
- stable prop boundary: section view models, chart/history data, selected-worktree callback props
- first subviews: history chart, grouped status list, metric cards

### `components/JsonModeChat/JsonModeChat.tsx`
Target split:
- `JsonModeChat/JsonModeChat.tsx` smart container
- `JsonModeChat/JsonModeChatView.tsx` dumb shell
- expected parts: message list, composer, status/footer, attachment/mention UI shells

Keep smart:
- session/store/backend hooks
- streaming state
- approvals wiring
- mention/file/cache orchestration
- scroll anchoring logic until safe to isolate

Move dumb:
- message row rendering once rows already derived
- composer markup
- footer/status markup
- card placement and empty states

Phase 0 notes:
- hook/store/backend calls: `useBackend`, `useJsonClaudeSession`, `useSettings`, `useJsonClaudeApprovals`, many session/file/pane backend mutations
- orchestration state: draft, attachments, file/mention orchestration, scroll anchoring, rewind/menu state, drag-over state
- tiny UI state: jump-to-bottom visibility, mention picker cursor/selection, transient composer affordance flags
- stable prop boundary: render-ready message rows, composer props, footer/status props, approval/banner/card props
- first subviews: message list shell, composer shell, footer/status area, auth/rate-limit/thinking cards

### `components/Settings/Settings.tsx`
Target split:
- `Settings/Settings.tsx` smart shell/container
- section views under `components/Settings/parts/`

Keep smart:
- settings/updater/repo-config/hooks/backend access
- section navigation state
- search index and DOM ref bookkeeping
- form draft ownership

Move dumb:
- section markup
- option row markup
- modal/page layout

Do this last. Highest regression risk.

Phase 0 notes:
- hook/store/backend calls: `useBackend`, `useSettings`, `useUpdater`, `useRepoConfigs`, `useHooks`, plus large settings mutation surface
- orchestration state: active section/subsection, search index and refs, token save flow, command/env drafts, prompt/script drafts, ws config drafts, staged numeric settings
- tiny UI state: expanded families, toggle visibility flags, copy/rotate success toasts, transient error banners
- stable prop boundary: modal/page frame props plus section-level view models and callbacks per settings family
- first subviews: settings sidebar/search, section shells, reusable option rows, family-specific section views

## Batching plan

### Batch 1 — establish pattern, low risk
- `components/RightColumn/RightColumn.tsx`
- `components/ReviewScreen/ReviewScreen.tsx`
- `components/CommandCenter/CommandCenter.tsx`

Goal:
- prove naming, folder, prop-boundary pattern
- create reusable `*.types.ts` convention only where needed

### Batch 2 — medium
- `components/Sidebar/Sidebar.tsx`
- `components/TerminalPanel/TerminalPanel.tsx`
- `components/WorkspaceView/WorkspaceView.tsx` first sub-extraction only

Goal:
- split stateful layout surfaces with visible UI but bounded blast radius

### Batch 3 — medium-high
- `App/App.tsx`
- mobile/desktop shared shell pieces touched by `App.tsx`

Goal:
- isolate renderer root orchestration from root layout JSX

### Batch 4 — highest risk
- `components/JsonModeChat/JsonModeChat.tsx`
- `components/Settings/Settings.tsx`

Goal:
- break giant mixed files after pattern already proven elsewhere

## Known risk areas

High risk because of size, fanout, or effect density:
- `App/App.tsx`
- `components/Settings/Settings.tsx`
- `components/JsonModeChat/JsonModeChat.tsx`
- `components/WorkspaceView/WorkspaceView.tsx`
- `components/TerminalPanel/TerminalPanel.tsx`

Specific watchouts:
- do not move shared state out of slices into renderer-local state
- do not let dumb components import `useBackend`, `useSettings`, `useAppState`, or other store hooks
- preserve drag-and-drop identity in terminal/pane views
- preserve portal/slot stability in workspace view
- preserve scroll anchoring and streaming behavior in chat
- preserve search-index and focus behavior in settings modal

## Verification

Run after each batch:
- `pnpm typecheck`
- `npx electron-vite build`
- targeted `npx vitest run` for touched renderer tests

Run broader UI smoke after batches touching root or complex flows:
- open app and verify sidebar selection, tab drag, pane resize, chat send/stream, settings save, review screen navigation

## Success criteria

Refactor considered successful when:
- each targeted mixed component has explicit smart/dumb boundary
- dumb components are prop-driven and contain no backend/store imports
- smart components remain public import targets
- large renderer files shrink by moving JSX/render branches into views/parts
- runtime behavior unchanged
- typecheck, build, and relevant tests pass after each batch
