# Tatsu feature map

One file per user-facing feature. Each file says what the feature is, how a
user reaches it, how to drive it with the `verify` Playwright harness, and
what end state proves it works. Journeys reuse `scripts/browser.mjs`.

| Feature | File | Scripted journey |
|---|---|---|
| Config page inventory | [config-inventory.md](config-inventory.md) | none yet |
| Skill ↔ command conversion | [skill-command-conversion.md](skill-command-conversion.md) | `journeys/convert-skill-to-command.mjs` (proven) |
| Sync Tatsu config with disk | [config-sync.md](config-sync.md) | none yet |
| Config folders in Settings | [config-folders-settings.md](config-folders-settings.md) | none yet |
| Templates and fragments | [templates.md](templates.md) | none yet |
| Import existing setup | [import-existing-setup.md](import-existing-setup.md) | none yet |

Not yet mapped: worktrees, terminal and chat tabs, PR status, the Command
Center tabs, and browser panes. Add a file here when you first prove one of
them.
