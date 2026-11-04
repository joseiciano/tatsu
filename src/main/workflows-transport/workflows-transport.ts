import type {
  DefinitionWriteRefusal,
  DeleteDefinitionResult,
  SaveDefinitionRequest,
  SaveDefinitionResult,
  WorkflowDefsLoader
} from '../workflow-defs-loader'
import { getAttemptChangedFiles, getAttemptFileDiff } from './attempt-changes'
import { RUN_ID_PATTERN, isRunId, type WorkflowRunLookup } from '../workflow-run-records'
import {
  RUN_INPUTS_MAX,
  type InputTrustFetcher,
  sanitizePasteText,
  type MarkDoneRequest,
  type RequestChangesRequest,
  type StartRefusal,
  type StartRunRequest,
  type StepActionResult,
  type StepOverrideRequest,
  type SwapStepRequest,
  type WorkflowLog,
  type WorkflowRunner
} from '../workflow-runner'
import {
  GATE_FEEDBACK_MAX_CHARS,
  isWorkflowInputNumber,
  isWorkflowStepModel,
  WORKFLOW_NO_REPO_DIR_ERROR,
  type WorkflowActionResponse,
  type WorkflowDefinitionSaveResponse,
  type WorkflowInputTrustResponse,
  type WorkflowLoopCapAction,
  type WorkflowStartRunResponse
} from '../../shared/state/workflows'
import type { PersistedWorkflowTrust } from '../persistence'
import type { Store } from '../store'

export interface WorkflowsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, ...args: unknown[]) => unknown): void
}

export type WorkflowActionsRunner = Pick<
  WorkflowRunner,
  | 'start'
  | 'cancelRun'
  | 'cancelStep'
  | 'retryStep'
  | 'retryFromClean'
  | 'skipStep'
  | 'markDone'
  | 'resumeStep'
  | 'swapStep'
  | 'approveGate'
  | 'requestChanges'
  | 'resolveLoopCap'
  | 'keepWaiting'
>

export interface RegisterWorkflowsRequestHandlersDeps {
  transport: WorkflowsTransportLike
  loader: Pick<
    WorkflowDefsLoader,
    'reload' | 'getDefinition' | 'saveDefinition' | 'duplicateDefinition' | 'deleteDefinition'
  >
  runs: WorkflowRunLookup
  runner: WorkflowActionsRunner
  store: Pick<Store, 'getSnapshot' | 'dispatch'>
  persistTrust: (entry: PersistedWorkflowTrust) => void
  inputTrust: InputTrustFetcher
  log: WorkflowLog
}

const DEF_ID_MAX_CHARS = 256
const WORKTREE_PATH_MAX_CHARS = 4096
const OUTPUT_ERRORS_SHOWN = 5
const ERROR_MAX_CHARS = 1000
const AGENT_MAX_CHARS = 32
const OVERRIDES_MAX = 64

const INTERNAL_ERROR = { error: 'internal error' } as const
const INVALID_REQUEST = { error: 'invalid request' } as const
const DEFINITION_HASH_PATTERN = /^[0-9a-f]{64}$/
const START_RUN_KEYS = ['defId', 'worktreePath', 'inputs', 'allowFull', 'overrides', 'autopilot'] as const
const REQUEST_CHANGES_KEYS = ['feedback', 'fresh'] as const
const SAVE_DEFINITION_KEYS = ['scope', 'repoRoot', 'defId', 'name', 'source'] as const
const DEFINITION_NAME_MAX_CHARS = 200

const WRITE_ERRORS: Record<DefinitionWriteRefusal | Exclude<DeleteDefinitionResult, { ok: true }>['reason'], string> = {
  'invalid-name': 'The name needs at least one letter or digit',
  'unsafe-name': 'The name must not contain a slash, a backslash, NUL or "..", or start with a dot',
  'too-large': 'The workflow definition is larger than 256 KB',
  'unknown-repo': 'Unknown repository',
  'no-repo-dir': WORKFLOW_NO_REPO_DIR_ERROR,
  'unknown-definition': 'Unknown workflow definition',
  'scope-mismatch': 'The workflow definition belongs to a different folder',
  exists: 'A workflow file with that name already exists',
  'too-many-files': 'The workflows folder already holds the maximum number of files',
  'not-a-file': 'The workflow file is not a regular file',
  'not-allowed': 'Trust this repo definition before duplicating it',
  'write-failed': 'Could not write the workflow file'
}

const START_ERRORS: Record<StartRefusal, string> = {
  'labs-off': 'Workflows are turned off in Labs',
  'unknown-definition': 'Unknown workflow definition',
  'untrusted-definition': 'Trust this definition before running it',
  'invalid-definition': 'The workflow definition is invalid',
  'unsupported-step': 'The workflow uses a step kind this version cannot run',
  'invalid-overrides': 'A step override names a step that is not an agent step, or has an invalid model',
  'unsupported-agent': 'A step override names an agent that cannot run workflow steps',
  'full-permission-unconfirmed': 'This workflow has a full-access step; confirm full access to start it',
  'worktree-busy': 'A workflow is already running in this worktree',
  'unknown-worktree': 'Unknown worktree',
  'invalid-inputs': 'The workflow inputs are invalid',
  'missing-input': 'A required workflow input is missing',
  'hooks-consent': 'Accept the hooks install before running agent steps',
  'codex-hooks-untrusted': 'Open a Codex tab and run /hooks',
  'parallel-writer': 'Steps that can run at the same time must not write; make them read-only or order them with "needs"',
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
  'not-resumable-step': 'Only Claude, Codex and opencode agent steps can be resumed',
  'not-interrupted': 'Only an interrupted attempt can be resumed',
  'no-session': 'The attempt has no stored session to resume; use Retry instead',
  'nothing-to-cancel': 'The step is not running or queued',
  'not-completable': 'This step cannot be marked done now',
  'not-agent-step': 'Only agent steps can switch harness or model',
  'not-swappable': 'Only a failed, cancelled or interrupted step can switch harness or model',
  'unsupported-agent': 'That agent cannot run workflow steps',
  'invalid-override': 'The model name is invalid',
  'hooks-consent': 'Accept the hooks install before running agent steps',
  'codex-hooks-untrusted': 'Open a Codex tab and run /hooks',
  'full-permission-unconfirmed': 'This step has full access; confirm full access for the new agent',
  starting: 'Tatsu is still starting; try again',
  'not-continuable-step': 'Only agent steps can continue their session',
  'nothing-to-continue': 'This step has no earlier attempt to continue',
  'not-awaiting-gate': 'This step is not waiting at its gate',
  'not-at-loop-cap': 'This step is not waiting at its loop cap',
  'not-timed-out': 'This step has not timed out',
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

function isLoopCapAction(value: unknown): value is WorkflowLoopCapAction {
  return value === 'again' || value === 'continue'
}

function isStepId(value: unknown): value is string {
  return typeof value === 'string' && RUN_ID_PATTERN.test(value)
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key))
}

function parseStepOverride(value: unknown): StepOverrideRequest | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['agent', 'model'])) return null
  const agent = ownValue(value, 'agent')
  const model = ownValue(value, 'model')
  if (agent === undefined && model === undefined) return null
  if (agent !== undefined && !boundedString(agent, AGENT_MAX_CHARS)) return null
  if (model !== undefined && !isWorkflowStepModel(model)) return null
  return { ...(agent === undefined ? {} : { agent }), ...(model === undefined ? {} : { model }) }
}

function parseOverrides(value: unknown): Record<string, StepOverrideRequest> | null {
  if (!isPlainObject(value)) return null
  const entries = Object.entries(value)
  if (entries.length > OVERRIDES_MAX) return null
  const overrides: Record<string, StepOverrideRequest> = {}
  for (const [stepId, raw] of entries) {
    const override = parseStepOverride(raw)
    if (!isStepId(stepId) || !override) return null
    Object.defineProperty(overrides, stepId, { value: override, enumerable: true, writable: true, configurable: true })
  }
  return overrides
}

function parseSwapStep(payload: unknown): SwapStepRequest | null {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, ['agent', 'model', 'allowFull'])) return null
  const allowFull = ownValue(payload, 'allowFull')
  if (allowFull !== undefined && typeof allowFull !== 'boolean') return null
  const override = parseStepOverride(pick(payload, ['agent', 'model']))
  if (!override) return null
  return allowFull === true ? { ...override, allowFull } : override
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of keys) if (Object.hasOwn(record, key)) out[key] = record[key]
  return out
}

function parseStartRun(payload: unknown): StartRunRequest | null {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, START_RUN_KEYS)) return null
  const defId = ownValue(payload, 'defId')
  const worktreePath = ownValue(payload, 'worktreePath')
  const rawInputs = ownValue(payload, 'inputs', {})
  const allowFull = ownValue(payload, 'allowFull')
  const rawOverrides = ownValue(payload, 'overrides')
  const autopilot = ownValue(payload, 'autopilot')
  if (allowFull !== undefined && typeof allowFull !== 'boolean') return null
  if (autopilot !== undefined && typeof autopilot !== 'boolean') return null
  const overrides = rawOverrides === undefined ? undefined : parseOverrides(rawOverrides)
  if (overrides === null) return null
  if (!boundedString(defId, DEF_ID_MAX_CHARS) || !boundedString(worktreePath, WORKTREE_PATH_MAX_CHARS)) return null
  if (!isPlainObject(rawInputs)) return null
  const entries = Object.entries(rawInputs)
  if (entries.length > RUN_INPUTS_MAX) return null
  const inputs: Record<string, string> = {}
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return null
    Object.defineProperty(inputs, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return {
    defId,
    worktreePath,
    inputs,
    ...(allowFull === true ? { allowFull } : {}),
    ...(overrides === undefined ? {} : { overrides }),
    ...(autopilot === true ? { autopilot } : {})
  }
}

function parseSaveDefinition(payload: unknown): SaveDefinitionRequest | null {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, SAVE_DEFINITION_KEYS)) return null
  const scope = ownValue(payload, 'scope')
  const repoRoot = ownValue(payload, 'repoRoot')
  const defId = ownValue(payload, 'defId')
  const name = ownValue(payload, 'name')
  const source = ownValue(payload, 'source')
  if (!boundedString(name, DEFINITION_NAME_MAX_CHARS) || typeof source !== 'string' || source === '') return null
  if (defId !== undefined && !boundedString(defId, DEF_ID_MAX_CHARS)) return null
  const rest = { name, source, ...(defId === undefined ? {} : { defId }) }
  if (scope === 'personal' && repoRoot === undefined) return { scope, ...rest }
  if (scope === 'repo' && boundedString(repoRoot, WORKTREE_PATH_MAX_CHARS)) return { scope, repoRoot, ...rest }
  return null
}

function saveResponse(result: SaveDefinitionResult): WorkflowDefinitionSaveResponse {
  return result.ok ? { defId: result.summary.id } : { error: WRITE_ERRORS[result.reason] }
}

function parseMarkDone(payload: unknown): MarkDoneRequest | null {
  if (!isPlainObject(payload)) return null
  const summary = ownValue(payload, 'summary')
  const fields = ownValue(payload, 'fields', {})
  if (typeof summary !== 'string' || !isPlainObject(fields)) return null
  return { summary, fields }
}

function parseRequestChanges(payload: unknown): RequestChangesRequest | null {
  if (!isPlainObject(payload) || !hasOnlyKeys(payload, REQUEST_CHANGES_KEYS)) return null
  const feedback = ownValue(payload, 'feedback')
  const fresh = ownValue(payload, 'fresh')
  if (typeof fresh !== 'boolean' || typeof feedback !== 'string' || feedback.length > GATE_FEEDBACK_MAX_CHARS) return null
  if (sanitizePasteText(feedback).trim() === '') return null
  return { feedback, fresh }
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
  store,
  persistTrust,
  inputTrust,
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

  guarded('workflows:getAttemptChangedFiles', ([attemptId]) => getAttemptChangedFiles(runs, attemptId))
  guarded('workflows:getAttemptFileDiff', ([attemptId, path]) => getAttemptFileDiff(runs, attemptId, path))
  guarded('workflows:startRun', async ([payload]): Promise<WorkflowStartRunResponse> => {
    const request = parseStartRun(payload)
    if (!request) return INVALID_REQUEST
    const result = await runner.start(request)
    return result.ok ? { runId: result.runId } : { error: START_ERRORS[result.reason] }
  })
  guarded('workflows:checkInputTrust', async ([root, type, number]): Promise<WorkflowInputTrustResponse> => {
    const { settings, worktrees } = store.getSnapshot().state
    if (!settings.labs.workflows) return { error: START_ERRORS['labs-off'] }
    if (!boundedString(root, WORKTREE_PATH_MAX_CHARS) || (type !== 'issue' && type !== 'pr') || !isWorkflowInputNumber(number)) {
      return INVALID_REQUEST
    }
    const known = worktrees.repoRoots.includes(root) || worktrees.list.some((worktree) => worktree.path === root)
    if (!known) return { error: 'Unknown repository' }
    const verdict = await inputTrust(root, type, number)
    log('workflow', `input trust checked ${verdict === 'trusted' ? 'trusted' : 'untrusted'}`, { type, number })
    return { trusted: verdict === 'trusted' }
  })
  guarded('workflows:trustDefinition', ([defId, hash]): WorkflowActionResponse => {
    if (!store.getSnapshot().state.settings.labs.workflows) return { error: START_ERRORS['labs-off'] }
    if (!boundedString(defId, DEF_ID_MAX_CHARS) || typeof hash !== 'string' || !DEFINITION_HASH_PATTERN.test(hash)) {
      return INVALID_REQUEST
    }
    const detail = loader.getDefinition(defId)
    if (!detail) return { error: START_ERRORS['unknown-definition'] }
    const { summary } = detail
    if (summary.scope !== 'repo' || summary.repoRoot === undefined) {
      return { error: 'Only repo workflow definitions need trust' }
    }
    if (summary.hash !== hash) {
      return { error: 'The workflow definition changed on disk; review it again before trusting it' }
    }
    persistTrust({ repoRoot: summary.repoRoot, path: summary.path, hash })
    store.dispatch({ type: 'workflows/trustGranted', payload: { defId: summary.id, hash } })
    log('workflow', 'definition trusted', { defId: summary.id })
    return { ok: true }
  })
  const labsOff = (): { error: string } | null =>
    store.getSnapshot().state.settings.labs.workflows ? null : { error: START_ERRORS['labs-off'] }
  guarded('workflows:saveDefinition', ([payload]): WorkflowDefinitionSaveResponse => {
    const off = labsOff()
    if (off) return off
    const request = parseSaveDefinition(payload)
    if (!request) return INVALID_REQUEST
    return saveResponse(loader.saveDefinition(request))
  })
  guarded('workflows:duplicateDefinition', ([defId]): WorkflowDefinitionSaveResponse => {
    const off = labsOff()
    if (off) return off
    if (!boundedString(defId, DEF_ID_MAX_CHARS)) return INVALID_REQUEST
    return saveResponse(
      loader.duplicateDefinition(defId, ({ summary }) => {
        if (summary.scope === 'personal') return true
        const { trust } = store.getSnapshot().state.workflows
        return Object.hasOwn(trust, summary.id) && trust[summary.id] === summary.hash
      })
    )
  })
  guarded('workflows:deleteDefinition', ([defId]): WorkflowActionResponse => {
    const off = labsOff()
    if (off) return off
    if (!boundedString(defId, DEF_ID_MAX_CHARS)) return INVALID_REQUEST
    const result = loader.deleteDefinition(defId)
    return result.ok ? { ok: true } : { error: WRITE_ERRORS[result.reason] }
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
  guarded('workflows:swapStep', ([runId, stepId, payload]): WorkflowActionResponse => {
    const request = parseSwapStep(payload)
    if (!isRunId(runId) || !isStepId(stepId) || !request) return INVALID_REQUEST
    return actionResponse(runner.swapStep(runId, stepId, request))
  })
  stepAction('workflows:approveGate', (runId, stepId) => runner.approveGate(runId, stepId))
  guarded('workflows:requestChanges', ([runId, stepId, payload]): WorkflowActionResponse => {
    const request = parseRequestChanges(payload)
    if (!isRunId(runId) || !isStepId(stepId) || !request) return INVALID_REQUEST
    return actionResponse(runner.requestChanges(runId, stepId, request))
  })
  guarded('workflows:resolveLoopCap', ([runId, stepId, action]): WorkflowActionResponse => {
    if (!isRunId(runId) || !isStepId(stepId) || !isLoopCapAction(action)) return INVALID_REQUEST
    return actionResponse(runner.resolveLoopCap(runId, stepId, action))
  })
  stepAction('workflows:keepWaiting', (runId, stepId) => runner.keepWaiting(runId, stepId))
  guarded('workflows:markDone', ([runId, stepId, payload]): WorkflowActionResponse => {
    const request = parseMarkDone(payload)
    if (!isRunId(runId) || !isStepId(stepId) || !request) return INVALID_REQUEST
    return actionResponse(runner.markDone(runId, stepId, request))
  })
}
