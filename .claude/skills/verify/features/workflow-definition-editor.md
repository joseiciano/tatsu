# Workflow definition editor

From the Workflows section's `Library` tab, `Edit <name>` or `New workflow`
replaces the list with a Monaco YAML editor. The renderer runs the shared
workflow validator on the draft and shows its diagnostics as squiggles and
as a problems list. Save writes the file through `workflows:saveDefinition`.

## Sub-features

- **Open**: `Edit <name>` fetches the source with
  `workflows:getDefinition` (status `Loading workflow definition…`; a
  missing definition shows an alert `This workflow definition no longer
  exists.`). `New workflow` starts from a template (`name: new-workflow`,
  one shell step `hello`) that validates clean. Heading `Edit <name>` or
  `New workflow`; the line under it shows the file path (repo: `<repo> ·
  <path>`) or `Not saved yet`, plus `Unsaved changes` while dirty.
- **Live validation**: `validateWorkflowDefinition(source)` with no options
  (the same default features as the loader), 250 ms after the last edit.
  Each diagnostic becomes a Monaco marker (`.squiggly-error` /
  `.squiggly-warning`) spanning the token at its line/column, falling back to
  the nearest non-blank line when the position is past the end. The region
  `Problems` reads `No problems` or `N problems · cannot be run` with
  `Line L: <message>` items.
- **Save** (personal or new definitions; also Cmd/Ctrl-S): personal
  definitions save back by id; a New draft saves into the personal folder
  under the YAML `name:` (or the `File name` field when filled, required
  when the YAML does not parse). After the first save the editor tracks the
  returned id, so later saves overwrite the same file.
- **Save to repo**: on a personal or new draft it writes a new file into
  the active worktree's repository (`aria-disabled` with `Select a worktree
  to save this workflow to its repository.` when none). On a repo
  definition it is the only save button and writes back to its own repo by
  id. Every repo save asks first (`Save to the repository?`): teammates and
  the user must trust the new version before running it. A repo without a
  `.harness/workflows` folder answers `no-repo-dir`; the alert tells the
  user to create and commit the folder or save to personal, and the draft
  stays.
- **Save with errors**: needs a confirm `Save with problems?` saying `This
  definition has N problems and cannot be run.` (combined with the repo
  warning on repo saves). Dialogs are focus-trapped `alertdialog`s with
  initial focus on `Keep editing`.
- **Discard guard**: with unsaved changes, `Back to Library`, clicking
  either tab, the section `Back` button and the Workflows toggle (sidebar
  button, hotkey, palette action) open `Discard unsaved changes?` (`Keep
  editing` / `Discard changes`). Other App exits (selecting a worktree from
  the sidebar, Activity or palette, opening Command Center or another
  full-screen view, jumping to a step tab, a workflow start) close the
  section without asking.

## How to get to it (user POV)

1. Turn on Labs workflows (seeded by `launch.sh`).
2. Click the sidebar `Workflows` button, then the `Library` tab.
3. Click `New workflow`, edit the YAML, watch the problems list, click
   `Save`; go `Back to Library` and the new row shows under Personal.

## Driving it with Playwright

- `journeys/workflow-flows.sh <state>` (runs `scripts/browser-smoke.mjs`):
  - `definition-editor` (after `library`, before `launch-target`): sidebar
    `Workflows` -> tab `Library` -> `New workflow` -> paste a valid
    `zz-editor-smoke` source with step `draft` -> `Save` -> status `Saved
    to your personal workflows`, `$HARNESS_DATA_DIR/workflows/zz-editor-smoke.yaml`
    holds `id: draft`, heading `Edit zz-editor-smoke` -> `Back to Library`
    (no discard dialog), the Personal row reads `1 step: draft` -> `Edit
    zz-editor-smoke` loads the saved source -> paste step `edited` with
    `run: echo {{steps.bogus.summary}}` -> `.squiggly-error` appears and
    `Problems` names `"bogus"` -> paste the fix -> squiggle gone, `No
    problems` -> `Save` (overwrites by id) -> file holds `id: edited` ->
    `Back to Library` -> the row reads `1 step: edited` and the slice holds
    one `zz-editor-smoke` (same id). `finally` deletes the file over WS
    (`workflows:deleteDefinition`) and closes the section, discarding a
    dirty draft if needed.

End state that proves it: `definition-editor-0*.png` in
`$EVIDENCE/workflow-flows/` (`04-marker` shows the squiggle), the journal
lines `definition-editor: unknown step ref marked (.squiggly-error) …`,
`marker cleared after the fix` and `Save from Edit overwrote … Library row
reads "1 step: edited"`, and no `zz-editor-smoke.yaml` left in the data dir.

## Gotchas

- Monaco rejects `.fill()`, and `keyboard.insertText` goes through Monaco's
  typing path, so auto-indent mangles nested YAML. The scenario focuses
  `.view-lines`, selects all with `ControlOrMeta+a`, then dispatches a
  `paste` `ClipboardEvent` with a `DataTransfer` on the focused element
  (Monaco 0.55 uses the native EditContext div, not a textarea).
- Non-linear `needs` is rejected under default features
  (`unsupported-feature`), so the bad edit is a template reference to an
  unknown step, which is `unknown-ref` (error) in a linear definition.
- `zz-editor-smoke` sorts last and matches none of the later lookups
  (`/^target/`, `browser-hang`, `smoke`); the launch sheet's default is the
  first valid definition by name.
- The `Saved to …` status is hidden while the draft is dirty and shows the
  same text after every save, so the scenario waits for the file content
  rather than the status after the second Save.
- Saving new content to a trusted repo definition leaves trust on the old
  hash, so the saved version is untrusted for this user too.
