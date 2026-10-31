# Tatsu feature map

One file per user-facing feature. Each file says what the feature is, how a
user reaches it, how to drive it with the `verify` Playwright harness, and
what end state proves it works. Journeys reuse `scripts/browser.mjs`.

| Feature | File | Scripted journey |
|---|---|---|
| Config page inventory | [config-inventory.md](config-inventory.md) | `journeys/prefixed-skill-read.mjs` (proven: a `skills-used` Claude skill lists and opens, and an Opencode agent opens beside it), `journeys/linked-root-path.mjs` (proven: files in a symlinked Opencode agents folder and the symlinked `linked-skill` show at the configured path, save through to the link target, and keep the link), `journeys/linked-command-delete.mjs` (proven: deleting a linked command removes its target and the link, and the name can be created again as a regular file) |
| Skill ↔ command conversion | [skill-command-conversion.md](skill-command-conversion.md) | `journeys/convert-skill-to-command.mjs`, `journeys/convert-command-to-skill.mjs` (proven: both directions for Opencode, Claude "already available" notice) |
| Sync to disk | [config-sync.md](config-sync.md) | `journeys/config-disk-source.mjs`, `journeys/config-edit-and-sync.mjs` (proven: no badges on hand-written files, editor Save, outside edits kept by Sync) |
| Config folders in Settings | [config-folders-settings.md](config-folders-settings.md) | `journeys/config-folders.mjs` (proven: both entry points, relative-path rejection, override, reset) |
| Templates and fragments | [templates.md](templates.md) | `journeys/template-render-sync.mjs`, `journeys/template-fragments.mjs` (proven: create, fragments, reorder, remove, outside-change prompt, deletes, sync), `journeys/inline-fragments.mjs` (proven: `{{fragment:x}}` in a skill expands on Save, a fragment change reaches the file only through Sync, a hand-edited section is resolved with Use fragment) |
| Import existing setup | [import-existing-setup.md](import-existing-setup.md) | `journeys/import-existing-setup.mjs`, `journeys/import-full-setup.mjs` (proven: every folder kind) |

Unless a file says a step was run, its selectors and end states come from
reading the source. Treat them as a starting point, not as proof. The first
run that exercises one should fix the file and mark it as run.

Not yet mapped: worktrees, terminal and chat tabs, PR status, the Command
Center tabs, and browser panes. Add a file here when you first prove one of
them.
