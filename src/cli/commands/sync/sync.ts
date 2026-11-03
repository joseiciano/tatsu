import type {
  HarnessConfigChangedRef,
  HarnessConfigComparison,
  HarnessConfigScope,
  HarnessConfigSyncPlan
} from '../../../shared/state/harness-config'
import { CliError } from '../../errors'
import { enumerateScopes, hcRequest, scopeFiltersFrom, scopeLabel, scopeOptions } from '../../harness-config'
import { formatTable } from '../../output'
import type { Command, CommandContext } from '..'

const COMPARE = 'harnessConfig:compare'
const PLAN = 'harnessConfig:planSyncToDisk'

export type PlanClass = { kind: 'in-sync' } | { kind: 'issues-only'; issues: number } | { kind: 'writes'; issues: number }

type ReviewFields = Pick<HarnessConfigComparison, 'renderErrors' | 'fragmentErrors' | 'fragmentEdits'>

function issueCount({ renderErrors = [], fragmentErrors = [], fragmentEdits = [] }: ReviewFields): number {
  return renderErrors.length + fragmentErrors.length + fragmentEdits.length
}

export function classifyPlan(plan: HarnessConfigSyncPlan): PlanClass {
  const issues = issueCount(plan)
  if (plan.configOnly.length + plan.changed.length + (plan.detach?.length ?? 0) > 0) return { kind: 'writes', issues }
  return issues > 0 ? { kind: 'issues-only', issues } : { kind: 'in-sync' }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

function notes({ renderErrors = [], fragmentErrors = [], fragmentEdits = [] }: ReviewFields): string {
  return [
    renderErrors.length ? plural(renderErrors.length, 'render error') : '',
    fragmentErrors.length ? plural(fragmentErrors.length, 'fragment error') : '',
    fragmentEdits.length ? plural(fragmentEdits.length, 'fragment edit') : ''
  ]
    .filter(Boolean)
    .join(', ')
}

export function renderStatus(comparisons: readonly HarnessConfigComparison[]): string {
  const rows = comparisons.map((c) => [scopeLabel(c.scope), c.status, String(c.configOnly.length), String(c.changed.length), notes(c)])
  return formatTable([['SCOPE', 'STATUS', 'NOT ON DISK', 'CHANGED', 'NOTES'], ...rows])
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
}

function indented(lines: readonly string[]): string {
  return lines.map((line) => `  ${line}`.trimEnd()).join('\n')
}

function changedRow({ config }: HarnessConfigChangedRef): string[] {
  return config.source === 'template' ? [config.relativePath, `[template ${config.templateRef ?? '?'}]`, config.id] : [config.relativePath]
}

function issueSections({ renderErrors = [], fragmentErrors = [], fragmentEdits = [] }: ReviewFields): string[] {
  return [
    renderErrors.length ? `Render errors:\n${indented(renderErrors.map((e) => `${e.templateRef}: ${e.message}`))}` : '',
    fragmentErrors.length ? `Fragment errors:\n${indented(fragmentErrors.map((e) => `${e.relativePath}: ${e.message}`))}` : '',
    fragmentEdits.length
      ? `Fragment edits:\n${indented(fragmentEdits.map((e) => `${e.relativePath}: edited sections ${e.fragments.join(', ')}`))}`
      : ''
  ].filter(Boolean)
}

function applyCommand({ planId, scope }: HarnessConfigSyncPlan): string {
  return `tatsu sync apply --agent ${scope.agentKind} --type ${scope.resourceType} --plan ${planId} --yes`
}

export function renderPlan(plan: HarnessConfigSyncPlan): string {
  const header = `Plan ${plan.planId} · ${scopeLabel(plan.scope)}`
  const verdict = classifyPlan(plan)
  switch (verdict.kind) {
    case 'in-sync':
      return [header, 'Already in sync.'].join('\n\n')
    case 'issues-only':
      return [header, ...issueSections(plan), `Nothing to write; ${verdict.issues === 1 ? '1 issue needs' : `${verdict.issues} issues need`} attention.`].join(
        '\n\n'
      )
    case 'writes': {
      const detached = new Set(plan.detach ?? [])
      const overwritten = plan.changed.filter((pair) => !detached.has(pair.config.id))
      return [
        header,
        plan.configOnly.length ? `Not on disk:\n${indented(plan.configOnly.map((ref) => ref.relativePath))}` : '',
        overwritten.length ? `Content changed:\n${indented(formatTable(overwritten.map(changedRow)).split('\n'))}` : '',
        plan.detach?.length ? `Detach:\n${indented(plan.detach)}` : '',
        ...issueSections(plan),
        `Apply with: ${applyCommand(plan)}`
      ]
        .filter(Boolean)
        .join('\n\n')
    }
    default: {
      const _exhaustive: never = verdict
      return _exhaustive
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isComparison(value: unknown): value is HarnessConfigComparison {
  return isRecord(value) && typeof value.status === 'string' && Array.isArray(value.configOnly) && Array.isArray(value.changed)
}

function isSyncPlan(value: unknown): value is HarnessConfigSyncPlan {
  return isComparison(value) && 'planId' in value && typeof value.planId === 'string'
}

function rejectPositionals(ctx: CommandContext, name: string): void {
  if (ctx.positionals.length > 0) {
    throw new CliError('usage', `unexpected argument '${ctx.positionals[0]}'. Run 'tatsu ${name} --help' for usage.`)
  }
}

export const syncStatusCommand: Command = {
  name: 'sync status',
  summary: 'Show which harness scopes differ from what templates and fragments build',
  usage: 'sync status [--agent <kind>] [--type <type>] [--check]',
  options: {
    ...scopeOptions,
    check: { type: 'boolean', description: 'Exit 1 when any scope is not synced' }
  },
  async run(ctx) {
    rejectPositionals(ctx, 'sync status')
    const scopes = enumerateScopes(scopeFiltersFrom(ctx.values))
    const client = await ctx.client()
    const comparisons: HarnessConfigComparison[] = []
    for (const scope of scopes) {
      const value = await hcRequest(client, COMPARE, { scope })
      if (!isComparison(value)) throw new CliError('request-failed', `backend sent a malformed reply to '${COMPARE}'`)
      comparisons.push(value)
    }
    const drifted = comparisons.filter((c) => c.status !== 'synced').length
    const check = ctx.values.check === true
    ctx.output.result(comparisons, renderStatus, { keepOnError: check })
    if (check && drifted > 0) throw new CliError('command-failed', `${plural(drifted, 'scope')} out of sync`)
  }
}

function detachIds(values: CommandContext['values']): string[] {
  const raw = values.detach
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

function singleScope(values: CommandContext['values'], name: string): HarnessConfigScope {
  const filters = scopeFiltersFrom(values)
  if (filters.agent === undefined || filters.type === undefined) {
    throw new CliError('usage', `${name} needs both --agent and --type. Run 'tatsu ${name} --help' for usage.`)
  }
  const [scope] = enumerateScopes(filters)
  return scope
}

export const syncPlanCommand: Command = {
  name: 'sync plan',
  summary: 'Show exactly what a sync would write for one harness scope',
  usage: 'sync plan --agent <kind> --type <type> [--detach <id>...]',
  options: {
    ...scopeOptions,
    detach: { type: 'string', multiple: true, valueName: 'id', description: 'Keep this template-built file as it is on disk and detach it (repeatable)' }
  },
  async run(ctx) {
    rejectPositionals(ctx, 'sync plan')
    const scope = singleScope(ctx.values, 'sync plan')
    const detach = detachIds(ctx.values)
    const client = await ctx.client()
    const value =
      detach.length > 0 ? await hcRequest(client, PLAN, { scope, detach }, { detach: true }) : await hcRequest(client, PLAN, { scope })
    if (!isSyncPlan(value)) throw new CliError('request-failed', `backend sent a malformed reply to '${PLAN}'`)
    ctx.output.result(value, renderPlan)
  }
}
