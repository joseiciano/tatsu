# Templates and fragments

On the Config **Templates** tab the user writes one template, built from a
body, shared fragments, and per-harness blocks. Tatsu renders it into each
harness's file and syncs the rendered output through the same confirmed plan
flow (Steps 18–21).

## Sub-features

- The `Create agent template`, `Create skill template`, `Create command template`,
  and `Create fragment` buttons.
- The editor fields are `#template-name`, `#template-kind`,
  `#template-description`, Fragments, Body, and Harnesses. Fragments can be
  reordered (`Move <name> up` / `down`) and removed (`Remove <name>`). Add one
  with the `Fragment to add` select.
- The live `Preview` pane shows the rendered output. `Problems to fix before
  saving` and `Render errors` list validation problems.
- An unsaved template shows an `Unsaved` marker. Editing a template that
  changed on disk asks before overwriting.
- `Delete template` and `Delete fragment` remove a template or fragment.
- Rendered files carry no provenance marker; Tatsu matches them to templates by
  output path. The inventory rows link back
  through `Edit template <ref>`.

## How to get to it (user POV)

1. Open Config, then the **Templates** tab.
2. Create or select a template, edit it, and save.
3. Use the `Sync <Harness>` button on the resource tabs to write the rendered output.

## Driving it with Playwright

```js
await openConfig(page)
await page.getByRole('tab', { name: 'Templates' }).click()
await page.getByRole('button', { name: 'Create skill template' }).click()
await page.locator('#template-name').fill('greet')
await page.locator('#template-description').fill('Greet the user.')
// Body is a Monaco editor: click into it, then page.keyboard.type(...)
await shot('preview')
// save, then Skills tab -> Sync <Harness> -> Sync to disk
```

The end state that proves it works:

- The template file exists under `DATA_DIR/harness-config-source/`.
- After sync, `SANDBOX_HOME/.claude/skills/greet/SKILL.md` exists with the
  rendered body and no `tatsu-template` marker.
- The inventory row offers `Edit template …`.

## Gotchas

- Body and fragment text are Monaco editors, not `<textarea>`. Use
  `page.keyboard`, and wait for the preview to update before asserting.
- The template source folder is in `DATA_DIR`, not `HOME`. Check both after a sync.
- Run: `journeys/template-render-sync.mjs`. The template lands at
  `DATA_DIR/harness-config-source/skills/greet/TEMPLATE.md`; the rendered
  `SKILL.md` has no `tatsu-template` marker (renderer version 3); the row
  offers `Edit template skill/greet`. Harness checkboxes are
  `#template-harness-<claude|codex|opencode>`; the create button is `Create`
  (exact). The body editor is the first `.monaco-editor` on the page.
- Run: `journeys/template-fragments.mjs`. Fragments render after the body in
  list order; `Move <name> up` reorders both the preview and `TEMPLATE.md`;
  editing a template whose file changed on disk asks "changed in the source
  folder since you opened it"; deletes leave `*.x-backup-<timestamp>` files.
- `Create fragment` and the template editor both use a `Create` button and
  `.monaco-editor` index 0; only one editor is open at a time.

## Inline fragment placeholders

A `{{fragment:name}}` line in a skill, agent, or command file (or a template
body) is expanded on Save into a marked section:

```
<!-- tatsu:fragment name sha=<12 hex> -->
...fragment text...
<!-- /tatsu:fragment name -->
```

- The editor shows a hint starting `Saving turns each` while the draft has a
  placeholder or marker.
- The fragment editor lists the files that use it in
  `[data-testid="fragment-usage"]` ("Used in N file(s): …").
- Saving a fragment never writes harness files. The scopes that use it show
  `Content changed` in the sync dialog until `Sync to disk`.
- A section edited by hand appears under `Edited fragment sections` in the
  sync dialog, with `Use fragment`, `Save edit to fragment`, and `Detach`.
- Run: `journeys/inline-fragments.mjs` against a Step 23 build. The section
  sha changes after a fragment sync; text outside the section is untouched;
  opening Sync leaves the hand edit on disk, and `Use fragment` writes the
  file back byte for byte. A file whose only issue is an edited section shows
  no badge on its row while the scope reads `Out of sync`.
