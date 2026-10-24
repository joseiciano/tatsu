# Sync Tatsu config with disk

Per harness and resource type, Tatsu compares its stored config with the
files on disk. The user then pushes Tatsu's version to disk, or adopts the
disk files into Tatsu.

## Sub-features

- The `Sync <Harness>` button (for example `Sync Claude Code`) opens the sync
  dialog. The dialog lists each file with hashes; hover a hash for its full label.
- **Adopt current disk files into Tatsu config** stores the disk version.
  Badges then turn from `Disk only` to `Synced`.
- **Sync Tatsu config to disk** writes the stored version to disk.
- `Managed elsewhere` (symlinked) rows are listed but never written.
- While the plan runs, the dialog shows `Preparing plan…` and then `Applying…`
  (`aria-busy`).

## How to get to it (user POV)

1. Open Config and pick a tab.
2. Press the circular-arrows icon in a harness group header.
3. Review the plan, then choose Adopt or Sync, or `Cancel` / `Close`.

## Driving it with Playwright

```js
await openConfig(page)
await page.getByRole('tab', { name: 'Skills' }).click()
await page.getByRole('button', { name: 'Sync Claude Code' }).click()
await shot('plan')
await page.getByRole('button', { name: 'Adopt current disk files into Tatsu config' }).click()
await page.getByRole('dialog').waitFor({ state: 'detached' })
```

The end state that proves it works:

- **Adopt:** the `hello` and `run-tests` badges read `Synced`.
  `DATA_DIR/config.json` now contains those resources.
  The files under `SANDBOX_HOME/.claude` are byte-identical to before.
- **Sync to disk:** edit a resource in Tatsu first, then sync. The disk file
  changes to Tatsu's content.
- **Both:** `linked-skill`'s target under `<scratch>/dotfiles` is untouched.
  Hash it before and after.

## Gotchas

- Run: `journeys/config-sync-adopt.mjs` proves Adopt for Claude skills.
  Badges flip to `Synced` (including `linked-skill`, which keeps `Managed
  elsewhere`), `DATA_DIR/config.json` gains the resources, and `~/.claude`
  plus the dotfiles target stay byte-identical. Sync to disk is proven for a
  template by `journeys/template-render-sync.mjs`; syncing an edited plain
  resource is still unproven.
- Plans go stale when a root changes (Step 16). Re-open the dialog after
  changing Config folders.
- Hash both files before and after an action. Don't trust the badge alone.
