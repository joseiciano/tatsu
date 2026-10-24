# Fetch

When the base is an `origin/*` branch, the summary bar offers `Fetch`, which updates that one remote-tracking branch from origin without prompting for credentials. A failure shows `Fetch failed — comparing against last fetched <ref>`.

## Sub-features

- `fetch-before` `Fetch` is shown only for an `origin/*` base.
- `fetch-ok` a fetch moves `refs/remotes/origin/<branch>` to origin's tip and shows no failure text.

## How to get to it (user POV)

- Open the tool with an `origin/*` base and choose `Fetch` in the summary bar.

## Driving it with drive.mjs

Preconditions:

- Fresh fixture: `origin.git` has one `main` commit the fixture repo has not fetched.

- **Before.** `git -C "$RUN/fixture/demo-repo" rev-parse refs/remotes/origin/main` differs from `git -C "$RUN/fixture/origin.git" rev-parse main`.
- **Fetch.** Choose button `Fetch`. Within 10 s the first command prints the second's SHA; no text starting `Fetch failed` appears.
- **Run.** `node .claude/skills/verify/scripts/drive.mjs "$RUN" .claude/skills/verify/scripts/journeys/fetch.mjs`.

## Gotchas

- The file list compares against the merge base, so a fetch that adds commits after the branch point leaves the list unchanged. Prove the fetch through the ref, not the UI count.
- The fixture's origin is a local bare repo. Fetching over SSH or HTTPS (`BatchMode=yes`, `GIT_TERMINAL_PROMPT=0`) is not exercised.
- Running this journey consumes the unfetched commit; re-create the fixture to run it again.
