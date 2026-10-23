import type {
  HarnessConfigEvent,
  HarnessConfigFileRef,
  HarnessConfigRootKey,
  HarnessConfigScope,
  HarnessConfigScopeKey,
  HarnessConfigState,
  HarnessFragment,
  HarnessTemplate,
  HarnessTemplateKind,
  HarnessTemplateParseError,
  HarnessTemplateSourceState,
  ManagedHarnessKind
} from './types'

const HARNESS_ORDER: Record<ManagedHarnessKind, number> = {
  claude: 0,
  codex: 1,
  opencode: 2
}

export const HARNESS_CONFIG_ROOT_KEYS: readonly HarnessConfigRootKey[] = [
  'claudeAgents',
  'claudeSkills',
  'claudeCommands',
  'codexHome',
  'codexSkills',
  'opencodeAgents',
  'opencodeSkills',
  'opencodeCommands'
]

export function isHarnessConfigRootKey(value: unknown): value is HarnessConfigRootKey {
  return typeof value === 'string' && (HARNESS_CONFIG_ROOT_KEYS as readonly string[]).includes(value)
}

export const HARNESS_TEMPLATE_KINDS: readonly HarnessTemplateKind[] = ['agent', 'skill', 'command']

export const HARNESS_FRAGMENTS_DIR = 'fragments'

export const initialHarnessTemplateSource: HarnessTemplateSourceState = {
  templates: [],
  fragments: [],
  errors: [],
  loadedAt: null
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
  lastSyncedAt: null,
  templates: initialHarnessTemplateSource,
  templateSyncNotice: null
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

const TEMPLATE_KIND_ORDER: Record<HarnessTemplateKind, number> = { agent: 0, skill: 1, command: 2 }

export function compareHarnessTemplates(left: HarnessTemplate, right: HarnessTemplate): number {
  return TEMPLATE_KIND_ORDER[left.kind] - TEMPLATE_KIND_ORDER[right.kind] || compareText(left.name, right.name)
}

export function compareHarnessFragments(left: HarnessFragment, right: HarnessFragment): number {
  return compareText(left.name, right.name)
}

export function isFragmentSourcePath(relativePath: string): boolean {
  return relativePath.startsWith(`${HARNESS_FRAGMENTS_DIR}/`)
}

function compareErrors(left: HarnessTemplateParseError, right: HarnessTemplateParseError): number {
  return compareText(left.relativePath, right.relativePath)
}

function upsertSorted<T>(
  list: T[],
  item: T,
  same: (entry: T) => boolean,
  compare: (left: T, right: T) => number
): T[] {
  const index = list.findIndex(same)
  if (index !== -1) {
    if (list[index] === item) return list
    return [...list.slice(0, index), item, ...list.slice(index + 1)]
  }
  const insertionIndex = list.findIndex((entry) => compare(item, entry) < 0)
  return insertionIndex === -1
    ? [...list, item]
    : [...list.slice(0, insertionIndex), item, ...list.slice(insertionIndex)]
}

function removeWhere<T>(list: T[], match: (entry: T) => boolean): T[] {
  const index = list.findIndex(match)
  if (index === -1) return list
  return [...list.slice(0, index), ...list.slice(index + 1)]
}

function replaceErrors(
  current: HarnessTemplateParseError[],
  keep: (error: HarnessTemplateParseError) => boolean,
  incoming: HarnessTemplateParseError[]
): HarnessTemplateParseError[] {
  const next = [...current.filter(keep), ...incoming].sort(compareErrors)
  if (next.length === current.length && next.every((error, index) => error === current[index])) return current
  return next
}

function withTemplateSource(
  state: HarnessConfigState,
  patch: Partial<HarnessTemplateSourceState>
): HarnessConfigState {
  const current = state.templates
  const next = { ...current, ...patch }
  if (
    next.templates === current.templates &&
    next.fragments === current.fragments &&
    next.errors === current.errors &&
    next.loadedAt === current.loadedAt
  ) {
    return state
  }
  return { ...state, templates: next }
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

    case 'harnessConfig/templatesLoaded': {
      const { templates, errors, loadedAt } = event.payload
      return withTemplateSource(state, {
        templates: [...templates].sort(compareHarnessTemplates),
        errors: replaceErrors(state.templates.errors, (error) => isFragmentSourcePath(error.relativePath), errors),
        loadedAt
      })
    }

    case 'harnessConfig/templateChanged': {
      const template = event.payload
      return withTemplateSource(state, {
        templates: upsertSorted(
          state.templates.templates,
          template,
          (entry) => entry.kind === template.kind && entry.name === template.name,
          compareHarnessTemplates
        ),
        errors: removeWhere(state.templates.errors, (error) => error.relativePath === template.relativePath)
      })
    }

    case 'harnessConfig/templateRemoved': {
      const { kind, name } = event.payload
      return withTemplateSource(state, {
        templates: removeWhere(state.templates.templates, (entry) => entry.kind === kind && entry.name === name)
      })
    }

    case 'harnessConfig/fragmentsLoaded': {
      const { fragments, errors, loadedAt } = event.payload
      return withTemplateSource(state, {
        fragments: [...fragments].sort(compareHarnessFragments),
        errors: replaceErrors(state.templates.errors, (error) => !isFragmentSourcePath(error.relativePath), errors),
        loadedAt
      })
    }

    case 'harnessConfig/fragmentChanged': {
      const fragment = event.payload
      return withTemplateSource(state, {
        fragments: upsertSorted(
          state.templates.fragments,
          fragment,
          (entry) => entry.name === fragment.name,
          compareHarnessFragments
        ),
        errors: removeWhere(state.templates.errors, (error) => error.relativePath === fragment.relativePath)
      })
    }

    case 'harnessConfig/fragmentRemoved': {
      const { name } = event.payload
      return withTemplateSource(state, {
        fragments: removeWhere(state.templates.fragments, (entry) => entry.name === name)
      })
    }

    case 'harnessConfig/templateSourceErrorChanged': {
      const { relativePath, message } = event.payload
      const current = state.templates.errors
      const index = current.findIndex((error) => error.relativePath === relativePath)
      if (message === null) {
        return withTemplateSource(state, { errors: removeWhere(current, (error) => error.relativePath === relativePath) })
      }
      if (index !== -1 && current[index].message === message) return state
      return withTemplateSource(state, {
        errors: upsertSorted(current, { relativePath, message }, (error) => error.relativePath === relativePath, compareErrors)
      })
    }

    case 'harnessConfig/templateSyncNoticeChanged': {
      const next = event.payload
      const current = state.templateSyncNotice
      if (current === next) return state
      if (
        current &&
        next &&
        current.changedAt === next.changedAt &&
        current.scopes.length === next.scopes.length &&
        current.scopes.every((key, index) => key === next.scopes[index])
      ) {
        return state
      }
      return { ...state, templateSyncNotice: next === null ? null : { scopes: [...next.scopes], changedAt: next.changedAt } }
    }

    default: {
      const _exhaustive: never = event
      void _exhaustive
      return state
    }
  }
}
