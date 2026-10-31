import type { WorkflowDefsLoader } from '../workflow-defs-loader'

export interface WorkflowsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, payload: unknown) => unknown): void
}

export interface RegisterWorkflowsRequestHandlersDeps {
  transport: WorkflowsTransportLike
  loader: WorkflowDefsLoader
}

export function registerWorkflowsRequestHandlers({ transport, loader }: RegisterWorkflowsRequestHandlersDeps): void {
  transport.onRequest('workflows:reloadDefinitions', () => loader.reload())
  transport.onRequest('workflows:getDefinition', (_ctx, id) => loader.getDefinition(id))
}
