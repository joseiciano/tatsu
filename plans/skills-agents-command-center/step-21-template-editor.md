---
goal: Add Config page UI to create and edit templates and fragments with a live rendered preview
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Planned'
tags: [feature, renderer, react, harness-config, templates]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan is Step 21 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It adds the editing surface for templates and fragments to the Config page from [Step 7](./step-07-config-page-shell.md), using the renderer from [Step 19](./step-19-template-renderer.md) for a live preview. Terminology follows [implementation-details.md](./implementation-details.md).

## 1. Requirements & Constraints

- **REQ-001**: Add a `Templates` view to the Config page alongside `Agents`, `Skills`, and `Commands`, with two lists: templates (grouped by kind) and fragments. The three existing tabs keep their labels and behavior.
- **REQ-002**: In the existing resource lists, a template-rendered resource shows its `templateRef` and an "Edit template" action that opens the template instead of the rendered file.
- **REQ-003**: The template editor has: name, description, kind, a fragment picker (ordered, add/remove/reorder), the body, and one collapsible block per harness with an on/off toggle and a frontmatter editor. Harnesses that are not valid targets for the kind are shown disabled with the reason from capability metadata.
- **REQ-004**: A preview pane shows the rendered output for a selected harness, updated as the user types, plus any render errors. It uses the shared renderer directly, with no backend round trip.
- **REQ-005**: The fragment editor shows which templates use the fragment. Saving a fragment used by more than one template asks for confirmation and lists them.
- **REQ-006**: Saving is an explicit action. Unsaved drafts follow the existing Config dirty-discard guard. If the file changed on disk since it was opened, saving asks before overwriting (Step 18 RISK-001).
- **REQ-007**: After saving, show the "scopes now out of sync" notice from [Step 20](./step-20-template-sync.md) REQ-005.
- **REQ-008**: Draft and selection state is per-client `useState`; templates and fragments themselves are read only from the store.
- **REQ-009**: Follow the text and icon size rules in [AGENTS.md](../../AGENTS.md) and the smart/dumb component split already used under `src/renderer/components/Config/`.
- **CON-001**: Use the existing Monaco setup for body and frontmatter editing. No new editor dependency.

## 2. Implementation Steps

### Implementation Phase 1: Lists and navigation

- **GOAL-001**: Make templates findable.

- [ ] **TASK-001**: Add the `Templates` view and its lists to `ConfigTabs.tsx` and `Config.tsx`.
- [ ] **TASK-002**: Add `templateRef` display and "Edit template" to `ConfigResourceList.tsx`.

### Implementation Phase 2: Editors

- **GOAL-002**: Edit templates and fragments safely.

- [ ] **TASK-003**: Add `ConfigTemplateEditor.tsx` with the fields in REQ-003 and the preview in REQ-004.
- [ ] **TASK-004**: Add `ConfigFragmentEditor.tsx` with usage list and confirmation per REQ-005.
- [ ] **TASK-005**: Wire saves to the Step 18 handlers and the out-of-sync notice.

## 3. Alternatives

- **ALT-001**: Edit templates only in an external editor. Rejected as the only option, but "Open in editor" SHOULD be offered through the existing external editor integration.
- **ALT-002**: Put templates inside each existing tab instead of a separate view. Rejected: one template spans several tabs and harnesses, so it has no single home tab.

## 4. Dependencies

- **DEP-001**: [Step 18](./step-18-template-source-model.md), [Step 19](./step-19-template-renderer.md), [Step 20](./step-20-template-sync.md).
- **DEP-002**: [Step 7](./step-07-config-page-shell.md) Config shell and dirty guard.

## 5. Files

- **FILE-001**: `src/renderer/components/Config/Config.tsx`, `ConfigTabs.tsx`, `ConfigResourceList.tsx`.
- **FILE-002**: `src/renderer/components/Config/ConfigTemplateEditor.tsx`, `ConfigFragmentEditor.tsx` (new), with tests.
- **FILE-003**: `src/renderer/store/store.ts` — per-id selectors for templates and fragments (anti-pattern #4).

## 6. Testing

- **TEST-001**: Toggling a harness block changes the preview targets; invalid targets cannot be enabled.
- **TEST-002**: A render error shows in the preview and blocks nothing else.
- **TEST-003**: Saving a shared fragment lists dependent templates before confirming.
- **TEST-004**: An outside change to the open file prompts before overwriting.
- **TEST-005**: `pnpm typecheck`, `pnpm build`, `pnpm test`, plus a `pnpm dev` smoke of create, edit, preview, save, and sync for one template targeting two harnesses.

## 7. Risks & Assumptions

- **RISK-001**: Frontmatter editing per harness is error-prone. Validate YAML on each change and show errors inline in the block.
- **ASSUMPTION-001**: The Config page has room for a fourth view without layout changes on desktop. Mobile is out of scope, as in Step 8.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 22: Import an existing template setup](./step-22-import-existing-setup.md)
