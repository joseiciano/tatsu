# Import existing setup

A wizard that reads an existing file-based setup and turns it into Tatsu
templates and fragments (Step 22). The setup is folders of agents, fragments,
skills, shared references, and commands. The wizard previews everything and
writes nothing until confirmed, and the source folders are never changed.

## Sub-features

- Folder inputs `#import-folder-agents`, `#import-folder-agentFragments`,
  `#import-folder-skills` (plus `Add skill folder`, which adds
  `#import-folder-skills-<n>`), `#import-folder-references`, and
  `#import-folder-commands`.
- `Preview import` (it reads `Reading…` while busy) shows these sections:
  - Templates and fragments
  - Skills in more than one source folder
  - Commands covered by a skill
  - Stored config the import will hide
  - Templates that will not render yet
  - Files not imported
  - Rendered files compared with the harness folders
- `Import` is disabled while the preview reports blocking reasons. After
  import, the wizard shows "Scopes that now differ from disk".
- `Close import` closes the wizard.

## How to get to it (user POV)

1. Open Config, then the **Templates** tab.
2. Press **Import existing setup…**.
3. Fill the folder paths, preview, then import.

## Driving it with Playwright

```js
await openConfig(page)
await page.getByRole('tab', { name: 'Templates' }).click()
await page.getByRole('button', { name: 'Import existing setup…' }).click()
await page.locator('#import-folder-skills').fill(`${state.SCRATCH}/import-source/skills`)
await page.locator('#import-folder-commands').fill(`${state.SCRATCH}/import-source/commands`)
await page.getByRole('button', { name: 'Preview import' }).click()
await shot('preview')
await page.getByRole('button', { name: 'Import', exact: true }).click()
```

The end state that proves it works:

- `deploy-check` and `pr-summary` templates exist under
  `DATA_DIR/harness-config-source/` and appear on the Templates tab.
- `<scratch>/import-source` is byte-identical to before. Hash it on both sides.
- The harness folders are untouched until the user syncs.

## Gotchas

- The seed has no agents, fragments, or references folders, so those preview
  sections stay empty. Add fixtures to `seed.sh` before proving them.
- Run: `journeys/import-existing-setup.mjs`. Import asks a `window.confirm`
  ("Import 2 templates and fragments…"), which `browser.mjs` accepts. Output
  is `skills/deploy-check/TEMPLATE.md` and `commands/pr-summary.md` under the
  template source folder; the import source and the sandbox HOME stay
  byte-identical.
