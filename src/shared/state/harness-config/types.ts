import type { HarnessConfigResourceType } from '../../agent-registry'
import type { AgentKind } from '../terminals'

export type { HarnessConfigResourceType } from '../../agent-registry'

export type ManagedHarnessKind = Extract<AgentKind, 'claude' | 'codex' | 'opencode'>

export interface HarnessConfigScope {
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
}

export type HarnessConfigScopeKey = `${ManagedHarnessKind}:${HarnessConfigResourceType}`

export interface HarnessConfigFileRef {
  id: string
  agentKind: ManagedHarnessKind
  resourceType: HarnessConfigResourceType
  canonicalResourceType: HarnessConfigResourceType
  aliasResourceTypes: HarnessConfigResourceType[]
  label: string
  relativePath: string
  absolutePath: string
  hash: string
  existsOnDisk: boolean
  managed: boolean
  updatedAt: number
}

export type HarnessConfigSyncDirection = 'sync-to-disk' | 'adopt-from-disk'

export type HarnessConfigSyncStatus = 'synced' | 'disk-only' | 'config-only' | 'conflict'

export interface HarnessConfigChangedRef {
  disk: HarnessConfigFileRef
  config: HarnessConfigFileRef
}

export interface HarnessConfigComparison {
  scope: HarnessConfigScope
  status: HarnessConfigSyncStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  comparedAt: number
}

export interface HarnessConfigSyncPlan {
  planId: string
  scope: HarnessConfigScope
  direction: HarnessConfigSyncDirection
  status: HarnessConfigSyncStatus
  diskOnly: HarnessConfigFileRef[]
  configOnly: HarnessConfigFileRef[]
  changed: HarnessConfigChangedRef[]
  generatedAt: number
  fingerprint: string
}

export interface HarnessConfigState {
  resources: Record<HarnessConfigResourceType, HarnessConfigFileRef[]>
  comparisons: Partial<Record<HarnessConfigScopeKey, HarnessConfigComparison>>
  loading: boolean
  error: string | null
  lastScannedAt: number | null
  lastSyncedAt: number | null
}

export type HarnessConfigEvent =
  | { type: 'harnessConfig/loadingChanged'; payload: boolean }
  | {
      type: 'harnessConfig/resourcesLoaded'
      payload: {
        scope: HarnessConfigScope
        resources: HarnessConfigFileRef[]
        scannedAt: number
      }
    }
  | { type: 'harnessConfig/comparisonLoaded'; payload: HarnessConfigComparison }
  | {
      type: 'harnessConfig/syncApplied'
      payload: { scope: HarnessConfigScope; syncedAt: number }
    }
  | { type: 'harnessConfig/resourceUpserted'; payload: HarnessConfigFileRef }
  | {
      type: 'harnessConfig/resourceDeleted'
      payload: {
        agentKind: ManagedHarnessKind
        resourceType: HarnessConfigResourceType
        id: string
      }
    }
  | { type: 'harnessConfig/errorChanged'; payload: string | null }
