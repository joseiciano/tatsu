# Code diff verification map

This directory is the maintained source for verifying the user-facing behavior of the code diff tool: a full-screen view that compares the active worktree (committed, uncommitted, and untracked changes) against a base ref the user chooses. Read the index before driving, then use the matching feature file as the recipe.

## Baseline preconditions

- `pnpm build:headless` ran after the last source change.
- `fixture.sh "$RUN"` and `launch.sh "$RUN"` ran for a fresh run root.
- `doctor.sh "$RUN"` prints only `ok` lines.
- Drive only the instance this run started.

## Driving conventions

- Start each journey from the fixture state unless the feature file says otherwise.
- Run journeys through `node .claude/skills/verify/scripts/drive.mjs "$RUN" <journey>`.
- Prefer ARIA roles and accessible names, then visible text, then `title` attributes. Use CSS classes only where the Gotchas name the gap.
- The web client runs on macOS Chrome, so `Meta` is the Cmd modifier in hotkeys.

## Proof and skip reporting

- Capture the user action and the resulting state: every journey step logs one line in `steps.log` and takes a screenshot plus an ARIA snapshot at key points.
- Prove side effects outside the browser with a second read (`git rev-parse`, file contents).
- Record the sub-feature ID with every logged step.
- Report an unreachable entry point with the attempted command and the unmet precondition.

## Feature entry contract

Each feature file starts with an H1 and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with drive.mjs`, `Gotchas`.

## Features

- [Open and close](./open-close.md) covers the Diff button, the Cmd+Shift+C hotkey, the palette command, Escape, and the slot shared with Review.
- [Base ref](./base-ref.md) covers the default base, picking and typing refs, the invalid-ref and no-shared-history errors, and reset.
- [File navigation](./file-navigation.md) covers grouping by type or folder, file selection, the diff pane for each change kind, and j/k/[/] stepping.
- [Fetch](./fetch.md) covers updating the origin base from the summary bar.
- [Live refresh](./live-refresh.md) covers worktree edits appearing in the open tool without a manual refresh.
