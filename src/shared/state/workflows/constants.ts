import type { AgentKind } from '../terminals'

export const SUMMARY_PREVIEW_MAX = 200
export const RECENT_RUNS_MAX = 50
export const WORKFLOW_RUN_RECORD_VERSION = 1
export const RESUMABLE_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude', 'codex'])
