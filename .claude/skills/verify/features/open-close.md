# Open and close

The user opens the code diff tool full-screen for the active worktree from the Changed Files panel, a hotkey, or the command palette, and returns to the workspace with Escape or the hotkey. The tool and the Review screen share one full-screen slot, so opening one closes the other.

## Sub-features

- `open-diff-button` opens the tool from the `Diff` button in Changed Files.
- `open-hotkey` toggles the tool with Cmd+Shift+C.
- `open-palette` opens the tool from the `Code diff` palette command.
- `close-escape` closes the tool with Escape, except while focus is in the Base ref box or the diff editor.
- `slot-shared` opening Review (Cmd+Alt+R) replaces the tool.

## How to get to it (user POV)

- Select a worktree with changes, then choose `Diff` in the Changed Files header.
- Press Cmd+Shift+C in the workspace.
- Press Cmd+K, type `Code diff`, press Enter.

## Driving it with drive.mjs

Preconditions:

- Fixture worktree `feature/diff-demo` is in the sidebar and has changes.

- **Diff button.** Select `feature/diff-demo`, choose button `Diff`. Combobox `Base ref` and the `N files` summary appear.
- **Escape inside input.** Focus `Base ref`, press Escape. The tool stays open.
- **Escape outside input.** Click the `N files` summary, press Escape. `Base ref` is gone and button `Changed Files` is back.
- **Hotkey.** Press `Meta+Shift+C` to open, again to close.
- **Palette.** Press `Meta+K`, fill placeholder `Search worktrees and commands...` with `Code diff`, press Enter. The tool opens.
- **Shared slot.** With the tool open, press `Meta+Alt+R`. `Base ref` is gone and the Review screen shows `N/M reviewed`.
- **Run.** `node .claude/skills/verify/scripts/drive.mjs "$RUN" .claude/skills/verify/scripts/journeys/open-close.mjs`.

## Gotchas

- The `Diff` button renders only when the worktree has at least one changed file. A clean worktree has no button entry point.
- The summary bar's Back arrow and Reset arrow have no accessible name (the tooltip label is not an `aria-label`). Close with Escape; reset through the error state's `Reset to default` button.
- Clicking into the diff editor area to blur the input puts focus in Monaco, where Escape is ignored by design. Click the `N files` summary instead.
- The whole entry surface is hidden when `ENABLE_CODE_DIFF` is false; doctor checks the bundle for it.
