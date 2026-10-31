---
goal: Build harness resource files from templates and fragments with a pure, versioned renderer
date_created: 2026-10-22
last_updated: 2026-10-22
status: 'Planned'
tags: [feature, shared, harness-config, templates]
---

# Introduction

![Status: Planned](https://img.shields.io/badge/status-Planned-blue)

This plan is Step 19 of the [Skills-Agents-Commands-Sync plan](./skills-agents-commands-sync.md). It adds the renderer: a pure function that turns the templates and fragments from [Step 18](./step-18-template-source-model.md) into the exact files each harness reads. [Step 20](./step-20-template-sync.md) compares this output with disk, and [Step 21](./step-21-template-editor.md) uses it for a live preview. Terminology follows [implementation-details.md](./implementation-details.md).

## 1. Requirements & Constraints

- **REQ-001**: `renderTemplates(templates, fragments)` is pure and deterministic. It does no I/O and returns the same bytes for the same input on every platform.
- **REQ-002**: For each template and each target harness, the output is one `RenderedResource { templateName, agentKind, resourceType, relativePath, content, hash }`. `relativePath` comes from the harness resolver's `pathForName` for that resource type, so rendered paths match what the scanner discovers.
- **REQ-003**: Rendered content is the harness block's frontmatter (with `name` and `description` filled in unless the block overrides them), then the template body, then each fragment in list order separated by a blank line.
- **REQ-004**: For skills, reference files are appended after the fragments under a heading per file (inlining, per Step 18 REQ-005).
- **REQ-005**: Rendering errors are returned per template, never thrown: unknown fragment name, invalid target, duplicate output path, or frontmatter that does not serialize. A template with errors produces no output; other templates still render.
- **REQ-006**: Two templates that render to the same `(agentKind, resourceType, relativePath)` is an error on both.
- **REQ-007**: Every rendered file carries a provenance marker that the scanner can read, so a disk file can be traced back to its template. Use a frontmatter key `tatsu-template: <kind>/<name>` where the harness tolerates unknown keys; otherwise use an HTML comment on the first body line. Capability metadata records which form each harness uses.
- **REQ-008**: The renderer exports `RENDERER_VERSION`. Any change to output format bumps it.
- **REQ-009**: The renderer lives in `src/shared/` so the main process (sync) and renderer (preview) run the same code.
- **CON-001**: No string templating syntax inside bodies in this version (see Step 18 ALT-003).

## 2. Implementation Steps

### Implementation Phase 1: Renderer

- **GOAL-001**: One renderer for sync and preview.

- [ ] **TASK-001**: Add `src/shared/harness-template-render/` with `renderTemplates`, `RenderedResource`, render-error types, and `RENDERER_VERSION`.
- [ ] **TASK-002**: Move the resolvers' `pathForName` functions to a shared module the renderer can import without Node APIs, or expose them through capability metadata.
- [ ] **TASK-003**: Add the provenance-marker form to capability metadata and teach the scanner to read it into `HarnessConfigFileRef.templateRef?: string`.

## 3. Alternatives

- **ALT-001**: Render in the main process only and send results to the renderer. Rejected: the editor preview would need a round trip per keystroke.
- **ALT-002**: No provenance marker; match disk files to templates by path only. Rejected: renames and hand-copied files become ambiguous, and Step 20's adopt guard needs to know a file came from a template.

## 4. Dependencies

- **DEP-001**: [Step 18](./step-18-template-source-model.md) model.
- **DEP-002**: [Step 3](./step-03-harness-capability-metadata.md) capability metadata and resolver paths.

## 5. Files

- **FILE-001**: `src/shared/harness-template-render/` (new package, with tests).
- **FILE-002**: `src/main/harness-config/harness-config.ts` — scanner reads the provenance marker.
- **FILE-003**: `src/shared/agent-registry/` or the capability metadata module — marker form and shared paths.

## 6. Testing

- **TEST-001**: Golden-output tests for an agent, a skill with references, and a command, for each harness they target.
- **TEST-002**: Same input gives byte-identical output across runs.
- **TEST-003**: Each error in REQ-005 and REQ-006 is reported on the right template, and unrelated templates still render.
- **TEST-004**: The scanner reads `templateRef` from a rendered file written to a temp root.
- **TEST-005**: `pnpm typecheck`, `pnpm build`, `pnpm test`.

## 7. Risks & Assumptions

- **RISK-001**: A harness rejects an unknown frontmatter key. Capability metadata selects the comment form for that harness; golden tests cover each form.
- **RISK-002**: Users expect fragments in the middle of a body. Out of scope for this version; documented in the editor help text.

## 8. Related Specifications / Further Reading

[Feature implementation details](./implementation-details.md)

[Step 20: Template sync](./step-20-template-sync.md)
