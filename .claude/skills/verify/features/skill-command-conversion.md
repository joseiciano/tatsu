# Skill ↔ command conversion

Turn a skill into a command, or a command into a skill, for the same harness.
Tatsu drafts the new file in the editor; nothing is written until the user
presses the create button.

## Sub-features

- **Skill → command.** The `Create command from <name>` row action opens a
  create-mode editor. The name is prefilled, and the body points back at the
  skill with a `<!-- Converted by Tatsu from … -->` marker.
- **Command → skill.** The `Create skill from <name>` row action works the same
  way in the other direction.
- **Already available.** A Claude skill already serves `/name`, so converting
  it shows a notice and writes nothing.
- The source resource is never modified.

## How to get to it (user POV)

1. Open Config, then the Skills tab or the Commands tab.
2. Each row has a `Create command` or `Create skill` action next to its badge.
3. Review the draft and press **Create command** or **Create skill**.

## Driving it with Playwright

Proven journey: `scripts/journeys/convert-skill-to-command.mjs`.

```bash
node .claude/skills/verify/scripts/journeys/convert-skill-to-command.mjs "$STATE"
```

The journey makes these moves:

- Opens the Skills tab.
- Clicks `Create command from release-notes` (the Opencode seed).
- Asserts that `#config-create-name` is `release-notes`.
- Clicks the `Create command` button (exact name).
- Waits for `SANDBOX_HOME/.config/opencode/commands/release-notes.md`.
- Switches to Commands and asserts the tab is `aria-selected`.

The end state that proves it works:

- The command file exists, with the description copied and the converted-by marker.
- The source `SKILL.md` still exists.
- `release-notes` is listed under Opencode on the Commands tab.

## Gotchas

- Only skill → command for Opencode has run. Command → skill and the Claude
  "already available" notice come from source and are unproven.
- `Create command` appears both as row actions and as the submit button. Use
  `{ name: 'Create command', exact: true }` for the submit button; row actions
  are labeled `Create command from <name>`.
- Codex has no commands scope, so its `Create command` action is disabled.
- Take the "after" screenshot only after `aria-selected` settles; see the
  transition note in SKILL.md.
