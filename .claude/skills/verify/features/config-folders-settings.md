# Config folders in Settings

Settings has a **Config folders** section. In it the user overrides where
each harness keeps its agents, skills, and commands, and where Tatsu keeps its
template source folder. A change applies live and rescans the affected scopes.

## Sub-features

- One input per root key, `#config-folder-<rootKey>`. The keys are
  `claudeAgents`, `claudeSkills`, `claudeCommands`, `codexHome`, `codexSkills`,
  `opencodeAgents`, `opencodeSkills`, and `opencodeCommands`.
  The placeholder shows the effective default.
- Each input has a `Reset <label> to default` button.
- The server rejects a path that is not absolute. A missing folder is allowed;
  that scope then shows as unavailable.
- **Choose…** opens the native folder picker. It is unverifiable in the web
  client.

## How to get to it (user POV)

1. Open Settings, then the **Config folders** section in the left nav.
2. Or, on the Config page, use the `Set config folders in Settings` link on
   any unavailable-root message. It opens Settings directly at this section.

## Driving it with Playwright

```js
const alt = `${state.SCRATCH}/alt-skills`   // create it with fs.mkdirSync first, seed one SKILL.md
await page.locator('#config-folder-claudeSkills').fill(alt)
await page.locator('#config-folder-claudeSkills').press('Enter')   // commits on Enter or blur
```

The end state that proves it works:

- Back on Config → Skills, the Claude group lists the skills from `alt` and
  no longer lists `hello`.
- `DATA_DIR/config.json` persists the override.
- After `Reset Skills to default`, `hello` returns.
- A relative path such as `skills` is rejected, and nothing is persisted.

## Gotchas

- Run: `journeys/config-folders.mjs`. Enter commits, a relative path shows
  "Choose an absolute folder path" and is not persisted, the override lands
  in `DATA_DIR/config.json` and rescans Skills, and Reset restores `hello`.
- Run `config-folders.mjs` on a fresh launch. It deletes the Codex skills
  root, and a scan that fails keeps the rows of the last good scan, so a
  launch where Codex skills were already listed still shows Codex `hello`
  and the journey's row count fails.
  Commit-on-blur comes from source.
- Both entry points run. Cmd+, works on the onboarding screen and, from the
  Config page, replaces Config with Settings. The journey deletes
  `$SANDBOX_HOME/.agents/skills` so the entry-point-2 link appears.
- The **GitHub** nav item is tinted blue whenever no GitHub token is set (a
  fresh sandbox never has one). That is the "needs attention" style, not the
  active section; assert the active item by its `bg-surface` class.
- The journey asserts the `Config folders` heading sits inside the scroll
  container after the link opens Settings (it used to be scrolled under the top edge).
- Nine inputs have `Reset <label> to default` buttons and several labels
  repeat (`Skills` three times). Scope the Reset click to the input's row.
- Entry point 2 needs an unavailable root. Delete one sandbox root (for example
  `rm -r $SANDBOX_HOME/.agents/skills`) before launch. The seed creates all of
  them by default.
- Three inputs are labeled `Skills` (Claude, Codex, Opencode). Target them by
  id, not by label.
