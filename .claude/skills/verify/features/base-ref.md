# Base ref

The user chooses what the worktree is compared against. The tool starts on `origin/main` (or the repo default base, or `HEAD`), offers local branches, remote branches, and tags in a list, accepts any typed ref or commit, and explains refs that do not exist or share no history.

## Sub-features

- `ref-default` the tool opens on `origin/main` when it exists.
- `ref-list` `Show refs` lists local, remote, and tag refs with their source.
- `ref-pick` choosing an option re-runs the comparison.
- `ref-type` typing a ref and pressing Enter re-runs the comparison.
- `ref-invalid` an unknown ref shows `Ref <name> not found.` and keeps the previous base.
- `ref-unrelated` a ref with no shared history shows `<ref> and this branch share no history.`
- `ref-reset` `Reset to default` returns to the default base.

## How to get to it (user POV)

- Open the tool, then use the `Base ref` box next to `<repo> / <branch> vs` in the summary bar.

## Driving it with drive.mjs

Preconditions:

- Fresh fixture: refs `main`, `origin/main`, `v0.1.0`, `unrelated` exist.

- **Default.** Open the tool. `Base ref` reads `origin/main`; the summary reads `11 files`.
- **List.** Choose button `Show refs`. Options include `main local`, `origin/main remote`, `v0.1.0 tag`, `unrelated local`.
- **Pick.** Choose option `main local`. `Base ref` reads `main`.
- **Type.** Fill `Base ref` with `v0.1.0`, press Enter. `Base ref` reads `v0.1.0`.
- **Invalid.** Fill `no-such-ref`, press Enter. Text `Ref no-such-ref not found.` appears; the file list stays.
- **Unrelated.** Fill `unrelated`, press Enter. Text `unrelated and this branch share no history.` and button `Reset to default` appear.
- **Reset.** Choose `Reset to default`. `Base ref` reads `origin/main` and the list returns.
- **Run.** `node .claude/skills/verify/scripts/code-diff/drive.mjs "$RUN" .claude/skills/verify/scripts/code-diff/journeys/base-ref.mjs`.

## Gotchas

- The comparison is against the merge base of the chosen ref and `HEAD`, so `main`, `origin/main`, and `v0.1.0` all show the same 11 files in the fixture. Assert the `Base ref` value, not a changed count.
- An option's accessible name joins the ref and its source, for example `origin/main remote`.
- The summary-bar Reset arrow has no accessible name; use the error-state `Reset to default` button.
