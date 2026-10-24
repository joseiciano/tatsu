# Config page inventory

The Config page lists every agent, skill, and command Tatsu can see for
Claude Code, Codex, and Opencode, grouped by harness, with a status badge per
resource. Pi is listed as deferred.

## Sub-features

- Tabs `Agents`, `Skills`, `Commands`, `Templates` in the `Resource type` tablist.
- The agent filter `#config-agent-filter` has the options All, Claude, Codex, and Opencode.
- Search (`Search resources` / `Search templates`) has a `Clear search` button.
- Badges include `Disk only` (on disk, not in Tatsu config) and `Synced`.
  A symlinked resource is marked `Managed elsewhere`; it is read-only (Step 17).
- Claude skills also appear under Commands, because Claude serves skills as slash commands.
- When a harness root is missing, the group shows "The resolver known root is
  unavailable" with a `Set config folders in Settings` link.

## How to get to it (user POV)

1. With no repository open, the onboarding screen has an **Open Config**
   card (`aria-label` starts with `Open Config:`). Every fresh `verify` run lands here.
2. With a repository open, the sidebar footer has a sliders icon labeled `Open Config`.
3. The Command Center has an Open Config action.
4. `Back` (or Esc) closes the page.

## Driving it with Playwright

```js
await openConfig(page)
await page.getByRole('tab', { name: 'Skills' }).click()
await page.getByRole('button', { name: /^hello/ }).first().waitFor()        // seeded Claude skill
await page.locator('#config-agent-filter').selectOption({ label: 'Opencode' })
```

The end state that proves it works:

- Every seed fixture appears in its harness group with `Disk only`.
- `linked-skill` shows `Managed elsewhere`.
- No group shows the unavailable-root message, because the seed creates all eight roots.
- Deleting a root folder under `SANDBOX_HOME` before launch makes that group show the message.

## Gotchas

- Run so far: entry point 1, the tabs, the seeded rows with `Disk only`,
  `Managed elsewhere` on `linked-skill`, Claude skills listed under Commands,
  the Codex Commands note, and the unavailable-root link (via
  `journeys/config-folders.mjs`). The agent filter, search, and entry
  points 2 and 3 come from source.
- Entry point 2 needs an open repository, and the seed adds none. Driving it
  needs a git repo under the scratch dir, added via **Open Repository**, which
  uses the native picker. Unproven in the web client.
- Codex has no commands scope. Its Commands group shows a "no verified …
  contract" note instead of rows.
