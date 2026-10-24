# Tatsu feature map

One file per user-facing feature. Each file says what the feature is, how a
user reaches it, how to drive it with the `verify` Playwright harness, and
what end state proves it works. Journeys reuse `scripts/browser.mjs`.

| Feature | File | Scripted journey |
|---|---|---|
| Config page inventory | [config-inventory.md](config-inventory.md) | none yet |
| Skill ↔ command conversion | [skill-command-conversion.md](skill-command-conversion.md) | `journeys/convert-skill-to-command.mjs`, `journeys/convert-command-to-skill.mjs` (proven: both directions for Opencode, Claude "already available" notice) |
| Sync Tatsu config with disk | [config-sync.md](config-sync.md) | `journeys/config-sync-adopt.mjs`, `journeys/config-edit-and-sync.mjs` (proven: Adopt, editor Save, Sync to disk over an outside edit) |
| Config folders in Settings | [config-folders-settings.md](config-folders-settings.md) | `journeys/config-folders.mjs` (proven: both entry points, relative-path rejection, override, reset) |
| Templates and fragments | [templates.md](templates.md) | `journeys/template-render-sync.mjs`, `journeys/template-fragments.mjs` (proven: create, fragments, reorder, remove, outside-change prompt, deletes, sync) |
| Import existing setup | [import-existing-setup.md](import-existing-setup.md) | `journeys/import-existing-setup.mjs`, `journeys/import-full-setup.mjs` (proven: every folder kind) |

Unless a file says a step was run, its selectors and end states come from
reading the source. Treat them as a starting point, not as proof. The first
run that exercises one should fix the file and mark it as run.

Not yet mapped: worktrees, terminal and chat tabs, PR status, the Command
Center tabs, and browser panes. Add a file here when you first prove one of
them.
