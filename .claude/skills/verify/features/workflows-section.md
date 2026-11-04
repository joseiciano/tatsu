# Workflows section

With Labs workflows on, a full-screen Workflows section sits alongside
Activity and Cleanup. Its Runs tab pins NEEDS YOU at the top, then one card
per active run, then recent finished and cancelled runs.

## Sub-features

- **Entry points**: the sidebar top bar button `Workflows` (`aria-label`,
  `Workflow` icon, next to Command Center), the same button in the collapsed
  sidebar, the hotkey `toggleWorkflows` (default Cmd+Alt+W), and the command
  palette action `Toggle workflows`. All are hidden or no-op with Labs
  workflows off. Opening the section closes Activity, Cleanup, Review, New
  worktree and Report issue, and hides the workspace (terminals, right
  column).
- **Section**: `role="region"` named `Workflows` (h1), a `Back` button, and a
  tablist `Workflows views` with one tab `Runs` (Library comes later).
- **Needs you**: the same `NEEDS YOU` group as the sidebar, rendered inside
  the section, so the page has two `NEEDS YOU` regions while the section is
  open. Scope locators to the section region.
- **Active runs**: region `Active runs`, one `article` per queued, running
  or paused run, newest start first, named `<workflow> on <worktree>`. The
  card shows `<repo> / <worktree>`, the step strip (`role="img"`,
  `Workflow steps: …`), the run status (`Running`, `Paused · <reason>`), and
  `Step <id> · <agent>`, `Elapsed` (ticks every second) and `Cost` (`—`
  when no attempt reported a cost) as `dt`/`dd` pairs.
- **Run workflow…**: a button at the top of the Runs tab opens the launch
  sheet with no preset target (Repository, New or Existing worktree; see
  workflow-run.md). A successful Start closes the section and selects the
  target worktree.
- **Recent runs**: region `Recent runs`, done, failed and cancelled runs in
  the slice (up to 50), newest finish first; elapsed stops at `finishedAt`.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings (seeded by `launch.sh`).
2. Press Cmd+K, type `workflows`, choose `Toggle workflows` (or click the
   `Workflows` button at the top of the sidebar).
3. Read NEEDS YOU, Active and Recent; act on a NEEDS YOU row; press Back.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `workflows-section`: start `browser-hang` -> close tab `⚙ hang · Claude`
    -> `Cancel step and close tab` (run paused, step cancelled) -> `Meta+k`
    -> fill `Search worktrees and commands...` with `workflows` -> click
    `Toggle workflows` -> region `Workflows` with no visible `.xterm` ->
    NEEDS YOU row `Cancelled by user · hang` inside the section -> `Active
    runs` card `browser-hang on repo` with strip `hang paused`, `Paused ·
    Cancelled by user` and `hang · Claude Code` -> `Cancel run: browser-hang
    on repo` from the section's NEEDS YOU row -> run record `cancelled`,
    active card and row gone, one more `browser-hang on repo` card under
    `Recent runs` -> Back -> section and strips gone -> sidebar button
    `Workflows` opens it -> `Meta+Alt+w` closes it and opens it again ->
    Back -> terminals visible again. A visible `.xterm` count before the
    palette step is the positive control for "the section hides the
    workspace".

  - `launch-target` (last scenario): sidebar `Workflows` -> section
    `Run workflow…` -> dialog `Run workflow` with focus on `Repository` and
    `New worktree` checked -> Tab and Shift+Tab (focusables + 3 each) keep
    focus inside the dialog -> pick `browser-hang` -> `Branch name` matches
    `wf/browser-hang/<8 hex>` -> Start -> dialog and section gone -> the
    sidebar row with `aria-current="true"` shows that branch and the strip
    `hang running`, and the tab bar shows the step tab `⚙ hang · Claude` -> state has the new worktree and no pending entries ->
    `$HARNESS_DATA_DIR/workflow-runs/<runId>.json` names the new worktree
    and `personal:browser-hang` -> `cancelRun` in `finally`, then the scratch
    repo row is selected again. `workflow-flows.sh` passes `DATA_DIR` as
    `HARNESS_DATA_DIR`.

End state that proves it: `workflows-section-*.png` in
`$EVIDENCE/workflow-flows/`, the `active card` line in the journal, and the
cancelled run record in `workflow-runs/`.

## Gotchas

- The palette hotkey matcher requires `metaKey` exactly: press `Meta+k`,
  also on Linux.
- Two `NEEDS YOU` regions and two step strips (sidebar row and card) exist
  while the section is open; page-wide `getByRole` locators for them hit a
  strict-mode violation. Close the section before later scenarios.
- Earlier `browser-hang` runs (from `hang-cancel`) already sit under Recent
  runs with the same card name; compare counts instead of waiting for one
  card.
- Cost reads `—` for the fake agent: it reports no cost.
- Elapsed reads `0s` on the fake runs: they finish in about 0.5 s (compare
  `startedAt`/`finishedAt` in the run records). Ticking is covered by the
  jsdom fake-timer test in `WorkflowsView.test.tsx`.
- The hotkey matcher compares `e.key`. Playwright's `Meta+Alt+w` sends key
  `w`, so the drive proves the binding and handler, not how a physical macOS
  Option key maps `e.key` (same for the existing Cmd+Alt+P / Cmd+Alt+R).
- `launch-target` uses `browser-hang` because a done run has no strip; a
  shell definition would finish before the strip assertion.
- It runs after `repo-trust`: earlier scenarios find the scratch repo by its
  row and assume it is the active worktree.
- The collapsed-sidebar button is covered by `CollapsedSidebar.test.tsx`
  (jsdom), not by the drive.
