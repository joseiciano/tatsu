import { describe, expect, it } from 'vitest'
import { deriveConfigConversionOutcome } from './config-conversion'
import type { HarnessConfigConversionResult, HarnessConfigFileRef } from '../../../shared/state/harness-config'

function ref(overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: 'ref:claude:skills:one',
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: ['commands'],
    label: 'One',
    relativePath: 'one/SKILL.md',
    absolutePath: '/workspace/.claude/skills/one/SKILL.md',
    hash: 'a1b2c3d4e5f60708090a0b0c0d0e0f10',
    existsOnDisk: true,
    managed: true,
    updatedAt: 1_700_000_000_000,
    ...overrides
  }
}

describe('deriveConfigConversionOutcome', () => {
  it('reports an alias result as an already-available notice naming the destination noun', () => {
    const result: HarnessConfigConversionResult = { status: 'alias', ref: ref() }
    const outcome = deriveConfigConversionOutcome(result, 'command')
    expect(outcome).toEqual({
      kind: 'already-available',
      message: 'Already available as a command at one/SKILL.md',
      relativePath: 'one/SKILL.md'
    })
  })

  it('reports an existing result as an already-available notice naming the destination noun', () => {
    const result: HarnessConfigConversionResult = {
      status: 'existing',
      ref: ref({ resourceType: 'skills', relativePath: 'deploy/SKILL.md' })
    }
    const outcome = deriveConfigConversionOutcome(result, 'skill')
    expect(outcome).toEqual({
      kind: 'already-available',
      message: 'Already available as a skill at deploy/SKILL.md',
      relativePath: 'deploy/SKILL.md'
    })
  })

  it('maps a draft result to render-ready create-mode fields and parses the source-metadata comment', () => {
    const content =
      '---\ndescription: Run the my-skill skill\n---\n\nUse the my-skill skill.\n\n<!-- Converted by Tatsu from codex skills my-skill/SKILL.md -->\n'
    const result: HarnessConfigConversionResult = {
      status: 'draft',
      agentKind: 'codex',
      resourceType: 'commands',
      name: 'my-skill',
      relativePath: 'my-skill.md',
      label: 'my-skill',
      content
    }
    const outcome = deriveConfigConversionOutcome(result, 'command')
    expect(outcome).toEqual({
      kind: 'draft',
      scope: { agentKind: 'codex', resourceType: 'commands' },
      name: 'my-skill',
      content,
      source: { agentKind: 'codex', sourceResourceType: 'skills', relativePath: 'my-skill/SKILL.md' }
    })
  })

  it('falls back to a scope-derived source when the content has no parseable comment', () => {
    const result: HarnessConfigConversionResult = {
      status: 'draft',
      agentKind: 'opencode',
      resourceType: 'skills',
      name: 'deploy-now',
      relativePath: 'deploy-now/SKILL.md',
      label: 'deploy-now',
      content: '# deploy-now\n\nno trailing comment here\n'
    }
    const outcome = deriveConfigConversionOutcome(result, 'skill')
    expect(outcome.kind).toBe('draft')
    if (outcome.kind !== 'draft') throw new Error('expected draft')
    expect(outcome.source).toEqual({ agentKind: 'opencode', sourceResourceType: 'commands', relativePath: '' })
  })
})
