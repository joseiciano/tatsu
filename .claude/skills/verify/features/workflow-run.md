# Workflow run

Labs workflows let a user run a personal or repo definition on a worktree. Agent and
shell steps run in step tabs; the worktree row shows a step strip while the
run is live, and paused runs appear under NEEDS YOU in the sidebar.

## Sub-features

- **Launch sheet**: right-click a worktree row -> `Run workflow here…` ->
  dialog `Run workflow` with a `Workflow` select and `Start`. Shown only with
  Labs workflows on and no live (queued, running, paused) run on that path.
  The sheet also opens from the Workflows section's `Run workflow…` button
  (see workflows-section.md). After a successful Start the sheet closes,
  Tatsu selects the target worktree (`aria-current="true"` on its sidebar
  row) and closes the Workflows section.
- **Target**: depends on how the sheet opened.
  - Preset (`Run workflow here…`): the target is that worktree, shown
    read-only in the header (`in <worktree>`), with no Target controls.
    Focus starts on the `Workflow` select.
  - No preset (`Run workflow…`): the header reads `Choose where it runs` and
    a fieldset `Target` holds a `Repository` select (registered repos), a
    radio group `Where to run` (`New worktree`, the default, or
    `Existing worktree`), then either a `Branch name` input (default
    `wf/<definition>/<8 hex>`, live-sanitized, `aria-invalid` and Start
    disabled when the name breaks the branch rules) or a `Worktree` select
    (that repo's worktrees without a live run). Focus starts on
    `Repository`.
  - The `Workflow` select lists personal definitions plus the target repo's
    definitions only.
  - New worktree: Start creates the worktree through `worktrees:runPending`
    (no agent, no initial prompt), then starts the run on the created path.
    A creation error shows inline and nothing starts. A start refusal after
    creation shows inline and switches the target to `Existing worktree` on
    the created worktree, so the next Start does not create another one.
    The pending sidebar entry is dismissed for `setup-failed` and `error`
    while the sheet is open.
  - The server refuses `worktrees:runPending` for a repoRoot that is not
    registered and for a branch name that fails `git check-ref-format
    --branch` or the shared rules (leading `-`, `..`, backslash, `@{`,
    empty, over 200 chars).
- **Overrides**: a collapsed section in the launch sheet for a definition
  with agent steps (hidden otherwise). Toggle button `Overrides` (`Overrides
  (<n> changed)` once a value differs) with `aria-expanded` and
  `aria-controls`. One row per agent step: `Agent for <stepId>` select
  (supported step harnesses only) and `Model for <stepId>` text input
  (prefilled with the definition model for the same agent; empty with
  placeholder `Agent default` after an agent change, since the server drops
  the old model). Only changed values go to `startRun` as `overrides`; no
  `overrides` key when nothing changed. Readiness uses the overridden steps,
  so overriding to Codex shows `Open a Codex tab and run /hooks`; an
  over-long model shows `Model for <stepId> is too long`. The trust panel
  still shows the definition's own steps. Drafts reset when the workflow
  changes and survive the switch to `Existing worktree` after a refusal.
  The run record's `overriddenFrom.<stepId>` holds the original agent/model.
- **Input pickers**: definition inputs of type `issue`, `pr` and `file`
  render as one combobox (`role="combobox"`, `aria-expanded`,
  `aria-controls` -> `role="listbox"` labelled `<input> options`,
  `aria-activedescendant` on the active `role="option"`), labelled by the
  input's `<name><type>` label (accessible name e.g. `targetfile`).
  ArrowDown opens and moves, ArrowUp moves, Enter picks the active option
  (does not submit), Escape closes only the list (a second Escape closes
  the sheet). Typing after a pick clears the value, so Start shows
  `Fill in <name>` until a listed option is picked.
  - `file`: lists `listAllFiles` of the target (preset worktree, chosen
    existing worktree, or the repo's primary checkout for a new worktree),
    fuzzy-filtered, at most 50 options; absolute and `..` paths are never
    offered. Value: the repo-relative path. A pick is cleared when the
    target changes to one that does not list it.
  - `pr`: `listRepoPRs(root, { requireToken: true })` (null without a
    resolved token, no request) filtered by number, title or branch; value: the
    number as a string. A typed `#<n>` not in the list is offered as
    `#<n>` / `Use this number`.
  - `issue`: `listRepoIssues` (`github:listIssues`, REST search, open issues
    only, PRs excluded, at most 50; typed qualifiers like `repo:x`, quotes
    and `AND`/`OR`/`NOT` are dropped), searched 250 ms after typing stops.
  - Fallback: when the first load cannot list (no token, no GitHub
    `origin`, any error; PR list `null`), the input is a plain number field
    (`inputmode="numeric"`, digits only) with the hint `GitHub isn't
    available here. Enter the <issue|pull request> number.` The scratch
    sandbox has no token and no `origin`, so issue and PR inputs are always
    number fields there.
  - Untrusted author: 250 ms after an `issue`/`pr` value settles, the sheet
    calls `workflows:checkInputTrust(root, type, number)`. Any verdict other
    than trusted (`OWNER`/`MEMBER`/`COLLABORATOR`), including no `origin`,
    no token or an error, shows `role="status"` under the field: `This
    issue's author is not a collaborator: steps will run with at most edit
    permissions` (`This pull request's …` for `pr`). A definitive untrusted
    verdict drops the `Allow full access` checkbox when every `full` step is
    capped. At Start, main looks the author up again itself and, unless
    trusted, caps every `full` agent step to `edit` in the run snapshot and
    sets `inputsUntrusted: true` on the run record. The sandbox has no
    `origin`, so the notice always shows there and no `gh` or network runs.
- **Step strip**: `role="img"` under the branch name, `aria-label`
  `Workflow steps: <id> <status>, …`. Only for a live run; it disappears when
  the run is done, failed or cancelled.
- **Needs you**: sidebar section `NEEDS YOU` with one row per paused run:
  workflow name, `<worktree> · <reason> · <stepId>`, and action buttons
  (`Jump to tab`, `Resume`, `Retry`, `Retry from clean`, `Skip`, `Cancel run`).
  `Retry from clean` shows only once the run record says the failed step's
  latest attempt has a base snapshot.
- **Step tab close**: closing a step tab whose attempt is running asks
  `Cancel step “<id>”?` (`alertdialog`); `Cancel step and close tab` cancels
  the step (run pauses step-failed, step cancelled), then closes the tab.
- **Repo definition trust**: a definition from
  `<repo>/.harness/workflows/` shows as `<name> (repo)` in the launch sheet.
  Until its current bytes are trusted, the sheet shows a region
  `Trust this repo workflow?` with a step table (Step, Agent, resolved
  Permission; shell steps read `shell`), the source in a scrollable `<pre>`
  labelled `Definition source`, and a `Trust this definition` button; Start
  stays disabled with `Trust this definition to start it`. Trusting records
  `{ repoRoot, path, hash }` in `config.json` `workflowTrust` and the slice
  `workflows.trust[defId]`. Any edit to the file asks again; the server
  refuses Start with `Trust this definition before running it`.
- **Step result overlay**: when a step tab's process exits, the tab shows
  `<Agent> exited.` with Step, Status, Completed by and Summary; for a paused
  run whose cursor is on that step, a `Mark step done` form completes it.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings and accept hooks (seeded by `launch.sh`).
2. Put a definition in the personal workflows folder (seeded).
3. Right-click the worktree in the sidebar, choose `Run workflow here…`, pick
   the definition, press Start.
4. Watch the strip; open the step tab in the tab bar; act on NEEDS YOU rows.

## Driving it with Playwright

- `journeys/workflow-run.mjs <state> smoke`: launch sheet -> Start ->
  strip shows `plan running, echo pending` -> strip disappears -> run record
  `status: done` -> step tab `⚙ plan · Claude` in the tab bar.
- `journeys/workflow-run.mjs <state> smoke-codex`: same path for a Codex
  agent step then a shell step; step tab `⚙ plan · Codex`. The run record's
  `plan` attempt carries the session id the fake codex reported through its
  SessionStart hook, and `continuations: 1` when curl is present.
- `journeys/workflow-run.mjs <state> smoke-opencode`: same path for an
  opencode agent step then a shell step; step tab `⚙ plan · opencode`. The
  run record's `plan` attempt carries the `ses_…` session id the plugin
  reported on the first busy event, and `continuations: 1` (the plugin's
  stop-check uses `fetch`, so it does not depend on curl).
- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `launch-sheet-focus`: open the launch sheet -> focus starts inside ->
    Tab, then Shift+Tab, pressed (focusables + 3) times each keeps
    `document.activeElement` inside the dialog -> Escape closes it.
  - `hang-cancel`: start `browser-hang` -> strip `hang running` -> close tab
    `⚙ hang · Claude` -> `Cancel step and close tab` -> Needs-you row
    `repo · Cancelled by user · hang` with `Cancel run: browser-hang on repo`
    visible and enabled, strip `hang paused` -> run record paused
    step-failed with a cancelled attempt -> `cancelRun` over WS -> row and strip
    gone.
  - `exit-mark-done`: start `browser-exit` -> Needs-you row
    `repo · Step failed · exit` -> `Jump to tab` -> overlay `Claude Code
    exited.` with Status `failed`, Completed by `process exit` -> Mark step done
    with a summary -> overlay shows Status `done`, Completed by
    `you (Mark done)` and the summary; form, row and strip gone -> run record
    `done`, last `exit` attempt completed by `user`.
  - `launch-overrides`: open the launch sheet -> pick `smoke` -> `Overrides`
    is `aria-expanded="false"` -> expand -> `Agent for plan` = opencode,
    `Model for plan` = `fake/opencode-model` -> `Overrides (1 changed)` ->
    Start -> a new `⚙ plan · opencode` step tab -> run record `done` with
    `overriddenFrom.plan.agent: claude`, `plan` step opencode with that model
    and attempts `1:opencode:done`.
  - `input-pickers`: open the launch sheet -> pick `browser-file` (inputs
    `target: file`, `ticket: issue`; shell step `test -f
    {{inputs.target}}`) -> focus the `target` combobox -> type `picker` ->
    option `docs/picker-target.md` (committed in the scratch repo) ->
    ArrowDown makes it `aria-selected` -> Enter -> list closed, sheet still
    open, input shows the path -> `ticket` is a numeric number field (no
    token) -> fill `7` -> Start -> run record `done` with
    `inputs: { target: "docs/picker-target.md", ticket: "7" }`. Run detail
    does not show inputs; the record and the passing `test -f` are the
    evidence.
  - `launch-target` (runs last): see workflows-section.md.
  - `repo-trust`: append a nonce comment to the committed
    `.harness/workflows/browser-repo.yaml` (fresh bytes, so it is untrusted on
    every run) -> open the launch sheet -> pick `browser-repo (repo)` ->
    region `Trust this repo workflow?` with the nonce in `Definition source`
    and rows `check|shell|shell`, Start disabled -> click
    `Trust this definition` in the UI -> panel gone, Start enabled -> Start ->
    strip `check running` -> run record `done` -> strip gone. The file is
    restored with `git checkout` afterwards.
- `scripts/workflow-smoke.mjs` (WS only, smoke-headless): `smoke-repo` start
  refused untrusted -> `trustDefinition` with a wrong hash refused -> trust
  with the `getDefinition` hash -> run done with `defHash` equal to it ->
  edit the file -> start refused again -> file restored.

End state that proves it: the screenshots in order, the strip `aria-label`
lines in `journal.log`, and the run record in `workflow-runs/`.

## Input pickers

How to reach it: open the launch sheet (`Run workflow here…` on a worktree
row, or `Run workflow…` in the Workflows section) and pick a definition with
an `issue`, `pr` or `file` input. The seeded `browser-file` has `target`
(file) and `ticket` (issue).

How to drive it:

1. Preset target (`input-pickers` in `workflow-flows.sh`): focus
   `getByRole('combobox', { name: /^target/ })`, type `picker`, ArrowDown
   (option `docs/picker-target.md` gets `aria-selected="true"`), Enter. The
   list closes, the sheet stays open, the input shows the path. `ticket` is
   a numeric field (`inputmode="numeric"`); fill `7`; wait for the
   untrusted-author `role="status"` notice under it; Start.
2. New worktree target (not in `workflow-flows.sh`; drive it with a small
   `withApp` journey): Workflows -> `Run workflow…` -> keep `New worktree`
   -> pick `browser-file` -> focus the `target` combobox -> ArrowDown. The
   `target options` listbox lists the scratch repo's primary checkout
   (`README.md`, `docs/picker-target.md`, the two committed repo
   definitions). Escape closes only the list; a second Escape closes the
   sheet.

End state: the run record `workflow-runs/<runId>.json` is `done` (the
`test -f {{inputs.target}}` step passed) with
`inputs: { target: "docs/picker-target.md", ticket: "7" }` and
`inputsUntrusted: true`. Run detail does not show inputs.

## Gotchas

- The input label renders `<name>` plus a `<type>` span with no space, so
  the accessible name concatenates (`targetfile`, `ticketissue`). Match it
  with `/^target/`, not the exact string.

- The menu item is hidden while the worktree has a live run; finish or cancel
  the previous run before starting another on the same path.
- The context menu is portalled and only opens when the row is visible:
  scroll the row into view, then wait for `role="menu"`.
- Right after boot the runner can answer start with "Tatsu is still starting"
  (seen by `scripts/workflow-smoke.mjs`, not yet in a browser drive); the
  launch sheet would show it as an error. Retry Start rather than sleeping.
- A done run has no strip; prove the done state from the strip and Needs-you
  row going away plus the run record.
- Mark done records a new attempt. The step tab's badge stays `failed` (it
  tracks the exited attempt); the overlay switches to the Mark done result.
- A Codex definition is refused at Start (`Open a Codex tab and run /hooks`)
  until Tatsu's Codex hooks are trusted in `CODEX_HOME/config.toml`; the seed
  trusts them in the scratch `CODEX_HOME` only.
- The repo definitions are committed in the scratch repo; an uncommitted
  edit there would show up in run snapshots. Restore any edit with
  `git checkout -- .harness/workflows`.
- Trust is per definition id and keeps only the latest hash. Trusting the
  nonce bytes in `repo-trust` makes the committed bytes untrusted again,
  so the scenario can run again on the same instance.
- A new worktree gets the usual default panes (default agent tab plus
  Shell) from `ensureInitialized`, because creation runs through the same
  FSM as the New worktree screen. In the sandbox the default `claude` tab
  runs the fake agent in default mode once the worktree is selected; it logs
  `FAIL: Stop hook did not return a block` to `fake-agent.log` (as the
  scratch repo's own default tab does at boot). That line is not a step
  failure.
- New worktrees land under `<repo>/../repo-worktrees/<branch>`; they are not
  removed after the drive. Claude folder trust covers them through the
  repo's git common dir, so the scratch `.claude.json` entry for the repo is
  enough.
- `exit-mark-done` needs curl: without it the Stop hook fails open and the
  step completes by fallback instead of failing.
