# File navigation

The user reads the change set: files are grouped by change type (Tests, Config, API / routing, Data / models, UI / views, Other) or by folder, and selecting a file shows a side-by-side diff against the base, with placeholders for binary files and rename headers for moved files. Keyboard keys step through files and groups.

## Sub-features

- `group-type` `By type` groups files by change type.
- `group-folder` `By folder` groups files by directory.
- `file-select` choosing a file shows a side-by-side Monaco diff.
- `file-binary` a binary file shows `Binary file — cannot display diff`.
- `file-rename` a renamed file's header reads `<old> → <new>`.
- `file-untracked` untracked files are listed and their content shown.
- `file-deleted` deleted files show the removed content on the base side.
- `keyboard-nav` `j`/`k` (or arrows) step files, `]`/`[` step groups.

## How to get to it (user POV)

- Open the tool, use the file tree on the left and the `By type` / `By folder` toggle in the summary bar.
- With focus outside inputs and the editor, press `j`, `k`, `]`, `[`.

## Driving it with drive.mjs

Preconditions:

- Fresh fixture, base `origin/main`.

- **By type.** Group headers `Tests`, `Config`, `API / routing`, `UI / views`, `Other` are visible.
- **By folder.** Choose `By folder`. It is `aria-pressed=true` and a `src/components/` group appears.
- **Modified.** Choose the row titled `modify-me.txt`. A `.monaco-diff-editor` renders and shows `second line`.
- **Binary.** Choose `blob.bin`. The placeholder text appears.
- **Renamed.** Choose the row titled `rename-me.txt → renamed.txt`. The header shows the same.
- **Untracked / deleted.** Choose `untracked.txt` (shows `scratch`), then `delete-me.txt` (shows `going away`).
- **Keyboard.** Choose `tests/added.test.ts`, click the `N files` summary, press `j` (header `config.json`), `k` (back), `]` `]` (`src/api/routes.ts`), `[` (`config.json`).
- **Run.** `node .claude/skills/verify/scripts/code-diff/drive.mjs "$RUN" .claude/skills/verify/scripts/code-diff/journeys/file-navigation.mjs`.

## Gotchas

- File rows have no button role. Select them by `title`, which is the full path, or `<old> → <new>` for renames.
- The diff header has no accessible name; the journey reads it with `span.truncate.font-mono.text-fg`. Update that selector if the header markup changes.
- Group labels render uppercase through CSS; match the DOM text (`src/components/`), not the screen text.
- `]` at the last group clamps to that group's first file; it does not wrap.
- Keys are ignored while focus is in the `Base ref` box or inside Monaco.
