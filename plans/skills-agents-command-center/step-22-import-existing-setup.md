---
goal: Import an existing file-based template setup into the Tatsu template source folder
date_created: 2026-10-22
last_updated: 2026-10-23
status: 'Completed'
tags: [feature, main-process, harness-config, templates, migration]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan is Step 22 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It adds a one-time import that turns an existing template-and-build setup (for example a dotfiles folder that renders agents, skills, and commands with scripts) into Tatsu templates and fragments ([Step 18](./step-18-template-source-model.md)). After import, Tatsu owns the harness folders and the old build should stop linking into them. Terminology follows [implementation-details.md](./implementation-details.md).

The reference layout this step is designed against:

- **Agents**: one file per agent with `name`, `description`, `shared` (a fragment list), and one frontmatter block per harness (`claude:`, `opencode:`, `omp:`), with `false` meaning "skip". Fragments live in a sibling `agents-shared/` folder.
- **Skills**: several source folders of `<name>/SKILL.md`, with links into a shared `references/` folder that the build copies into each skill.
- **Commands**: some hand-written, the rest generated from skills.

## 1. Requirements & Constraints

- **REQ-001**: The import is a wizard on the Config page: choose source folders per kind (agents, agent fragments, one or more skill folders, shared references, commands), preview, then confirm. Nothing is written before confirmation.
- **REQ-002**: Agent files with per-harness blocks map directly to templates. `shared` maps to `fragments`. `claude` and `opencode` blocks are copied as written. Blocks for harnesses Tatsu does not manage (for example `omp`) are dropped and listed in the preview.
- **REQ-003**: Agent fragments become fragments with the same names.
- **REQ-004**: Each skill becomes a skill template targeting the harnesses the user selects in the wizard (default: Claude). Links into the shared references folder become reference files on that skill (inlined at render time, Step 18 REQ-005). Duplicate skill names across source folders are a preview error the user must resolve.
- **REQ-005**: Commands that the old build generated from skills are not imported as separate templates; the Claude skill/command alias covers them. The wizard detects them by matching names against imported skills and lists them as "covered by skill". Other commands become command templates.
- **REQ-006**: Settings that the old build sent outside resource files (for example Opencode `model`, `fallback_models`, `variant`, `temperature`, `skills`, `mcps` written into `opencode.json`) cannot be represented. The preview MUST list each one per template so nothing is lost silently.
- **REQ-007**: Import writes only into the template source folder. If a template with the same name already exists, the preview marks it and the user chooses skip or replace (with backup).
- **REQ-008**: After import, the wizard shows the scopes that now differ from disk and explains the cut-over: harness folders that are symlinks into the old build stay managed elsewhere ([Step 17](./step-17-symlink-aware-inventory.md)) until the user removes those links, after which sync to disk writes real files.
- **REQ-009**: The importer is pure over a file listing (path to contents) so it can be tested without a filesystem; the main process does the reading.
- **CON-001**: The importer does not run the user's build scripts and does not modify the source setup.

## 2. Implementation Steps

### Implementation Phase 1: Importer

- **GOAL-001**: Convert a file listing into templates, fragments, and a report.

- [x] **TASK-001**: Add `src/main/template-import/` with a pure `importTemplateSetup(listing, options)` returning templates, fragments, and a report of dropped blocks, unsupported settings, duplicates, and covered commands.
- [x] **TASK-002**: Add a transport handler `harnessConfig:previewImport` that reads chosen folders and returns the report, and `harnessConfig:applyImport` that writes the confirmed result through `TemplateSourceStore`.

### Implementation Phase 2: Wizard

- **GOAL-002**: Make the import reviewable.

- [x] **TASK-003**: Add `ConfigImportWizard.tsx` with folder selection, preview, conflict choices, and confirmation.
- [x] **TASK-004**: Show the post-import cut-over guidance per REQ-008.

## 3. Alternatives

- **ALT-001**: Point Tatsu at the old source folder and run the old build after each edit. Rejected: Tatsu's resolvers read each harness's own format and cannot parse multi-harness source files, and generated commands would be uneditable.
- **ALT-002**: Keep both systems running. Rejected: the old build and Tatsu would overwrite each other in the same harness folders.

## 4. Dependencies

- **DEP-001**: [Step 18](./step-18-template-source-model.md), [Step 19](./step-19-template-renderer.md), [Step 20](./step-20-template-sync.md).
- **DEP-002**: [Step 17](./step-17-symlink-aware-inventory.md) for the cut-over period.

## 5. Files

- **FILE-001**: `src/main/template-import/` (new package, with tests).
- **FILE-002**: `src/main/harness-config-transport/harness-config-transport.ts`, `src/renderer/types/types.ts`.
- **FILE-003**: `src/renderer/components/Config/ConfigImportWizard.tsx` (new), `Config.tsx`.

## 6. Testing

- **TEST-001**: A fixture modeled on the reference layout imports agents with blocks, fragments, skills with references, and commands, and reports `omp` blocks and Opencode-only settings.
- **TEST-002**: A generated command matching a skill is reported as covered and not imported.
- **TEST-003**: Duplicate skill names across source folders block the import until resolved.
- **TEST-004**: Rendering the imported templates for Claude produces files equal to the old build output, apart from the provenance marker (Step 19 REQ-007), for agents and commands without references (golden comparison on the fixture).
- **TEST-005**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: Real setups vary. The wizard maps folders the user picks rather than guessing a layout; unknown files are listed, not imported.
- **RISK-002**: Rendered output differs slightly from the old build (spacing, inlined reference headings). The preview shows a diff per file before confirmation.
- **ASSUMPTION-001**: Users migrate once. Repeated import is supported only through the skip/replace choice, not as a continuous sync.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 18: Template source model](./step-18-template-source-model.md)
