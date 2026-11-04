# Feature map

Each file describes one user-facing feature: how a user reaches it, how to
drive it with the `verify` harness, and what end state proves it works.

## Features

- [Workflow run](workflow-run.md): Run workflow here… launch sheet with its Target (preset or repo + new/existing worktree) per-step agent/model Overrides and issue/PR/file input pickers, step strip, Needs you and step tabs on a worktree.
- [Workflows section](workflows-section.md): full-screen Workflows section (sidebar button, hotkey, palette) with the Runs tab: Run workflow…, Needs you, Active and Recent run cards.
- [Workflows library](workflows-library.md): the Library tab of the Workflows section: definitions grouped This repo / Personal / other repos with steps, problems and a trust badge; Run (launch sheet preset), Duplicate (into personal) and Delete (focus-trapped confirm).
- [Workflow definition editor](workflow-definition-editor.md): Library Edit <name> / New workflow open a Monaco YAML editor with live validator squiggles and a problems list; Save (personal or own folder), Save to repo (trust warning), confirm before saving with errors, discard guard.
- [Run detail](run-detail.md): run detail from a run card: step graph, attempt timeline, attempt result, the attempt's changed files and diff, and run actions.
