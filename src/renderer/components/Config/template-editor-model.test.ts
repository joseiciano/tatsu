import { describe, expect, it } from 'vitest'
import type { HarnessFragment, HarnessTemplate } from '../../../shared/state/harness-config'
import {
  compileTemplateDraft,
  emptyTemplateDraft,
  fragmentUsage,
  parseHarnessBlockText,
  parseTemplateRef,
  renderTemplatePreview,
  templateDraftsEqual,
  templateHarnessAvailability,
  templateToDraft
} from './template-editor-model'
import type { ConfigTemplateDraft } from './types'

function template(overrides: Partial<HarnessTemplate> = {}): HarnessTemplate {
  return {
    kind: 'skill',
    name: 'deploy',
    description: 'Ship it',
    fragments: [],
    body: 'Deploy steps.',
    harnesses: { claude: { frontmatter: {} } },
    references: [],
    relativePath: 'skills/deploy/TEMPLATE.md',
    hash: 'h1',
    ...overrides
  }
}

function fragment(name: string, content: string): HarnessFragment {
  return { name, content, relativePath: `fragments/${name}.md`, hash: `hash-${name}` }
}

function withHarness(
  draft: ConfigTemplateDraft,
  harness: 'claude' | 'codex' | 'opencode',
  enabled: boolean,
  frontmatterText = ''
): ConfigTemplateDraft {
  return { ...draft, harnesses: { ...draft.harnesses, [harness]: { enabled, excluded: false, frontmatterText } } }
}

describe('templateHarnessAvailability', () => {
  it('marks Codex invalid for agent templates with the capability reason', () => {
    const availability = templateHarnessAvailability('agent')
    expect(availability.claude.valid).toBe(true)
    expect(availability.codex.valid).toBe(false)
    expect(availability.codex.reason).toContain('AGENTS.md')
  })

  it('allows every managed harness that has a per-resource file for skills', () => {
    const availability = templateHarnessAvailability('skill')
    expect(availability.claude.valid).toBe(true)
    expect(availability.opencode.valid).toBe(true)
  })
})

describe('compileTemplateDraft and preview', () => {
  it('previews only the harnesses that are turned on', () => {
    let draft = { ...emptyTemplateDraft('skill'), name: 'deploy', body: 'Body' }
    draft = withHarness(draft, 'claude', true)
    const claudeOnly = renderTemplatePreview(compileTemplateDraft(draft), 'claude', [], [], null)
    expect(claudeOnly.resource?.agentKind).toBe('claude')
    expect(renderTemplatePreview(compileTemplateDraft(draft), 'opencode', [], [], null).resource).toBeNull()

    draft = withHarness(draft, 'opencode', true)
    const opencode = renderTemplatePreview(compileTemplateDraft(draft), 'opencode', [], [], null)
    expect(opencode.resource?.agentKind).toBe('opencode')
    expect(opencode.resource?.content).toContain('Body')
  })

  it('reports an invalid target as a save problem', () => {
    const draft = withHarness({ ...emptyTemplateDraft('agent'), name: 'reviewer' }, 'codex', true)
    const compiled = compileTemplateDraft(draft)
    expect(compiled.saveTemplate).toBeNull()
    expect(compiled.problems.join(' ')).toContain('Codex')
  })

  it('shows invalid YAML inline for its block while other harnesses still render', () => {
    let draft = { ...emptyTemplateDraft('skill'), name: 'deploy' }
    draft = withHarness(draft, 'claude', true, 'model: [unclosed')
    draft = withHarness(draft, 'opencode', true, 'model: x')
    const compiled = compileTemplateDraft(draft)
    expect(compiled.blockErrors.claude).toMatch(/Not valid YAML/)
    expect(compiled.saveTemplate).toBeNull()
    const claude = renderTemplatePreview(compiled, 'claude', [], [], null)
    expect(claude.errors[0]).toMatch(/Claude.*frontmatter/)
    expect(renderTemplatePreview(compiled, 'opencode', [], [], null).resource?.content).toContain('model: x')
  })

  it('returns render errors without blocking the save payload', () => {
    const draft = withHarness({ ...emptyTemplateDraft('skill'), name: 'deploy', fragments: ['missing'] }, 'claude', true)
    const compiled = compileTemplateDraft(draft)
    const preview = renderTemplatePreview(compiled, 'claude', [], [], null)
    expect(preview.resource).toBeNull()
    expect(preview.errors.join(' ')).toContain('Unknown fragment')
    expect(compiled.saveTemplate).not.toBeNull()
  })

  it('appends fragments in order and reports paths built by another template', () => {
    const draft = withHarness(
      { ...emptyTemplateDraft('skill'), name: 'deploy-2', body: 'Body', fragments: ['b', 'a'] },
      'claude',
      true,
      'name: deploy'
    )
    const fragments = [fragment('a', 'Alpha'), fragment('b', 'Beta')]
    const clash = renderTemplatePreview(compileTemplateDraft(draft), 'claude', [template()], fragments, null)
    expect(clash.errors.join(' ')).toContain('also built by skill/deploy')

    const editingOriginal = renderTemplatePreview(compileTemplateDraft(draft), 'claude', [template()], fragments, {
      kind: 'skill',
      name: 'deploy'
    })
    expect(editingOriginal.errors).toEqual([])
    const content = editingOriginal.resource?.content ?? ''
    expect(content.indexOf('Beta')).toBeLessThan(content.indexOf('Alpha'))
  })

  it('round-trips a stored template through a draft without changes', () => {
    const stored = template({
      fragments: ['shared'],
      harnesses: { claude: { name: 'ship', fragments: ['other'], frontmatter: { model: 'opus' } }, codex: false }
    })
    const draft = templateToDraft(stored)
    expect(draft.harnesses.codex).toEqual({ enabled: false, excluded: true, frontmatterText: '' })
    const compiled = compileTemplateDraft(draft)
    expect(compiled.saveTemplate).toEqual({
      kind: stored.kind,
      name: stored.name,
      description: stored.description,
      fragments: stored.fragments,
      body: stored.body,
      harnesses: stored.harnesses,
      references: []
    })
    expect(templateDraftsEqual(draft, templateToDraft(stored))).toBe(true)
  })
})

describe('parseHarnessBlockText', () => {
  it('lifts name and fragments overrides out of the frontmatter', () => {
    const result = parseHarnessBlockText('claude', 'name: ship\nfragments: [a]\nmodel: opus\n')
    expect(result).toEqual({ ok: true, block: { name: 'ship', fragments: ['a'], frontmatter: { model: 'opus' } } })
  })

  it('rejects a non-mapping block', () => {
    expect(parseHarnessBlockText('claude', '- a').ok).toBe(false)
  })
})

describe('fragmentUsage and parseTemplateRef', () => {
  it('finds templates that use a fragment at the top level or in a block override', () => {
    const templates = [
      template({ name: 'a', fragments: ['shared'] }),
      template({ name: 'b', harnesses: { claude: { fragments: ['shared'], frontmatter: {} } } }),
      template({ name: 'c' })
    ]
    expect(fragmentUsage(templates, 'shared').map((entry) => entry.name)).toEqual(['a', 'b'])
  })

  it('parses kind/name refs', () => {
    expect(parseTemplateRef('skill/deploy')).toEqual({ kind: 'skill', name: 'deploy' })
    expect(parseTemplateRef('plugin/x')).toBeNull()
    expect(parseTemplateRef('deploy')).toBeNull()
  })
})
