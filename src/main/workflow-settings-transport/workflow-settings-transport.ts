import type { Config } from '../persistence'
import {
  clampMaxConcurrentAgents,
  type LabsSettings,
  type SettingsEvent,
  type SettingsState,
  type WorkflowSettings
} from '../../shared/state/settings'

export interface WorkflowSettingsTransportLike {
  onRequest(name: string, handler: (ctx: unknown, payload: unknown) => unknown): void
}

export interface RegisterWorkflowSettingsRequestHandlersDeps {
  transport: WorkflowSettingsTransportLike
  config: Config
  saveConfig: (config: Config) => void
  getSettings: () => SettingsState
  dispatch: (event: SettingsEvent) => void
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseLabsPatch(payload: unknown): Partial<LabsSettings> | null {
  if (!isObject(payload)) return null
  if (!('workflows' in payload) || payload.workflows === undefined) return {}
  return typeof payload.workflows === 'boolean' ? { workflows: payload.workflows } : null
}

function parseWorkflowSettingsPatch(payload: unknown): Partial<WorkflowSettings> | null {
  if (!isObject(payload)) return null
  if (!('maxConcurrentAgents' in payload) || payload.maxConcurrentAgents === undefined) return {}
  const maxConcurrentAgents = clampMaxConcurrentAgents(payload.maxConcurrentAgents)
  return maxConcurrentAgents === null ? null : { maxConcurrentAgents }
}

export function registerWorkflowSettingsRequestHandlers({
  transport,
  config,
  saveConfig,
  getSettings,
  dispatch
}: RegisterWorkflowSettingsRequestHandlersDeps): void {
  transport.onRequest('settings:setLabs', (_ctx, payload) => {
    const patch = parseLabsPatch(payload)
    if (!patch) return false
    config.labs = { ...getSettings().labs, ...patch }
    saveConfig(config)
    dispatch({ type: 'settings/labsChanged', payload: patch })
    return true
  })

  transport.onRequest('settings:setWorkflowSettings', (_ctx, payload) => {
    const patch = parseWorkflowSettingsPatch(payload)
    if (!patch) return false
    config.workflowSettings = { ...getSettings().workflows, ...patch }
    saveConfig(config)
    dispatch({ type: 'settings/workflowSettingsChanged', payload: patch })
    return true
  })
}
