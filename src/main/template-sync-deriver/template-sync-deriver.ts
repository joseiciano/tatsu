import { formatErr as defaultFormatErr, log as defaultLog } from '../debug'
import type { HarnessConfigService } from '../harness-config'
import type { StateEvent } from '../../shared/state'
import { classifyTemplateSourcePath, TEMPLATE_HARNESSES } from '../../shared/harness-templates'
import {
  harnessConfigScopeKey,
  type HarnessConfigComparison,
  type HarnessConfigEvent,
  type HarnessConfigScope,
  type HarnessConfigScopeKey,
  type HarnessConfigState,
  type HarnessTemplate,
  type HarnessTemplateHarnesses,
  type HarnessTemplateParseError
} from '../../shared/state/harness-config'

type TemplateTargets = Pick<HarnessTemplate, 'kind' | 'harnesses'>

export interface TemplateSyncDeriverStore {
  subscribe(listener: (event: StateEvent) => void): () => void
  getSnapshot(): { state: { harnessConfig: HarnessConfigState } }
  dispatch(event: HarnessConfigEvent): void
}

export interface TemplateSyncDeriverDeps {
  store: TemplateSyncDeriverStore
  service: Pick<HarnessConfigService, 'planSync' | 'scopesForTemplates'>
  schedule?: (run: () => void) => void
  now?: () => number
  log?: (category: string, message: string, data?: unknown) => void
  formatErr?: (error: unknown) => string
}

function templateKey(template: Pick<HarnessTemplate, 'kind' | 'name'>): string {
  return `${template.kind}/${template.name}`
}

function usesFragment(template: HarnessTemplate, name: string): boolean {
  if (template.fragments.includes(name)) return true
  return Object.values(template.harnesses).some((block) => Boolean(block && block.fragments?.includes(name)))
}

function comparisonKey(comparison: HarnessConfigComparison): string {
  const { comparedAt: _comparedAt, ...rest } = comparison
  void _comparedAt
  return JSON.stringify(rest)
}

function sameScopes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index])
}

/** Re-derives the comparison of each scope a template or fragment change
 *  touches (Step 20 TASK-003) and records which of them a save put out of
 *  sync (REQ-005). Work is coalesced onto one later tick so a burst of
 *  slice events costs one rescan per touched scope. */
export class TemplateSyncDeriver {
  private readonly deps: TemplateSyncDeriverDeps
  private readonly targets = new Map<string, TemplateTargets>()
  private readonly lastKnownTargets = new Map<string, TemplateTargets>()
  private readonly pending = new Map<HarnessConfigScopeKey, HarnessConfigScope>()
  private notifyPending = false
  private scheduled = false
  private unsubscribe: (() => void) | null = null

  constructor(deps: TemplateSyncDeriverDeps) {
    this.deps = deps
  }

  start(): void {
    if (this.unsubscribe) return
    for (const template of this.harnessConfig().templates.templates) this.track(template)
    this.unsubscribe = this.deps.store.subscribe((event) => this.onEvent(event))
  }

  stop(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.pending.clear()
    this.notifyPending = false
  }

  private track(template: HarnessTemplate): void {
    const key = templateKey(template)
    this.targets.set(key, template)
    this.lastKnownTargets.set(key, template)
  }

  /** A template file that fails to parse has no readable targets, so the
   *  scopes it last landed in are used, or every harness when it never
   *  parsed in this session. */
  private errorTargets(errors: readonly Pick<HarnessTemplateParseError, 'relativePath'>[]): TemplateTargets[] {
    const result: TemplateTargets[] = []
    for (const { relativePath } of errors) {
      const entry = classifyTemplateSourcePath(relativePath)
      if (!entry || entry.type === 'fragment') continue
      const kind = entry.type === 'reference' ? 'skill' : entry.kind
      const known = this.lastKnownTargets.get(templateKey({ kind, name: entry.name }))
      if (known) {
        result.push(known)
        continue
      }
      const harnesses: HarnessTemplateHarnesses = {}
      for (const harness of TEMPLATE_HARNESSES) harnesses[harness] = { frontmatter: {} }
      result.push({ kind, harnesses })
    }
    return result
  }

  private harnessConfig(): HarnessConfigState {
    return this.deps.store.getSnapshot().state.harnessConfig
  }

  private onEvent(event: StateEvent): void {
    switch (event.type) {
      case 'harnessConfig/templatesLoaded': {
        // The whole template set was replaced, so every scope an old or
        // new template lands in is re-derived.
        const previous = [...this.targets.values()]
        this.targets.clear()
        for (const template of event.payload.templates) this.track(template)
        this.queue([...previous, ...event.payload.templates, ...this.errorTargets(event.payload.errors)], false)
        return
      }
      case 'harnessConfig/templateChanged': {
        const key = templateKey(event.payload)
        const previous = this.targets.get(key)
        this.track(event.payload)
        this.queue(previous ? [previous, event.payload] : [event.payload], true)
        return
      }
      case 'harnessConfig/templateRemoved': {
        const key = templateKey(event.payload)
        const previous = this.targets.get(key)
        this.targets.delete(key)
        if (previous) this.queue([previous], true)
        return
      }
      case 'harnessConfig/templateSourceErrorChanged':
        this.queue(this.errorTargets([event.payload]), true)
        return
      case 'harnessConfig/fragmentsLoaded':
        // Every fragment was replaced, so every template may render differently.
        this.queue(this.harnessConfig().templates.templates, false)
        return
      case 'harnessConfig/fragmentChanged':
      case 'harnessConfig/fragmentRemoved': {
        const name = event.payload.name
        this.queue(
          this.harnessConfig().templates.templates.filter((template) => usesFragment(template, name)),
          true
        )
        return
      }
      default:
        return
    }
  }

  private queue(templates: readonly TemplateTargets[], notify: boolean): void {
    if (templates.length === 0) return
    let scopes: HarnessConfigScope[]
    try {
      scopes = this.deps.service.scopesForTemplates(templates)
    } catch (error) {
      this.logFailure(error)
      return
    }
    for (const scope of scopes) this.pending.set(harnessConfigScopeKey(scope), scope)
    this.notifyPending = this.notifyPending || notify
    if (this.scheduled || this.pending.size === 0) return
    this.scheduled = true
    const schedule = this.deps.schedule ?? ((run: () => void) => void setTimeout(run, 0))
    schedule(() => this.flush())
  }

  flush(): void {
    this.scheduled = false
    if (!this.unsubscribe) return
    const scopes = [...this.pending.entries()]
    const notify = this.notifyPending
    this.pending.clear()
    this.notifyPending = false

    const outOfSync: HarnessConfigScopeKey[] = []
    for (const [key, scope] of scopes) {
      let comparison: HarnessConfigComparison
      try {
        comparison = this.deps.service.planSync(scope)
      } catch (error) {
        this.logFailure(error)
        continue
      }
      const current = this.harnessConfig().comparisons[key]
      if (!current || comparisonKey(current) !== comparisonKey(comparison)) {
        this.deps.store.dispatch({ type: 'harnessConfig/comparisonLoaded', payload: comparison })
      }
      if (comparison.status !== 'synced') outOfSync.push(key)
    }
    if (notify) this.updateNotice(new Set(scopes.map(([key]) => key)), outOfSync)
  }

  private updateNotice(touched: ReadonlySet<HarnessConfigScopeKey>, outOfSync: HarnessConfigScopeKey[]): void {
    const state = this.harnessConfig()
    const previous = state.templateSyncNotice
    const kept = (previous?.scopes ?? []).filter(
      (key) => !touched.has(key) && state.comparisons[key]?.status !== 'synced'
    )
    const scopes = [...new Set([...kept, ...outOfSync])].sort()
    if (scopes.length === 0) {
      if (previous) this.deps.store.dispatch({ type: 'harnessConfig/templateSyncNoticeChanged', payload: null })
      return
    }
    if (previous && outOfSync.length === 0 && sameScopes(previous.scopes, scopes)) return
    const now = this.deps.now ?? Date.now
    this.deps.store.dispatch({
      type: 'harnessConfig/templateSyncNoticeChanged',
      payload: { scopes, changedAt: now() }
    })
  }

  private logFailure(error: unknown): void {
    const log = this.deps.log ?? defaultLog
    const formatErr = this.deps.formatErr ?? defaultFormatErr
    log('harness-config', 'template sync derive failed', formatErr(error))
  }
}

export function createTemplateSyncDeriver(deps: TemplateSyncDeriverDeps): TemplateSyncDeriver {
  return new TemplateSyncDeriver(deps)
}
