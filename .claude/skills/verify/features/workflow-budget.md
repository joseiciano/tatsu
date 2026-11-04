# Workflow budget

A run can carry a USD budget (`budgetUsd` on `workflows:startRun`, finite,
greater than 0 and at most 10000). The runner sums the measured cost of the
run's attempts at Stop frequency; when the total reaches the cap the run
pauses with reason `budget`. Live attempts keep running (soft pause), but
nothing new starts: no next step, no queued continuation, no loop
re-entry. Explicit Retry, Resume and Swap still launch. The user raises the
budget to continue; a cap at or below the spend is recorded but the run
stays paused. Costs are best-effort: opencode steps report none, and the
cost of a turn lands after its Stop, so a run can overshoot the cap.

## Sub-features

- **Needs you row**: `<worktree> · Budget reached` with a second line
  `Spent $<spend> of $<cap>`, no step name and no `Jump to tab` (the pause
  belongs to the run, not a step). A number field `New budget in USD:
  <workflow> on <worktree>` (until the user types, it suggests double the
  larger of the spend and the cap, at least one cent above the spend, max
  10000, and follows the spend as late costs land), a `Raise budget` button named `Raise budget: <workflow> on
  <worktree>` (disabled while the amount is not above the spend or is over
  10000), and `Cancel run`.
- **Run detail**: Actions list the same number field (`New budget in USD`)
  and `Raise budget` button, plus `Cancel step` for a live step and `Cancel
  run`. The graph marks no step `needs you`, and the step strip shows no
  `!` for a budget pause.
- **Run card**: the Cost cell reads `$<spend> of $<cap>` when the run has a
  budget.
- **Settled run**: if the last step's cost crosses the cap, the run stays
  paused until Raise budget, which then finishes it.
- **Restart**: a budget-paused run stays paused after a server restart;
  Raise budget resumes it.

## How to get to it (user POV)

1. Turn on Labs workflows in Settings (seeded by `launch.sh`).
2. Start a run with a budget (the launch sheet has no budget field yet, so
   start it over the transport: `workflows:startRun` with `budgetUsd`).
3. When the spend reaches the cap, the NEEDS YOU row reads `Budget
   reached`. Type a higher amount and press `Raise budget`.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `budget` (after `loop-cap`, before `repo-trust`): starts
    `smoke-budget` over WS with `budgetUsd: 0.01` (setup only; the page
    never calls `window.api`) -> waits for the record paused `budget` with
    `spend` done and `settle` pending -> Needs-you row `Budget reached` with
    `Spent $0.0x of $0.01`, strip `Workflow steps: spend done, settle pending`, `Cancel
    run: smoke-budget on repo`, no `Jump to tab` -> the untouched suggestion
    is above the spend and Raise budget is enabled -> fills `New budget in
    USD: smoke-budget on repo` with `0.01` (Raise budget disabled), then
    `1` -> `Raise budget: smoke-budget on repo` -> the record is `done`
    with `budgetUsd` 1 and one `settle` attempt done, the row and the step
    strip detach and the on-disk record reads `done` / `budgetUsd: 1`. A `finally` cancels a
    live run and closes the `⚙ spend` tab.
- WS: `scripts/workflow-smoke.mjs` `scenarioBudget` (in `pnpm
  build:headless && bash scripts/smoke-headless.sh`) asserts the same pause
  and `workflows:setBudget` to 1 -> `done`.

End state that proves it: `budget-01-needs-you-budget.png` and
`budget-02-run-done.png` in `$EVIDENCE/workflow-flows/`, the journal lines
`budget: run <id> paused budget at $<spend> of $0.01 with spend done and
settle pending; Raise budget enabled at the suggested $<n>, disabled at
$0.01`, `budget: run <id> done
after Raise budget to $1 from Needs you; settle ran once; record budgetUsd
1` and `budget OK`.

## Gotchas

- `smoke-budget`'s prompt carries `FAKE_AGENT_COMPLETE_DELAY_MS=500` so the
  pre-complete Stop's $0.06 reaches the runner before `complete_step`;
  without it the shell step can start first and the run can finish before
  the cost lands.
- The $0.03 tail arrives after `complete_step`; raise the budget well above
  $0.09 (the scenario uses $1) or the tail pauses the run again.
- While the Workflows section is open the page has two `NEEDS YOU` regions;
  scope locators to one of them.
