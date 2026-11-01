import type { WorkflowDefsLoader } from '../workflow-defs-loader'
import type { WorkflowRunLookup } from '../workflow-run-records'

export interface WorkflowsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, payload: unknown) => unknown): void
}

export interface RegisterWorkflowsRequestHandlersDeps {
  transport: WorkflowsTransportLike
  loader: WorkflowDefsLoader
  runs: WorkflowRunLookup
}

export function registerWorkflowsRequestHandlers({
  transport,
  loader,
  runs
}: RegisterWorkflowsRequestHandlersDeps): void {
  transport.onRequest('workflows:reloadDefinitions', () => loader.reload())
  transport.onRequest('workflows:getDefinition', (_ctx, id) => loader.getDefinition(id))
  transport.onRequest('workflows:getRun', (_ctx, runId) => runs.getRun(runId))
  transport.onRequest('workflows:getAttemptResult', (_ctx, attemptId) => runs.getAttemptResult(attemptId))
}
