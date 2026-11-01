import { describe, expect, it } from 'vitest'
import {
  classifyTemplateSourcePath,
  fragmentRelativePath,
  parseFragmentSource,
  parseTemplateSource,
  referenceRelativePath,
  serializeTemplateSource,
  templateNameError,
  templateRelativePath,
  templateTargets,
  validateTemplateTargets,
  type HarnessTemplateDraft
} from '.'

function draft(overrides: Partial<HarnessTemplateDraft> = {}): HarnessTemplateDraft {
  return {
    kind: 'agent',
    name: 'reviewer',
    description: 'Reviews code',
    fragments: [],
    body: 'Review the diff.\n',
    harnesses: {},
    references: [],
    ...overrides
  }
}

function roundTrip(template: HarnessTemplateDraft): HarnessTemplateDraft {
  const result = parseTemplateSource(template.kind, template.name, serializeTemplateSource(template), template.references)
  if (!result.ok) throw new Error(result.message)
  return result.template
}

describe('template source paths', () => {
  it('lays out every file shape', () => {
    expect(templateRelativePath('agent', 'a')).toBe('agents/a.md')
    expect(templateRelativePath('command', 'c')).toBe('commands/c.md')
    expect(templateRelativePath('skill', 's')).toBe('skills/s/TEMPLATE.md')
    expect(referenceRelativePath('s', 'guide.md')).toBe('skills/s/references/guide.md')
    expect(fragmentRelativePath('style')).toBe('fragments/style.md')
  })

  it('classifies layout paths and ignores backups, temp files, and strays', () => {
    expect(classifyTemplateSourcePath('agents/a.md')).toEqual({ type: 'template', kind: 'agent', name: 'a' })
    expect(classifyTemplateSourcePath('commands/c.md')).toEqual({ type: 'template', kind: 'command', name: 'c' })
    expect(classifyTemplateSourcePath('skills/s/TEMPLATE.md')).toEqual({ type: 'template', kind: 'skill', name: 's' })
    expect(classifyTemplateSourcePath('skills/s/references/g.md')).toEqual({
      type: 'reference',
      name: 's',
      fileName: 'g.md'
    })
    expect(classifyTemplateSourcePath('fragments/f.md')).toEqual({ type: 'fragment', name: 'f' })
    expect(classifyTemplateSourcePath('agents/a.md.x-backup-20261022T101010000Z')).toBeNull()
    expect(classifyTemplateSourcePath('agents/.hidden.md')).toBeNull()
    expect(classifyTemplateSourcePath('agents/nested/a.md')).toBeNull()
    expect(classifyTemplateSourcePath('README.md')).toBeNull()
    expect(classifyTemplateSourcePath('skills/s/notes.md')).toBeNull()
  })
})

describe('templateNameError', () => {
  it('accepts plain names and rejects unsafe ones', () => {
    expect(templateNameError('code-reviewer')).toBeNull()
    for (const bad of ['', '.', '..', '.hidden', 'a/b', 'a\\b', 'a\0b', ' padded', 7]) {
      expect(templateNameError(bad)).not.toBeNull()
    }
  })
})

describe('parseTemplateSource / serializeTemplateSource', () => {
  it('round-trips an agent with harness blocks, overrides, and false blocks', () => {
    const template = draft({
      fragments: ['style', 'testing'],
      harnesses: {
        claude: { name: 'code-reviewer', fragments: ['style'], frontmatter: { model: 'opus', tools: ['Read', 'Grep'] } },
        codex: false,
        opencode: { frontmatter: { mode: 'subagent', permission: { edit: 'deny' } } }
      }
    })
    expect(roundTrip(template)).toEqual(template)
  })

  it('round-trips a command template', () => {
    const template = draft({ kind: 'command', name: 'ship', harnesses: { claude: { frontmatter: {} } } })
    expect(roundTrip(template)).toEqual(template)
  })

  it('round-trips a skill template with reference files', () => {
    const template = draft({
      kind: 'skill',
      name: 'deploy',
      harnesses: { claude: { frontmatter: { 'allowed-tools': 'Bash' } }, opencode: false },
      references: [
        { fileName: 'a-guide.md', content: '# Guide\n' },
        { fileName: 'b-faq.md', content: '# FAQ\n' }
      ]
    })
    expect(roundTrip(template)).toEqual(template)
  })

  it('round-trips a template with no harness blocks and an empty body', () => {
    const template = draft({ body: '', description: '' })
    expect(roundTrip(template)).toEqual(template)
  })

  it('writes the documented frontmatter layout', () => {
    const text = serializeTemplateSource(
      draft({ fragments: ['style'], harnesses: { claude: { frontmatter: { model: 'opus' } }, codex: false } })
    )
    expect(text).toBe(
      [
        '---',
        'name: reviewer',
        'description: Reviews code',
        'fragments:',
        '  - style',
        'claude:',
        '  model: opus',
        'codex: false',
        '---',
        'Review the diff.',
        ''
      ].join('\n')
    )
  })

  it('treats an empty harness key as a block with no settings', () => {
    const result = parseTemplateSource('agent', 'a', '---\nname: a\nclaude:\n---\nBody')
    expect(result).toEqual({
      ok: true,
      template: expect.objectContaining({ harnesses: { claude: { frontmatter: {} } }, body: 'Body' })
    })
  })

  it('keeps YAML dates as text', () => {
    const result = parseTemplateSource('agent', 'a', '---\nclaude:\n  since: 2026-10-22\n---\n')
    expect(result.ok && result.template.harnesses.claude).toEqual({ frontmatter: { since: '2026-10-22' } })
  })

  it.each([
    ['no frontmatter', 'Just a body', /frontmatter block/],
    ['unclosed frontmatter', '---\nname: a\n', /frontmatter block/],
    ['invalid YAML', '---\nname: [a\n---\n', /not valid YAML/],
    ['a non-mapping', '---\n- a\n---\n', /must be a mapping/],
    ['a name mismatch', '---\nname: other\n---\n', /does not match/],
    ['an unknown key', '---\nmodel: opus\n---\n', /Unknown frontmatter key "model"/],
    ['a pi block', '---\npi: {}\n---\n', /Pi templates/],
    ['a true block', '---\nclaude: true\n---\n', /mapping or false/],
    ['a bad fragment list', '---\nfragments: style\n---\n', /list of fragment names/],
    ['an unsafe fragment name', '---\nfragments: [../x]\n---\n', /invalid fragment name/],
    ['a non-text description', '---\ndescription: [x]\n---\n', /description must be text/]
  ])('reports %s as a parse error', (_label, source, pattern) => {
    const result = parseTemplateSource('agent', 'a', source)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(pattern)
  })

  it('rejects reference files on non-skill templates', () => {
    const result = parseTemplateSource('agent', 'a', '---\n---\n', [{ fileName: 'x.md', content: '' }])
    expect(result).toEqual({ ok: false, message: 'Only skill templates can have reference files' })
  })
})

describe('parseFragmentSource', () => {
  it('keeps fragment content verbatim', () => {
    expect(parseFragmentSource('style', '---\nnot frontmatter\n---\n')).toEqual({
      name: 'style',
      content: '---\nnot frontmatter\n---\n',
      relativePath: 'fragments/style.md'
    })
    expect(parseFragmentSource('../x', '')).toEqual({ error: expect.any(String) })
  })
})

describe('template targets', () => {
  it('targets only harnesses with a block that is not false', () => {
    expect(templateTargets({ harnesses: {} })).toEqual([])
    expect(
      templateTargets({ harnesses: { opencode: { frontmatter: {} }, codex: false, claude: { frontmatter: {} } } })
    ).toEqual(['claude', 'opencode'])
  })

  it('rejects an agent template that targets Codex with an explanation', () => {
    const errors = validateTemplateTargets({
      kind: 'agent',
      harnesses: { claude: { frontmatter: {} }, codex: { frontmatter: {} } }
    })
    expect(errors).toHaveLength(1)
    expect(errors[0].agentKind).toBe('codex')
    expect(errors[0].message).toMatch(/AGENTS\.md/)
  })

  it('rejects a command template that targets Codex', () => {
    const errors = validateTemplateTargets({ kind: 'command', harnesses: { codex: { frontmatter: {} } } })
    expect(errors.map((error) => error.agentKind)).toEqual(['codex'])
    expect(errors[0].message).toMatch(/does not support commands/)
  })

  it('accepts supported per-resource targets and ignores false blocks', () => {
    expect(
      validateTemplateTargets({
        kind: 'skill',
        harnesses: { claude: { frontmatter: {} }, codex: { frontmatter: {} }, opencode: { frontmatter: {} } }
      })
    ).toEqual([])
    expect(validateTemplateTargets({ kind: 'agent', harnesses: { codex: false } })).toEqual([])
  })
})
