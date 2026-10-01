import type {
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigScope,
  HarnessConfigScopeKey,
  HarnessConfigState,
  ManagedHarnessKind
} from './types'

const HARNESS_ORDER: Record<ManagedHarnessKind, number> = {
  claude: 0,
  codex: 1,
  opencode: 2
}

export const initialHarnessConfig: HarnessConfigState = {
  resources: {
    agents: [],
    skills: [],
    commands: []
  },
  comparisons: {},
  loading: false,
  error: null,
  lastScannedAt: null,
  lastSyncedAt: null
}

export function harnessConfigScopeKey(scope: HarnessConfigScope): HarnessConfigScopeKey {
  return `${scope.agentKind}:${scope.resourceType}`
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareResources(left: HarnessConfigFileRef, right: HarnessConfigFileRef): number {
  return (
    HARNESS_ORDER[left.agentKind] - HARNESS_ORDER[right.agentKind] ||
    compareText(left.relativePath, right.relativePath) ||
    compareText(left.id, right.id)
  )
}

function hasSameSequence(
  left: HarnessConfigFileRef[],
  right: HarnessConfigFileRef[]
): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

export function harnessConfigReducer(
  state: HarnessConfigState,
  event: HarnessConfigEvent
): HarnessConfigState {
  switch (event.type) {
    case 'harnessConfig/loadingChanged':
      if (state.loading === event.payload) return state
      return { ...state, loading: event.payload }

    case 'harnessConfig/resourcesLoaded': {
      const { scope, resources, scannedAt } = event.payload
      const current = state.resources[scope.resourceType]
      const next: HarnessConfigFileRef[] = []

      for (const resource of current) {
        if (resource.agentKind !== scope.agentKind) next.push(resource)
      }
      for (const resource of resources) {
        if (
          resource.agentKind === scope.agentKind &&
          resource.resourceType === scope.resourceType
        ) {
          next.push(resource)
        }
      }
      next.sort(compareResources)

      if (hasSameSequence(current, next)) {
        if (state.lastScannedAt === scannedAt) return state
        return { ...state, lastScannedAt: scannedAt }
      }

      return {
        ...state,
        resources: { ...state.resources, [scope.resourceType]: next },
        lastScannedAt: scannedAt
      }
    }

    case 'harnessConfig/comparisonLoaded': {
      const key = harnessConfigScopeKey(event.payload.scope)
      if (state.comparisons[key] === event.payload) return state
      return {
        ...state,
        comparisons: { ...state.comparisons, [key]: event.payload }
      }
    }

    case 'harnessConfig/syncApplied':
      if (state.lastSyncedAt === event.payload.syncedAt) return state
      return { ...state, lastSyncedAt: event.payload.syncedAt }

    case 'harnessConfig/resourceUpserted': {
      const resource = event.payload
      const current = state.resources[resource.resourceType]
      const index = current.findIndex(
        (entry) => entry.agentKind === resource.agentKind && entry.id === resource.id
      )

      if (index !== -1) {
        if (current[index] === resource) return state
        return {
          ...state,
          resources: {
            ...state.resources,
            [resource.resourceType]: [
              ...current.slice(0, index),
              resource,
              ...current.slice(index + 1)
            ]
          }
        }
      }

      const insertionIndex = current.findIndex(
        (entry) => compareResources(resource, entry) < 0
      )
      const next =
        insertionIndex === -1
          ? [...current, resource]
          : [
              ...current.slice(0, insertionIndex),
              resource,
              ...current.slice(insertionIndex)
            ]
      return {
        ...state,
        resources: { ...state.resources, [resource.resourceType]: next }
      }
    }

    case 'harnessConfig/resourceDeleted': {
      const { agentKind, resourceType, id } = event.payload
      const current = state.resources[resourceType]
      const index = current.findIndex(
        (resource) => resource.agentKind === agentKind && resource.id === id
      )
      if (index === -1) return state
      return {
        ...state,
        resources: {
          ...state.resources,
          [resourceType]: [...current.slice(0, index), ...current.slice(index + 1)]
        }
      }
    }

    case 'harnessConfig/errorChanged':
      if (state.error === event.payload) return state
      return { ...state, error: event.payload }

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
