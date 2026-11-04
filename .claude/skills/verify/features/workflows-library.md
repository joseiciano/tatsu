# Workflows library

The Workflows section's `Library` tab lists every loaded workflow
definition, grouped by where its file lives, and lets the user run,
duplicate or delete one.

## Sub-features

- **Groups**: one `section` per group, named by its `h2` (label plus a
  count; the section's accessible name is the label alone). Order: `This repo
  (<basename>)` for the active worktree's repo first (only when a worktree
  is active), then `Personal`, then every other registered repo by
  basename. A registered repo with no definitions still shows its group
  with `No workflows in this repository’s .harness/workflows folder.`
- **Rows**: name, `N steps: <ids>`, a `Problems in <name>` list with the
  summary issues, and for repo definitions a `Trusted` / `Untrusted` badge
  (trusted means `workflows.trust[id] === summary.hash`, so an edited file
  is untrusted again).
- **Run**: button `Run <name>` opens the launch sheet with that definition
  selected and, for a repo definition, its repository selected (no preset
  worktree, so the Target fieldset shows).
- **Duplicate**: button `Duplicate <name>` asks main to copy the definition
  into the personal folder as `<name>-copy` (then `-copy-2`, …), rewriting
  the YAML `name:`. For an untrusted repo definition the button is
  `aria-disabled` and described by `Trust it from Run before duplicating
  it.`; main refuses it too (`Trust this repo definition before duplicating
  it`).
- **Delete**: button `Delete <name>` opens an `alertdialog` (`aria-modal`,
  focus trapped, initial focus on Cancel) named `Delete “<name>”?` that
  shows the file path; for a repo definition it says the file is a
  committed file in the primary checkout. `Delete file` removes only that
  file; a refusal stays in the dialog as an alert.
- **Edit / New workflow**: button `Edit <name>` per row and a `New workflow`
  button above the groups open the definition editor in place of the list;
  see [workflow-definition-editor.md](workflow-definition-editor.md).

## How to get to it (user POV)

1. Turn on Labs workflows (seeded by `launch.sh`).
2. Click the sidebar `Workflows` button, then the `Library` tab.
3. Click Duplicate on a personal definition; the copy appears under
   Personal. Click its Delete, confirm `Delete file`; it disappears.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `library` (just before `launch-target`): sidebar `Workflows` -> tab
    `Library` (`aria-selected="true"`) -> region `/^Personal/` shows `Run
    smoke-retry`; the group headings include one starting `This repo` ->
    `Duplicate smoke-retry` -> `Run smoke-retry-copy` appears ->
    `$HARNESS_DATA_DIR/workflows/smoke-retry-copy.yaml` holds
    `name: "smoke-retry-copy"` and the slice has `personal:smoke-retry-copy`
    -> `Delete smoke-retry-copy` -> alertdialog `Delete “smoke-retry-copy”?`
    naming the summary path; Tab and Shift+Tab stay inside it -> `Delete
    file` -> dialog and row gone, file gone. `finally` deletes a leftover
    copy over WS (`workflows:deleteDefinition`) and presses Back.

End state that proves it: `library-0*.png` in `$EVIDENCE/workflow-flows/`,
the `library: duplicated …` and `library: deleted …` journal lines, and no
`smoke-retry-copy.yaml` left in the data dir.

## Gotchas

- `smoke-retry` is the source because `smoke-retry-copy` cannot match later
  option lookups (`/^target/`, `browser-hang`, `smoke`).
- The launch sheet's default option is the first valid definition by name;
  a leftover copy could change it, hence the cleanup in `finally`.
- Duplicate goes through `workflows:duplicateDefinition(defId)`; main reads
  the source and checks trust itself, so the browser cannot copy an
  untrusted repo definition. `workflows:saveDefinition` writes arbitrary
  YAML; the `definition-editor` scenario drives it from the editor's Save.
- Repo saves need an existing `.harness/workflows` in the primary checkout;
  main never creates it.
