# Sync to disk

Disk is the source for hand-written agents, skills, and commands: Tatsu
keeps no copy of them. Per harness and resource type, Tatsu compares the
files on disk with what templates build and with each file's fragment
sections refreshed. Sync writes the difference to disk.

## Sub-features

- The `Sync <Harness>` button (for example `Sync Claude Code`) opens the sync
  dialog when the scope differs. On a scope with nothing to write it shows an
  `Already in sync` notice instead.
- The dialog lists `Not on disk` (template output missing from disk) and
  `Content changed` (template output or fragment sections that differ), with
  hashes; hover a hash for its full label.
- **Sync to disk** creates and overwrites those files, backing up each file it
  overwrites. It never deletes a file.
- For each template file that differs on disk, a radio pair picks
  `Overwrite it from the template` or `Keep the disk file and detach it from
  the template`. Detach leaves the file alone and stops the template
  targeting that harness.
- Row badges: none when a file is in sync, `Not on disk`, `Out of sync`.
- `Linked` (symlinked) rows sync like any other; the write lands in the link's
  target and the link stays a symlink.
- While the plan runs, the dialog shows `Preparing plan…` and then `Applying…`
  (`aria-busy`).

## How to get to it (user POV)

1. Open Config and pick a tab.
2. Press the circular-arrows icon in a harness group header.
3. Review the plan, then choose `Sync to disk`, or `Cancel` / `Close`.

## Driving it with Playwright

```js
await openConfig(page)
await page.getByRole('tab', { name: 'Skills' }).click()
await page.getByRole('button', { name: 'Sync Claude Code' }).click()
await page.getByText('Already in sync').first().waitFor()   // seeded scope, nothing to write
```

The end state that proves it works:

- **Hand-written files:** the seeded skills carry no badge, Sync reports
  `Already in sync`, and `SANDBOX_HOME/.claude`, the dotfiles target, and
  `DATA_DIR/config.json` are unchanged.
- **Templates and fragments:** after a template or fragment change, Sync to
  disk writes the new output; files outside the template stay untouched.
- **Both:** `linked-skill`'s target under `<scratch>/dotfiles` is untouched.
  Hash it before and after.

## Gotchas

- Run: `journeys/config-disk-source.mjs` proves the seeded Claude skills have
  no badge, Sync is a no-op notice, and nothing on disk or in `config.json`
  changes. `journeys/config-edit-and-sync.mjs` proves editor Save writes the
  disk file and an outside edit shows in the editor, gets no badge, and
  survives Sync. Sync to disk for a template is proven by
  `journeys/template-render-sync.mjs`, and for fragment sections by
  `journeys/inline-fragments.mjs`.
- `config.json` from older builds may still hold a `harnessConfig` key with
  saved copies. Tatsu no longer reads or writes it.
- Plans go stale when a root changes (Step 16). Re-open the dialog after
  changing Config folders.
- Hash both files before and after an action. Don't trust the badge alone.
