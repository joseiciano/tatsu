# Tatsu Harness Fork Spike PRD

## Purpose
Decide whether to fork `frenchie4111/harness` as the MVP foundation for Tatsu. This is an evaluation, not a commitment.

## Background
Harness is an MIT-licensed project that provides local agent execution, an Electron desktop app, a headless server/web client path, Claude Code/Codex support, git worktrees, terminal/editor/diff surfaces, PR/status visibility, hooks, WebSocket remote control, and browser automation.

## Product Direction Clarification

- **Tatsu is a standalone desktop/local agent workflow harness.** It is not an IDE, not an IDE extension, and not IDE-integrated.
- Phase 1 should be referred to as the **Agent Workflow Harness MVP** or **Desktop/Local App MVP**, not IDE MVP.
- The product is a local-first desktop application for orchestrating AI agent workflows across local repos, git worktrees/workspaces, and multiple CLI agent sessions, with terminal/editor/diff/review surfaces and repeatable workflow runs.
- A companion web app may follow later (Phase 2), but the primary experience is local.
- Existing PRD docs that use IDE-first language should be updated to reflect this corrected direction.

## Phase 1 Product Positioning

Tatsu Phase 1 is a standalone desktop application that gives individual engineers and tech leads a local environment to define, run, and review repeatable agent workflows. It operates on local repositories via git worktrees/workspaces, supports multiple concurrent CLI agent sessions, and provides terminal, editor, diff, and review surfaces. Managers evaluate Tatsu for team visibility, standardization, and governance potential.

Tatsu does **not** integrate with external IDEs and is **not** an IDE extension. Optional "Open in external editor" handoff buttons may be provided as local OS-level conveniences only.

Phase 2 adds a web UI for collaboration, shared visibility, and team sync after the local workflow experience is validated. Managed cloud execution remains a future phase.

## Expected Desktop MVP Feature Set

### Must Have
- Standalone desktop/local app for agent workflow orchestration
- Local repo and git worktree/workspace management
- Multiple local CLI agent sessions with terminal/editor/diff/review surfaces
- Repeatable workflow runs with stable run IDs and schema
- Workflow templates: local file-based definitions (e.g., `.tatsu/workflows/*.yaml` or `.json`) with a stable schema
- Run history: local-first, app-managed persistence (likely SQLite) with exportable JSON/JSONL
- Claude Code and OpenCode support or a clear integration path
- GitHub PR/status visibility
- Generic OpenAI-compatible model connector (BYOK)
- Compatibility matrix for provider/runtime combinations

### Should Have
- External editor handoff (local OS-level convenience only, not IDE integration)
- Codex support, if inherited cheaply from Harness
- Import/export of workflow definitions
- Basic team/project membership and access controls
- Setup checks for missing host dependencies

### Won't Have
- IDE extension or IDE integration of any kind
- Managed cloud container execution
- Full web-only workflow execution
- Public workflow marketplace
- Full enterprise compliance package
## Spike Objective

Determine if forking Harness accelerates Tatsu's Agent Workflow Harness MVP by 4–8 weeks without introducing unacceptable technical debt, licensing friction, or UX/brand misalignment. The spike must validate support for OpenCode and Claude Code, local file-based workflow templates, exportable run history, and GitHub PR/status visibility.

## Hypothesis

Harness provides ~70% of the Agent Workflow Harness MVP surface (local execution, git worktrees, terminal/editor/diff UI, agent loop, PR visibility). Forking and rebranding it is faster than building from scratch, provided we can cleanly strip Codex-specific branding and add Tatsu-specific workflow templates, run metadata/history, and our own agent orchestration layer. OpenCode and Claude Code support must be verifiable or clearly addable.

## Scope

### In scope
- Fork, build, and run Harness locally
- Assess rebrand feasibility (name, logo, colors, copy)
- Prototype a Tatsu workflow template (e.g., "Review PR" or "Refactor module")
- Prototype run metadata and history persistence
- Evaluate agent orchestration hook points
- Review license, dependencies, and maintenance burden

### Out of scope
- Full Tatsu feature implementation
- Cloud/sync infrastructure
- Companion web app build
- Long-term maintenance planning beyond the spike

## What Harness May Provide
- Electron desktop shell with terminal, editor, and diff surfaces
- Local agent execution loop with Claude Code/Codex adapters
- Git worktree integration for isolated agent sessions
- WebSocket remote control for external triggers
- Browser automation primitives
- PR/status visibility hooks
- MIT license

## What Tatsu Must Add
- Tatsu branding and design system overlay
- Workflow template system (declarable, reusable agent tasks)
- Run metadata and history (DB or local file persistence)
- Custom agent orchestration layer (may replace or wrap Harness's)
- GitHub integration (PR/status visibility as Phase 1 required git host; other git hosts and issue trackers are future phases)

## Evaluation Criteria

### Product fit
- Does Harness's UI surface map to Tatsu's Agent Workflow Harness MVP needs?
- Can workflow templates and run history be added without major structural changes?

### GitHub workflow fit
- Does Harness already provide GitHub PR/status visibility? If not, how addable is it?
- Can the PR/status surface be extended to match Tatsu's expected UX without major architectural friction?
- Is the git integration deep enough to support worktree-based workflows with PR context?

### Technical fit
- Can we build and run it locally within a day?
- How coupled is the agent loop to Claude Code/Codex? Can we inject our own?
- What is the dependency footprint and upgrade path?

### Security/privacy fit
- Does Harness send code or telemetry anywhere by default?
- Can it run fully offline/local?
- User-initiated provider/API calls and enabled GitHub integrations are expected outbound traffic.
- Telemetry, update checks, remote control, and other nonessential outbound calls must be disclosed, controllable, and optional/disableable where possible.
- Local execution should not require network access except for user-enabled integrations and provider calls.

### Licensing/maintenance fit
- MIT license: compatible, but what about transitive dependencies?
- How active is the upstream? Can we maintain a fork if upstream stalls?

### UX/brand fit
- How much effort to rebrand (strings, icons, colors, window chrome)?
- Does the default layout feel like Tatsu, or like a different product?

## Spike Work Plan

### Day 0/1: repo validation and license review
- Fork the repo, review LICENSE and key dependency licenses
- Read README, architecture docs, and entry points
- Confirm build instructions and document any blockers

### Days 1–2: build/run/rebrand feasibility
- Build and run the Electron app locally
- Identify all user-visible strings, icons, and color tokens
- Estimate rebrand effort (hours, not days)

### Days 2–3: workflow template prototype
- Locate the agent task definition layer
- Prototype one Tatsu workflow template (YAML/JSON/TS config)
- Validate that the template can be loaded and executed by the agent loop

### Days 3–4: run metadata and history prototype
- Choose a local persistence strategy (SQLite, JSONL, or embedded DB)
- Prototype recording run start/end, inputs, outputs, and status
- Surface history in the UI (minimal list view is sufficient)

### Days 4–5: risk review and recommendation
- Score each evaluation criterion (pass / concern / blocker)
- Document mitigations for concerns
- Write go/no-go recommendation with estimated time savings vs. build-from-scratch

## Decision Gates

1. **Build gate**: Can we build and run Harness locally by end of Day 1? If not, escalate or stop.
2. **Rebrand gate**: Can we rebrand the app to feel like Tatsu within ~1 day of effort? If not, flag UX risk.
3. **Extensibility gate**: Can we add workflow templates and run history without forking core internals? If not, flag maintenance risk.
4. **GitHub workflow gate**: Can we achieve GitHub PR/status visibility in the MVP timeframe, either via existing Harness support or with low-friction additions? If not, flag product gap.
5. **No-go/friction gate**: If Harness cannot be cleanly extended into Tatsu's expected feature set (local file-based workflow templates, exportable run history, OpenCode/Claude Code support, GitHub PR visibility) without major architectural friction, reject the fork path.
6. **Go/No-go gate**: By end of Day 5, recommend fork, partial reuse, or reject.

**Harness compatibility note:** No Harness backward compatibility is required. If forked, Harness becomes Tatsu and can diverge freely.

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Heavy coupling to Claude Code/Codex | High | Audit agent loop; plan wrapper or replacement layer; validate OpenCode addability |
| Rebrand is deeper than expected | Medium | Scope rebrand to MVP level; polish later |
| Upstream abandonment | Medium | MIT allows full fork; budget ongoing maintenance |
| Telemetry or network calls by default | High | Audit network calls; disable or gate behind opt-in; disclose all outbound connections |
| Dependency vulnerabilities or bloat | Medium | Run `npm audit` or equivalent; document upgrade plan |
| Cannot cleanly extend into Tatsu feature set | High | Reject fork if major architectural friction is required for templates, history, OpenCode, or GitHub PR visibility |

## Required PRD Follow-up Changes

- Update all existing PRD docs to replace "IDE MVP" / "IDE-first" with "Agent Workflow Harness MVP" / "Desktop/Local App MVP"
- Remove or clarify language that implies Tatsu is an IDE extension or IDE-integrated surface
- Add a "Local-first desktop harness, web companion later" principle to the product strategy doc

## Open Questions

- Does Harness support pluggable LLM providers beyond Claude Code/Codex? Can OpenCode be added cleanly?
- What is the state management approach (React context, Zustand, Redux, etc.)?
- How does Harness handle secrets or API keys? Is there a local vault?
- What is the test coverage and CI setup?
- Are there any patented or non-MIT components in the dependency tree?
- What outbound network calls does Harness make by default (telemetry, update checks, remote control)? Can they all be disabled?

## Recommended Outcome Format
A 1–2 page spike summary with:
- Go / no-go / conditional-go recommendation
- Time savings estimate (weeks)
- Top 3 risks and mitigations
- Required follow-up work if we proceed
- List of existing PRD docs that need language updates
