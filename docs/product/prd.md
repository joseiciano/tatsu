# Tatsu Product Requirements Document

## Introduction

Tatsu is an AI harness orchestrator for engineering teams. 

Starting out as a desktop app to control swarms (multiple instances of agents) of various agents, we intend to add onto it to serve as the agentic workflow orchestrator for all teams. 

The goal is to help teams move from individual, fragile AI setups to standardized workflows that work for everyone - from devs to HR. With these workflows and setup, they will be easily customizable, shareable, governed, and measured. 

The strategy is to start out building out the local desktop application core. While this targets specifically devs, this foundation will allow us to follow up with strong features that improve the workflow of all AI users. 

## Problem

AI coding and agentic workflows are useful, but currently usage is fragmented. 

- No set standard. Engineers use different tools, skills, commands. 
- Lot of technical tool knowledge is needed for advanced workflows (git worktrees, tmux)
- Platform/DevEx teams inherit support burden from inconsistent local setups.

### Competitors

- **Traditional IDEs (Cursor, Windsurf)**: AI-native IDEs for developers. Currently supports small individualized workflows, but not swarms. 
- **Superset (local worktree-based agent orchestration benchmark)**: Closest to MVP. Validates demand for a desktop-based swarm orchestrator, but I think our follow up features allow us to compete. Ideally we can provide an in-depth, but also a higher level abstracted view for those not as technically aware.
- **Harness (open-source agent harness)**: Validates configurable agent workflows and local execution in a desktop app. It is closer to an implementation-oriented product path than a team workflow standardization layer.
- **ChatGPT Web**: Strong browser-based UX and broad user familiarity. It is accessible, but less suited to deep engineering workflows in a local desktop harness and creates dependency on one provider ecosystem. Also suffers from vendor lock in. 
- **Anthropic / Claude ecosystem**: Strong coding and agent capabilities. However, relying directly on one vendor creates exposure to changes in pricing, product scope, and platform policy. 

## Objective

The end goal is to have a desktop and web-based way of controlling swarms of agents. 

To get there, we will work in phases that break down the goal into smaller ones. For the purpose of this MVP, we will build the foundation by working on the desktop app version. 

The MVP should prove that engineering teams are able to run repeatable AI workflows from their local desktop environment, being able to control swarms of agents. Later releases will expand this functionality with more features. 

### Product Phases

- **Phase 1 — Desktop/Local App Agent Workflow Harness MVP:** Local/host-based execution inside a standalone desktop workflow harness for engineering teams.
  - **Note**: We will be focusing **solely** on this section currently
- **Phase 2 — Web UI / Collaboration:** Web workspace for shared visibility, templates, history, and cross-functional team sync after the local workflow is validated. Execution can remain local.
- **Phase 3 / Future — Cloud Execution:** Managed containers for fully browser-based execution and broader non-technical adoption.

## Solution

Tatsu will launch as a desktop/local standalone AI workflow harness. The MVP gives developers and engineering teams a repeatable way to define, run, and share agent workflows from a local desktop application.

**Reasoning**: 
- Focusing on local first gives us a base that we can expand on later (for example a web client can copy the majority of style/apis we may use)
- Focusing on local first lets us get an audience of devs first, which are more inclined to use their own machine than web tools (repls for example)
- This approach saves us money for initial development, avoiding the upfront cost of cloud containers. We can use local containers then extend that logic later . 

### What is a Workflow

For this document we will be talking about workflows. What are workflows? Workflows are the session of the agent. 

This is done in one of two ways.

1. **Low level**: These are exposing the raw agent harness. Think of it as just a way to access the agent from within the tool itself. For those who prefer to tightly work with the harness.
2. **High level**: We expose just a chat and the output response to the user (i.e. I send "write me an email", I get output "Sent email to xxxx"). Under the hood we can define the agent being used. The benefit of this is hiding the lower level magic that may not be well known by certain users (imagine HR or secretaries). Where appropriate, ACP serves as the underlying configurable agent interface.

Workflow definitions should be file-based first (e.g., `.tatsu/workflows/*.yaml` or `.json`) with a stable schema. App-managed personal templates may also exist. Import/export and later cloud sync should be possible.

Recommended workflow fields:

- Name: String 
- Description: String 
  - High level overview of the workflow 
- Owner: String 
- Steps: WorkflowSteps[]
- Version: number

WorkflowSteps:
- Prompt: string 
- Harness: Harness
  - information on the harness used to control it
- Agent: Agent
  - Information on the agent used in the harness

### MVP Architecture Concept

#### Control Surface
- Standalone desktop/local app surface (not an IDE extension or IDE-integrated surface).
- Allows users to create, select, run, and manage Tatsu workflows and swarms.
- Exposes workflow templates, harness settings, runtime status, and run history.
- Optional "Open in external editor/IDE handoff" may be provided as a local OS-level convenience only, not as an IDE extension or integration.

#### Execution Surface
- Runs locally/on host machine for MVP.
- Uses local project context and installed dependencies.
- Dockerized worktrees are a first-class execution surface: sessions run inside containerized worktrees that can be SSHed into.
- Avoids hosted containers until Phase 3 / future.

#### Configuration Surface
- Team/project workflow definitions.
- CLI harness configuration for OpenCode and Claude Code.
- Runtime connector settings for OpenCode and Claude Code.
- GitHub PR/status visibility configuration.
- Compatibility and setup checks.

## Provider and Runtime Strategy

The MVP centers on CLI harnesses/runtimes, not generic model-provider connectors.

### AI Harness Provider

For the MVP, we will be focusing on integrating the following AI CLI harnesses:

- Claude Code
- OpenCode

The idea is that we want to target the most popular tools but also be extensible so that later on we can add more CLIs.

Tatsu orchestrates swarms of these CLI harnesses. The user interacts with the harness through Tatsu, not through a direct model API.

### Required Product Behaviors

- Detect whether required CLI harness and runtime connector are installed.
- Show setup instructions when a harness or runtime is missing.
- Capture harness and runtime version where available.
- Record harness and runtime connector used for each execution.
- Fail clearly when host permissions, project path, or harness/runtime configuration blocks execution.
- Validate required configuration before first run.
- Detect common auth failures.
- Surface rate-limit and unsupported-feature errors clearly.
- Store harness and runtime metadata with each run.

## Run History

Run history should be local-first and app-managed (likely SQLite) with a stable schema and run IDs. Export to JSON/JSONL should be supported. The schema should be designed to support Phase 3 / future cloud sync without migration.

Minimum run metadata:

- Run ID (stable)
- Workflow reference
- Start/end timestamps
- Status (success, failure, cancelled)
- Inputs and outputs
- Harness used
- Runtime connector used
- Error or failure reason

## Personas

### Persona 1: Marcus Chen — Engineering Manager (MVP Primary)

#### Bio and Demographics
- Leads an 8–15 person engineering team at a B2B SaaS company.
- Owns delivery speed, code quality, and team tooling standards.
- Evaluates AI tooling spend and rollout success.
- Works with Platform/Security on governance requirements.

#### Quotes
- "If this cannot be standardized across the team, I cannot support it."
- "I need measurable productivity gains, not isolated power-user wins."
- "I need visibility into how AI tools are being used in engineering workflows."

#### Pain Points
- Fragmented AI tool usage across the team.
- Inconsistent local setups and workflow results.
- Hard to prove ROI from AI tooling spend.
- Slow onboarding for new engineers into team AI practices.

#### How We Help
- Standardize workflows and configuration defaults across the team.
- Provide usage and execution history for visibility.
- Reduce onboarding time with repeatable templates.
- Create a foundation for future governance and reporting.

### Persona 2: Priya Nair — Senior Software Engineer / Tech Lead (MVP Primary)

#### Bio and Demographics
- 6–10 years of backend/full-stack engineering experience.
- Heavy daily user of local developer tools and desktop workflows focused on shipping reliable code quickly.
- Often responsible for code reviews and mentoring other developers.
- Early adopter of agentic workflows, but sensitive to friction.

#### Quotes
- "I will use it only if it is faster than my current setup."
- "I do not want to rebuild my workflow every time tooling changes."
- "I need control for complex tasks, not just a chat box."

#### Pain Points
- Agent workflows are powerful but brittle across environments.
- Too much time lost switching between tools.
- Advanced workflows are hard to share with teammates.
- Trust is limited when workflow behavior is not reproducible.

#### How We Help
- Keep workflows close to the local developer environment where engineering work happens.
- Support repeatable workflow templates for common engineering tasks.
- Preserve developer control while reducing setup drift.
- Make workflow sharing easier through team-level standards.

### Persona 3: Daniel Park — Platform / DevEx Engineer (MVP Secondary Admin)

#### Bio and Demographics
- Owns internal developer tooling and platform reliability.
- Responsible for setup automation, internal docs, and guardrails.
- Bridges engineering, security, and infrastructure requirements.
- Evaluated on reducing developer friction and support burden.

#### Quotes
- "If setup is not reproducible, support load explodes."
- "I need a way to maintain tooling without constant one-off fixes."
- "Governance needs to be built in, not bolted on."

#### Pain Points
- Configuration drift across machines and repositories.
- Support burden from local toolchain breakage.
- Lack of enforceable defaults for AI usage.
- Difficulty maintaining shared integrations at team scale.

#### How We Help
- Centralize reusable defaults and workflow definitions.
- Reduce support load with common setup checks and templates.
- Provide a cleaner path to governance controls over time.
- Make future web/cloud rollout less disruptive.

### Persona 4: Elena Ruiz — Technical Program Manager (Phase 2 Target)

#### Bio and Demographics
- Coordinates cross-functional delivery across product, design, and engineering.
- Uses workflow tools daily but does not rely on IDEs.
- Needs predictable status generation and dependency visibility.
- Partner stakeholder for engineering process adoption.

#### Quotes
- "I need outputs I can trust without depending on a specific engineer."
- "Repeatable workflows matter more than one-off brilliance."
- "Visibility across teams is more valuable than local optimization."

#### Pain Points
- Limited access to engineering AI workflows in desktop-only environments.
- Inconsistent reporting outputs across teams and projects.
- Reliance on engineers to run and interpret workflow outputs.
- No shared cross-functional view of workflow activity.

#### How We Help
- Web integration gives non-desktop stakeholders visibility into workflows.
- Shared templates improve consistency of recurring program workflows.
- Standard outputs reduce coordination friction across teams.
- Execution history improves reporting confidence.

### Persona 5: Maya Patel — Operations Manager (Phase 3 / Future Target)

#### Bio and Demographics
- Leads operations processes with minimal technical setup tolerance.
- Needs browser-first tools that can be adopted by non-developers.
- Owns recurring process execution and team-level consistency.
- Sensitive to training and change management overhead.

#### Quotes
- "I need this to work without local setup."
- "If it takes engineering intervention every time, we will not adopt it."
- "Consistency and ease of use matter more than advanced controls."

#### Pain Points
- Terminal/desktop-first workflows block non-technical adoption.
- Local machine dependencies create operational risk.
- Difficult to run standardized workflows across broader teams.
- Lack of self-serve access delays operational execution.

#### How We Help
- Cloud execution removes local dependency entirely.
- Web workflows support non-technical self-serve usage.
- Standardized environments improve repeatability and trust.
- Expands Tatsu beyond engineering teams.

## MVP Features

- **Standalone Desktop App**: Users open and operate the app on their local machine. 
- **Swarm Control**: Able to control multiple instances of AI CLI tool or workflows on their machine
- **Low level CLI workflows**: Able to see and interact with AI CLI tools (OpenCode, Claude Code)
- **High level workflows**: Expose a text/chat interface while a configurable agent runs underneath; ACP where appropriate
- **Supported CLIs**: OpenCode, Claude Code
- **Dockerized Worktrees**: Sessions are in a dockerized worktree that can be SSHed into
- **Exportable history**
- **GitHub PR/status visibility**
- **Compatibility Matrix for supported software**: Includes CLI harness, harness version, runtime connector tested, supported capabilities, known limitations, and last tested date. Support labels: Tested, Compatible, Best effort, Unsupported.
- **Open in external IDE handoff** — local OS-level convenience only, not an IDE extension or deep integration

### Won't Have in MVP

- Managed cloud containers.
- Full web-only execution.
- IDE extension or IDE integration of any kind.
- Dedicated model provider adapters.
- Non-developer workflow library.
- Public workflow marketplace.
- Custom visual workflow builder.
- BYOK exposed through OpenAI endpoint.
- Enterprise compliance and advanced audit packaging.
- Payment plans (teams vs enterprise etc)

## Success Metrics

- **Ability to control N agents**: Ability to interact and control multiple agents
- **Ability to create N high level workflows**
- **Workflow reuse rate:** Percentage of runs started from shared templates.
- **Run success rate:** Successful workflow runs by runtime/version/workflow combination.
- **Setup failure rate:** Percentage of users blocked by missing host dependencies.
- **Onboarding time:** Time for a new engineer to adopt a team-standard workflow.

### Telemetry and Measurement

Minimum telemetry needed for MVP validation:

- Workflow run started/completed/failed
- Harness and runtime connector used
- Failure reason category
- Time to first successful run
- Template reuse rate
- Setup-check failure rate
- Active users per team/workspace
- Swarm size and control events

Do not rely only on raw usage volume. MVP success depends on repeatability, successful execution, and team reuse.

## Risks and Mitigations

- **Risk: Desktop/local harness narrows the initial market.**
  **Mitigation:** Treat Phase 2 web collaboration as a committed follow-up, not a vague future idea.
- **Risk: OpenCode and Claude Code CLI versions, auth, and local environment behave inconsistently.**
  **Mitigation:** Maintain a compatibility matrix, show clear errors, and track runtime/version failure rates.
- **Risk: OpenCode and Claude Code integrations create support burden.**
  **Mitigation:** Make host dependency checks explicit and document supported versions/configurations.
- **Risk: Local execution still allows environment drift.**
  **Mitigation:** Provide workflow templates, setup checks, and project-level defaults.
- **Risk: Differentiation vs AI coding tools is unclear.**
  **Mitigation:** Position around team workflow standardization, reproducibility, and governance rather than only AI coding assistance.

**Note**: Focus solely on the Phase 1 MVP for now

## Packaging Hypothesis

- **Individual / Developer:** Desktop workflow harness, local execution, host CLI and local credential setup.
- **Team:** Shared workflow templates, team configuration standards, execution history, basic role access.
- **Business / Enterprise (future):** Web control plane, deeper audit history, policy controls, usage analytics, and managed cloud execution.

## Documentation Requirements

MVP documentation should include:

- Getting started guide
- Runtime setup guide for OpenCode and Claude Code
- Compatibility matrix
- Workflow template authoring guide
- Troubleshooting guide for common setup/runtime/harness errors

## Open Decisions

- Exact OpenCode and Claude Code runtime/version compatibility list for MVP.
- Supported external editor handoffs, if any (local OS-level convenience only).
- Whether existing CLI configuration formats should be imported or only referenced.
- Criteria for adding future CLI harnesses beyond MVP.
  - Consider adding a new CLI harness when it represents a meaningful share of active runs, has repeated compatibility failures that cannot be fixed generically, or a harness-specific feature becomes critical to team workflows.
- How secrets are stored locally in MVP.
- What run metadata is safe to store by default.
- Minimum version support policy for OpenCode and Claude Code.
- Pricing boundaries between Team, Business, and future cloud execution tiers.
  - Non-issue. Do not think about for now unless explicitly asked. 
