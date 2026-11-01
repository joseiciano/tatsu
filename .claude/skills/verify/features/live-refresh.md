# Live refresh

While the tool is open, edits in the worktree appear without a manual refresh: new files join the list, and the selected file's diff reloads when its content changes.

## Sub-features

- `live-list` a file created in the worktree appears in the list.
- `live-sides` the selected file's diff shows new content after an edit.
- `live-restore` a deleted file leaves the list.

## How to get to it (user POV)

- Keep the tool open while an agent or editor changes files in the worktree.

## Driving it with drive.mjs

Preconditions:

- Fresh fixture: `keep.txt` has the uncommitted line `line two CHANGED`.

- **Select.** Choose `keep.txt`. The diff shows `line two CHANGED`.
- **Edit.** Write `line two EDITED LIVE` into `keep.txt` and create `fresh-file.txt` in `$RUN/fixture/demo-feature`. Within 15 s `fresh-file.txt` is listed and the diff shows `line two EDITED LIVE`.
- **Restore.** Restore `keep.txt` and delete `fresh-file.txt`. Within 15 s `fresh-file.txt` leaves the list.
- **Run.** `node .claude/skills/verify/scripts/code-diff/drive.mjs "$RUN" .claude/skills/verify/scripts/code-diff/journeys/live-refresh.mjs`.

## Gotchas

- The tool polls every 3 s; allow up to 15 s before calling it a failure.
- Polling pauses while the page is hidden. Keep the browser page in front (headless Chrome always is).
- A failed run can leave the edits in place; re-create the fixture before retrying.
