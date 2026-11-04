import type { AgentKind } from '../terminals'
import { WORKFLOW_FEATURES, type WorkflowAgent } from '../../workflow-def'
import type {
  WorkflowPausedReason,
  WorkflowRunChain,
  WorkflowRunChainItem,
  WorkflowRunChainOrigin,
  WorkflowStepStatus
} from './types'

export const SUMMARY_PREVIEW_MAX = 200
export const WORKFLOW_NO_REPO_DIR_ERROR = 'The repository has no usable .harness/workflows folder in its primary checkout'
export const RECENT_RUNS_MAX = 50
export const WORKFLOW_RUN_RECORD_VERSION = 1
export const RESUMABLE_AGENTS: ReadonlySet<AgentKind> = new Set<AgentKind>(['claude', 'codex', 'opencode'])
export const WORKFLOW_STEP_MODEL_MAX_CHARS = 200
export const GATE_FEEDBACK_MAX_CHARS = 16384
export const WORKFLOW_BUDGET_MAX_USD = 10000
export const WORKFLOW_INPUT_VALUE_MAX_CHARS = 64 * 1024
export const WORKFLOW_CHAIN_ID_MAX_CHARS = 128
export const WORKFLOW_CHAIN_BRANCH_MAX_CHARS = 255
export const WORKFLOW_CHAIN_URL_MAX_CHARS = 2048
export const STEP_HARNESS_AGENTS: readonly WorkflowAgent[] = [
  'claude',
  ...(WORKFLOW_FEATURES['agent-codex'].supported ? (['codex'] as const) : []),
  ...(WORKFLOW_FEATURES['agent-opencode'].supported ? (['opencode'] as const) : [])
]

export function isStepHarnessAgent(value: unknown): value is WorkflowAgent {
  return typeof value === 'string' && STEP_HARNESS_AGENTS.some((agent) => agent === value)
}

export function isBudgetUsd(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= WORKFLOW_BUDGET_MAX_USD
}

const WORKFLOW_INPUT_NUMBER_PATTERN = /^[1-9]\d{0,9}$/

export function isWorkflowInputNumber(value: unknown): value is string {
  return typeof value === 'string' && WORKFLOW_INPUT_NUMBER_PATTERN.test(value)
}

function isGithubNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && isWorkflowInputNumber(String(value))
}

function isText(value: unknown, max: number, min = 0): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function parseChainItem(value: unknown): WorkflowRunChainItem | null {
  const item = asRecord(value)
  if (!item) return null
  const { id, title, value: itemValue, branch, baseBranch, number, url } = item
  if (!isText(id, WORKFLOW_CHAIN_ID_MAX_CHARS, 1)) return null
  if (!isText(title, WORKFLOW_INPUT_VALUE_MAX_CHARS) || !isText(itemValue, WORKFLOW_INPUT_VALUE_MAX_CHARS)) return null
  if (!isText(branch, WORKFLOW_CHAIN_BRANCH_MAX_CHARS, 1) || !isText(baseBranch, WORKFLOW_CHAIN_BRANCH_MAX_CHARS)) return null
  if (number !== undefined && !isGithubNumber(number)) return null
  if (url !== undefined && !isText(url, WORKFLOW_CHAIN_URL_MAX_CHARS)) return null
  return {
    id,
    title,
    value: itemValue,
    branch,
    baseBranch,
    ...(number === undefined ? {} : { number }),
    ...(url === undefined ? {} : { url })
  }
}

function parseChainOrigin(value: unknown): WorkflowRunChainOrigin | null {
  const origin = asRecord(value)
  if (!origin) return null
  const { kind, number } = origin
  if ((kind !== 'issue' && kind !== 'pr') || !isGithubNumber(number)) return null
  return { kind, number }
}

export function parseWorkflowRunChain(value: unknown): WorkflowRunChain | null {
  const chain = asRecord(value)
  if (!chain || !isText(chain.chainId, WORKFLOW_CHAIN_ID_MAX_CHARS, 1)) return null
  const item = parseChainItem(chain.item)
  if (!item) return null
  if (chain.origin === undefined) return { chainId: chain.chainId, item }
  const origin = parseChainOrigin(chain.origin)
  return origin ? { chainId: chain.chainId, item, origin } : null
}

export function isWorkflowStepModel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim() !== '' &&
    value.length <= WORKFLOW_STEP_MODEL_MAX_CHARS &&
    !/[\u0000-\u001f\u007f]/.test(value)
  )
}

export const PAUSED_REASON_LABELS: Record<WorkflowPausedReason, string> = {
  'step-failed': 'Step failed',
  'needs-input': 'Needs input',
  'needs-approval': 'Needs approval',
  interrupted: 'Interrupted',
  trust: 'Folder not trusted',
  gate: 'Waiting at gate',
  budget: 'Budget reached',
  'loop-cap': 'Loop limit reached',
  timeout: 'Timed out',
  'restack-conflict': 'Restack conflict',
  'publish-failed': 'Pull request failed'
}

export function pausedReasonLabel(reason: WorkflowPausedReason, stepStatus: WorkflowStepStatus | null): string {
  if (reason === 'step-failed' && stepStatus === 'cancelled') return 'Cancelled by user'
  return PAUSED_REASON_LABELS[reason]
}
