---
goal: Define templates and fragments and store them as files in the template source folder
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Completed'
tags: [feature, main-process, shared-state, harness-config, templates]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan is Step 18 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It defines the template source model: the files users edit so that one definition can produce agents, skills, and commands for several harnesses and reuse shared text. [Step 19](./step-19-template-renderer.md) builds harness files from this model, and [Step 20](./step-20-template-sync.md) syncs them to disk. Terminology follows [implementation-details.md](./implementation-details.md), as amended for templates.

## 1. Requirements & Constraints

### Model

- **REQ-001**: A **template** has a `kind` (`agent`, `skill`, or `command`), a `name`, a `description`, an ordered `fragments` list, a body, and an optional block per managed harness (`claude`, `codex`, `opencode`).
- **REQ-002**: A harness block holds that harness's native frontmatter, copied as written. Tatsu does not translate settings between harnesses. A block set to `false` excludes that harness. A block may override `name` and `fragments` for its harness.
- **REQ-003**: A template's **targets** are the harnesses with a block that is not `false`. A template with no harness blocks targets nothing and renders nothing. Output for several harnesses happens only through targets the user wrote down.
- **REQ-004**: A **fragment** is a named markdown file. Templates reference fragments by name. Fragments cannot include other fragments in this version.
- **REQ-005**: A skill template may have **reference files**: extra markdown files that ship beside `SKILL.md`. Until nested skill assets are resolved ([Step 15](./step-15-open-questions.md)), the renderer inlines reference files into the rendered `SKILL.md` and does not write separate files.
- **REQ-006**: Template and fragment names follow the existing logical-name rules (`validateLogicalName`). Names are unique per kind.

### Target validity

- **REQ-007**: Each `(kind, harness)` pair is valid only if that harness's capability metadata ([Step 3](./step-03-harness-capability-metadata.md)) supports a per-resource file for it. In particular, Codex `agents` is a single top-level `AGENTS.md`, not a folder of agents, so an `agent` template cannot target Codex. Invalid targets MUST be rejected when saving, with an explanation.
- **REQ-008**: A Claude `skill` template does not need a separate `command` template. The existing skill/command alias exposes it in both views.

### Storage

- **REQ-009**: Templates and fragments are stored as plain files in the template source folder (`settings.harnessConfigSourceDir`, [Step 16](./step-16-config-root-settings.md)):

  ```
  <source>/
  ├── agents/<name>.md
  ├── skills/<name>/TEMPLATE.md
  ├── skills/<name>/references/<file>.md
  ├── commands/<name>.md
  └── fragments/<name>.md
  ```

  Template files use YAML frontmatter for `name`, `description`, `fragments`, and the harness blocks, followed by the body.
- **REQ-010**: The source folder is the source of truth for templates. Tatsu writes it only through explicit user actions (create, save, delete) with the same backup rule as harness files. The folder may be a git repository; Tatsu does not run git.
- **REQ-011**: A main-process `TemplateSourceStore` reads and writes the folder, watches it for outside edits, and dispatches parsed templates and fragments into a new `templates` part of the `harnessConfig` slice. Parse errors are reported per file and never drop other files.
- **REQ-012**: Templates and fragments are shared state ([AGENTS.md](../../AGENTS.md)). Follow the full slice checklist, including `mergeWireSnapshot`.
- **CON-001**: Resources that are not built from a template keep working exactly as today in `config.harnessConfig`. Templates are opt-in per resource.
- **SEC-001**: All source-folder writes go through the same normalized-path and no-symlink write rules as harness roots.

## 2. Implementation Steps

### Implementation Phase 1: Types and parsing

- **GOAL-001**: One shared definition of templates and fragments.

- [x] **TASK-001**: Add `HarnessTemplate`, `HarnessTemplateHarnessBlock`, `HarnessFragment`, and parse-error types to `src/shared/state/harness-config/types.ts`.
- [x] **TASK-002**: Add a pure parser and serializer for the file layout in REQ-009, with round-trip tests.
- [x] **TASK-003**: Add target validation per REQ-007, reading capability metadata.

### Implementation Phase 2: Store

- **GOAL-002**: Keep the slice in sync with the source folder.

- [x] **TASK-004**: Add `src/main/template-source-store/` with load, watch, create, update, delete, and backup.
- [x] **TASK-005**: Add slice events (`harnessConfig/templatesLoaded`, `harnessConfig/templateChanged`, `harnessConfig/templateRemoved`, and the same three for fragments) with `findIndex + slice` reducers per the anti-pattern rules.
- [x] **TASK-006**: Add transport handlers `harnessConfig:saveTemplate`, `harnessConfig:deleteTemplate`, `harnessConfig:saveFragment`, `harnessConfig:deleteFragment`, each requiring an explicit user action.

## 3. Alternatives

- **ALT-001**: Store templates inside `config.json`. Rejected: users want this folder under version control, as they do with dotfiles.
- **ALT-002**: Automatic translation of frontmatter between harnesses (for example mapping Claude `tools` to Opencode `permission`). Rejected per the boundary in [step-01](./step-01-product-boundary-source-of-truth.md): formats are not portable. Each harness block is written by the user.
- **ALT-003**: A general template language (Handlebars, Liquid). Rejected for now: a fragment list covers the shared-text need without a new syntax. Revisit if users need conditionals inside bodies.

## 4. Dependencies

- **DEP-001**: [Step 3](./step-03-harness-capability-metadata.md) capability metadata.
- **DEP-002**: [Step 16](./step-16-config-root-settings.md) source folder setting.

## 5. Files

- **FILE-001**: `src/shared/state/harness-config/types.ts`, `harness-config.ts`, tests.
- **FILE-002**: `src/shared/state/index.ts`, `src/shared/state/wire-merge.test.ts`.
- **FILE-003**: `src/main/template-source-store/` (new package).
- **FILE-004**: `src/main/harness-config-transport/harness-config-transport.ts`, tests.
- **FILE-005**: `src/main/index.ts`, `src/renderer/types/types.ts`.

## 6. Testing

- **TEST-001**: Parser round-trips every file shape in REQ-009, including `false` harness blocks.
- **TEST-002**: An `agent` template targeting Codex is rejected with an explanation.
- **TEST-003**: One malformed file reports a parse error and the others still load.
- **TEST-004**: Saving over an existing template file creates a backup first; a failed backup aborts the save.
- **TEST-005**: An outside edit to a fragment file updates the slice.
- **TEST-006**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: Users edit the source folder in an editor while Tatsu has unsaved changes. The editor ([Step 21](./step-21-template-editor.md)) must detect the outside change and ask before overwriting.
- **RISK-002**: Harness-specific settings that live outside resource files (for example Opencode `model` or `mcps` in `opencode.json`) cannot be expressed. Out of scope; [Step 22](./step-22-import-existing-setup.md) flags them on import.
- **ASSUMPTION-001**: A YAML parser is already a dependency or can be added without native modules.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 19: Template renderer](./step-19-template-renderer.md)

[Step 20: Template sync](./step-20-template-sync.md)
