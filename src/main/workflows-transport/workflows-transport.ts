import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import { RUN_ID_PATTERN, isRunId, type WorkflowRunLookup } from '../workflow-run-records'
import {
  RUN_INPUTS_MAX,
  type MarkDoneRequest,
  type StartRefusal,
  type StartRunRequest,
  type StepActionResult,
  type WorkflowLog,
  type WorkflowRunner
} from '../workflow-runner'
import type { WorkflowActionResponse, WorkflowStartRunResponse } from '../../shared/state/workflows'

export interface WorkflowsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, ...args: unknown[]) => unknown): void
}

export type WorkflowActionsRunner = Pick<
  WorkflowRunner,
  'start' | 'cancelRun' | 'cancelStep' | 'retryStep' | 'retryFromClean' | 'skipStep' | 'markDone' | 'resumeStep'
>

export interface RegisterWorkflowsRequestHandlersDeps {
  transport: WorkflowsTransportLike
  loader: WorkflowDefsLoader
  runs: WorkflowRunLookup
  runner: WorkflowActionsRunner
  log: WorkflowLog
}

const DEF_ID_MAX_CHARS = 256
const WORKTREE_PATH_MAX_CHARS = 4096
const OUTPUT_ERRORS_SHOWN = 5
const ERROR_MAX_CHARS = 1000

const INTERNAL_ERROR = { error: 'internal error' } as const
const INVALID_REQUEST = { error: 'invalid request' } as const

const START_ERRORS: Record<StartRefusal, string> = {
  'labs-off': 'Workflows are turned off in Labs',
  'unknown-definition': 'Unknown workflow definition',
  'invalid-definition': 'The workflow definition is invalid',
  'unsupported-step': 'The workflow uses a step kind this version cannot run',
  'full-permission-unconfirmed': 'This workflow has a full-access step; confirm full access to start it',
  'worktree-busy': 'A workflow is already running in this worktree',
  'unknown-worktree': 'Unknown worktree',
  'invalid-inputs': 'The workflow inputs are invalid',
  'missing-input': 'A required workflow input is missing',
  'hooks-consent': 'Accept the hooks install before running agent steps',
  starting: 'Tatsu is still starting; try again'
}

const ACTION_ERRORS: Record<Exclude<StepActionResult, { ok: true }>['reason'], string> = {
  'unknown-run': 'Unknown or finished run',
  'wrong-step': 'That step is not the current step of the run',
  'not-paused': 'The run is not paused',
  'labs-off': 'Workflows are turned off in Labs',
  busy: 'Another action is still running for this run',
  'awaiting-approval': 'The agent is waiting for approval in its tab; approve it or cancel the step first',
  'live-attempt': 'Cancel the running step first',
  'no-snapshot': 'This step has no clean snapshot to restore',
  'restore-failed': 'Could not restore the clean snapshot',
  'not-claude-step': 'Only Claude agent steps can be resumed',
  'not-interrupted': 'Only an interrupted attempt can be resumed',
  'no-session': 'The attempt has no stored session to resume; use Retry instead',
  'nothing-to-cancel': 'The step is not running or queued',
  'not-completable': 'This step cannot be marked done now',
  starting: 'Tatsu is still starting; try again',
  'invalid-output': 'Invalid step output'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function ownValue(record: Record<string, unknown>, key: string, fallback?: unknown): unknown {
  return Object.hasOwn(record, key) ? record[key] : fallback
}

function isStepId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function parseStartRun(payload: unknown): StartRunRequest | null {
  if (!isPlainObject(payload)) return null
  const defId = ownValue(payload, 'defId')
  const worktreePath = ownValue(payload, 'worktreePath')
  const rawInputs = ownValue(payload, 'inputs', {})
  const allowFull = ownValue(payload, 'allowFull')
  if (allowFull !== undefined && typeof allowFull !== 'boolean') return null
  if (!boundedString(defId, DEF_ID_MAX_CHARS) || !boundedString(worktreePath, WORKTREE_PATH_MAX_CHARS)) return null
  if (!isPlainObject(rawInputs)) return null
  const entries = Object.entries(rawInputs)
  if (entries.length > RUN_INPUTS_MAX) return null
  const inputs: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return null
    Object.defineProperty(inputs, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return allowFull === true ? { defId, worktreePath, inputs, allowFull } : { defId, worktreePath, inputs }
}

function parseMarkDone(payload: unknown): MarkDoneRequest | null {
  if (!isPlainObject(payload)) return null
  const summary = ownValue(payload, 'summary')
  const fields = ownValue(payload, 'fields', {})
  if (typeof summary !== 'string' || !isPlainObject(fields)) return null
  return { summary, fields }
}

function isConfirmed(payload: unknown): boolean {
  return isPlainObject(payload) && ownValue(payload, 'confirmed') === true
}

function actionResponse(result: StepActionResult): WorkflowActionResponse {
  if (result.ok) return { ok: true }
  if (result.reason !== 'invalid-output') return { error: ACTION_ERRORS[result.reason] }
  const details = result.errors
    .slice(0, OUTPUT_ERRORS_SHOWN)
    .map(({ field, message }) => (field === '' ? message : `${field}: ${message}`))
    .join('; ')
  return { error: `${ACTION_ERRORS['invalid-output']}: ${details}`.slice(0, ERROR_MAX_CHARS) }
}

export function registerWorkflowsRequestHandlers({
  transport,
  loader,
  runs,
  runner,
  log
}: RegisterWorkflowsRequestHandlersDeps): void {
  transport.onRequest('workflows:reloadDefinitions', () => loader.reload())
  transport.onRequest('workflows:getDefinition', (_ctx, id) => loader.getDefinition(id))
  transport.onRequest('workflows:getRun', (_ctx, runId) => runs.getRun(runId))
  transport.onRequest('workflows:getAttemptResult', (_ctx, attemptId) => runs.getAttemptResult(attemptId))

  const guarded = <T>(name: string, handle: (args: unknown[]) => T | Promise<T>): void => {
    transport.onRequest(name, async (_ctx, ...args) => {
      try {
        return await handle(args)
      } catch (err) {
        log('workflow', `request failed ${name}`, { error: err instanceof Error ? err.name : typeof err })
        return INTERNAL_ERROR
      }
    })
  }

  const stepAction = (
    name: string,
    act: (runId: string, stepId: string) => StepActionResult | Promise<StepActionResult>
  ): void => {
    guarded(name, async ([runId, stepId]): Promise<WorkflowActionResponse> => {
      if (!isRunId(runId) || !isStepId(stepId)) return INVALID_REQUEST
      return actionResponse(await act(runId, stepId))
    })
  }

  guarded('workflows:startRun', ([payload]): WorkflowStartRunResponse => {
    const request = parseStartRun(payload)
    if (!request) return INVALID_REQUEST
    const result = runner.start(request)
    return result.ok ? { runId: result.runId } : { error: START_ERRORS[result.reason] }
  })
  guarded('workflows:cancelRun', ([runId]): WorkflowActionResponse => {
    if (!isRunId(runId)) return INVALID_REQUEST
    return actionResponse(runner.cancelRun(runId))
  })
  stepAction('workflows:cancelStep', (runId, stepId) => runner.cancelStep(runId, stepId))
  stepAction('workflows:retryStep', (runId, stepId) => runner.retryStep(runId, stepId))
  stepAction('workflows:skipStep', (runId, stepId) => runner.skipStep(runId, stepId))
  stepAction('workflows:resumeStep', (runId, stepId) => runner.resumeStep(runId, stepId))
  guarded('workflows:retryFromClean', async ([runId, stepId, confirmation]): Promise<WorkflowActionResponse> => {
    if (!isRunId(runId) || !isStepId(stepId)) return INVALID_REQUEST
    if (!isConfirmed(confirmation)) return { error: 'Retry from clean needs explicit confirmation' }
    return actionResponse(await runner.retryFromClean(runId, stepId))
  })
  guarded('workflows:markDone', ([runId, stepId, payload]): WorkflowActionResponse => {
    const request = parseMarkDone(payload)
    if (!isRunId(runId) || !isStepId(stepId) || !request) return INVALID_REQUEST
    return actionResponse(runner.markDone(runId, stepId, request))
  })
}
