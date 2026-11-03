import type { HarnessConfigFileRef, HarnessConfigScope } from '../../../shared/state/harness-config'
import { CliError } from '../../errors'
import { enumerateScopes, hcRequest, scopeFiltersFrom, scopeLabel, scopeOptions } from '../../harness-config'
import { formatTable } from '../../output'
import type { Command } from '..'

const CHANNEL = 'harnessConfig:scan'

export interface ScopeResources {
  scope: HarnessConfigScope
  resources: HarnessConfigFileRef[]
}

function hasResources(value: unknown): value is { resources: HarnessConfigFileRef[] } {
  return typeof value === 'object' && value !== null && 'resources' in value && Array.isArray(value.resources)
}

function flags(ref: HarnessConfigFileRef): string {
  return [ref.templateRef !== undefined ? 'template' : '', ref.linkedFrom !== undefined ? 'linked' : ''].filter(Boolean).join(', ')
}

function renderScope({ scope, resources }: ScopeResources): string {
  const rows =
    resources.length === 0
      ? '  (none)'
      : formatTable(resources.map((ref) => [ref.label, ref.relativePath, flags(ref)]))
          .split('\n')
          .map((line) => `  ${line}`.trimEnd())
          .join('\n')
  return `${scopeLabel(scope)}\n${rows}`
}

export function renderConfigLs(listing: readonly ScopeResources[]): string {
  return listing.map(renderScope).join('\n\n')
}

export const configLsCommand: Command = {
  name: 'config ls',
  summary: 'List the agents, skills and commands Tatsu sees per harness',
  usage: 'config ls [--agent <kind>] [--type <type>]',
  options: scopeOptions,
  async run(ctx) {
    if (ctx.positionals.length > 0) {
      throw new CliError('usage', `unexpected argument '${ctx.positionals[0]}'. Run 'tatsu config ls --help' for usage.`)
    }
    const scopes = enumerateScopes(scopeFiltersFrom(ctx.values))
    const client = await ctx.client()
    const listing: ScopeResources[] = []
    for (const scope of scopes) {
      const value = await hcRequest(client, CHANNEL, { scope })
      if (!hasResources(value)) throw new CliError('request-failed', `backend sent a malformed reply to '${CHANNEL}'`)
      listing.push({ scope, resources: value.resources })
    }
    ctx.output.result(listing, renderConfigLs)
  }
}
