# Implementation Plan: Skills-Agents-Commands-Sync

This implementation plan is for the skills-sync feature. It will detail the goal, implementation steps, and end result for this feature.

## Overview

For feature goals, scope, source-of-truth rules, and shared caveats, see [implementation-details.md](./implementation-details.md).

## Implementation Steps

| Step | File |
|---|---|
| Step 1: Define the product boundary and source of truth | [step-01-product-boundary-source-of-truth.md](./step-01-product-boundary-source-of-truth.md) |
| Step 2: Add a main-process harness config service | [step-02-main-process-harness-config-service.md](./step-02-main-process-harness-config-service.md) |
| Step 3: Add harness capability metadata | [step-03-harness-capability-metadata.md](./step-03-harness-capability-metadata.md) |
| Step 4: Add a shared state slice for inventory and sync status | [step-04-shared-state-slice.md](./step-04-shared-state-slice.md) |
| Step 5: Persist Tatsu-managed desired config | [step-05-persist-tatsu-managed-config.md](./step-05-persist-tatsu-managed-config.md) |
| Step 6: Add transport request handlers | [step-06-transport-request-handlers.md](./step-06-transport-request-handlers.md) |
| Step 7: Build Config page shell | [step-07-config-page-shell.md](./step-07-config-page-shell.md) |
| Step 8: Add navigation entry points | [step-08-navigation-entry-points.md](./step-08-navigation-entry-points.md) |
| Step 9: Implement sync conflict UX | [step-09-sync-conflict-ux.md](./step-09-sync-conflict-ux.md) |
| Step 10: Implement skill-command conversion | [step-10-skill-command-conversion.md](./step-10-skill-command-conversion.md) |
| Step 11: Tests | [step-11-tests.md](./step-11-tests.md) |
| Step 12: Verification commands | Not yet authored — verification commands are embedded in each step's Testing section until this step is written. |
| Step 13: Suggested implementation order | Not yet authored — follow the dependency order implied by the step list until this step is written. |
| Step 14: Acceptance criteria | [step-14-acceptance-criteria.md](./step-14-acceptance-criteria.md) |
| Step 15: Open questions to resolve during implementation | [step-15-open-questions.md](./step-15-open-questions.md) |

## Templates and Configurable Folders

These steps add templates: one source definition that builds agents, skills, and commands for several harnesses, with shared fragments for repeated text. They also let users choose where harness configuration and templates live. Build them in order.

| Step | File |
|---|---|
| Step 16: Config root settings | [step-16-config-root-settings.md](./step-16-config-root-settings.md) |
| Step 17: Symlink-aware inventory | [step-17-symlink-aware-inventory.md](./step-17-symlink-aware-inventory.md) |
| Step 18: Template source model | [step-18-template-source-model.md](./step-18-template-source-model.md) |
| Step 19: Template renderer | [step-19-template-renderer.md](./step-19-template-renderer.md) |
| Step 20: Template sync | [step-20-template-sync.md](./step-20-template-sync.md) |
| Step 21: Template editor | [step-21-template-editor.md](./step-21-template-editor.md) |
| Step 22: Import an existing template setup | [step-22-import-existing-setup.md](./step-22-import-existing-setup.md) |
