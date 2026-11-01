import { createHash } from 'crypto'
import { CORE_SCHEMA, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

import {
  RENDERER_VERSION,
  renderTemplates,
  stripLegacyTemplateMarker,
  type RenderableFragment,
  type RenderableTemplate,
  type RenderedResource
} from '.'

const fragments: RenderableFragment[] = [
  { name: 'style', content: 'Prefer small diffs.\n' },
  { name: 'safety', content: 'Never push to main.\r\n\r\n' }
]

function template(overrides: Partial<RenderableTemplate>): RenderableTemplate {
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

const agent = template({
  kind: 'agent',
  name: 'reviewer',
  fragments: ['style', 'safety'],
  harnesses: {
    claude: { frontmatter: { tools: 'Read, Grep', model: 'sonnet' } },
    opencode: { frontmatter: { mode: 'subagent', description: 'Reviews code for Opencode' }, fragments: ['style'] },
    codex: false
  }
})

const skill = template({
  kind: 'skill',
  name: 'deploy',
  description: 'Deploys the app',
  fragments: ['safety'],
  body: '\nRun the deploy script.\n',
  harnesses: {
    claude: { frontmatter: { 'allowed-tools': ['Bash'] } },
    codex: { frontmatter: {} },
    opencode: { name: 'ship', frontmatter: { license: 'MIT' } }
  },
  references: [
    { fileName: 'checklist.md', content: '- Tag the release\n' },
    { fileName: 'rollback.md', content: 'Revert the tag.\n' }
  ]
})

const command = template({
  kind: 'command',
  name: 'fix-ci',
  description: 'Fix failing CI',
  body: 'Find failing checks and fix them.',
  harnesses: {
    claude: { frontmatter: { 'argument-hint': '[pr]' } },
    opencode: { frontmatter: { agent: 'build' } }
  }
})

function byTarget(resources: RenderedResource[]): Record<string, RenderedResource> {
  return Object.fromEntries(resources.map((resource) => [`${resource.agentKind}:${resource.resourceType}`, resource]))
}

function nodeSha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex')
}

describe('renderTemplates golden output', () => {
  it('renders an agent for each targeted harness', () => {
    const { resources, errors } = renderTemplates([agent], fragments)
    expect(errors).toEqual([])
    const out = byTarget(resources)
    expect(Object.keys(out)).toEqual(['claude:agents', 'opencode:agents'])

    expect(out['claude:agents']).toMatchObject({ templateName: 'reviewer', templateKind: 'agent', relativePath: 'reviewer.md' })
    expect(out['claude:agents'].content).toBe(
      [
        '---',
        'name: reviewer',
        'description: Reviews code',
        'tools: Read, Grep',
        'model: sonnet',
        '---',
        'Review the diff.',
        '',
        'Prefer small diffs.',
        '',
        'Never push to main.',
        ''
      ].join('\n')
    )

    expect(out['opencode:agents'].relativePath).toBe('reviewer.md')
    expect(out['opencode:agents'].content).toBe(
      [
        '---',
        'description: Reviews code for Opencode',
        'mode: subagent',
        '---',
        'Review the diff.',
        '',
        'Prefer small diffs.',
        ''
      ].join('\n')
    )
  })

  it('names path-named Opencode agents by file only, even with a block name override', () => {
    const renamed = template({ name: 'reviewer', harnesses: { opencode: { name: 'critic', frontmatter: {} } } })
    const { resources, errors } = renderTemplates([renamed], fragments)
    expect(errors).toEqual([])
    expect(resources[0].relativePath).toBe('critic.md')
    expect(resources[0].content).toBe(
      ['---', 'description: Reviews code', '---', 'Review the diff.', ''].join('\n')
    )
  })

  it('renders a skill with inlined references, including a block name override', () => {
    const { resources, errors } = renderTemplates([skill], fragments)
    expect(errors).toEqual([])
    const out = byTarget(resources)
    expect(Object.keys(out)).toEqual(['claude:skills', 'codex:skills', 'opencode:skills'])

    const body = [
      'Run the deploy script.',
      '',
      'Never push to main.',
      '',
      '## checklist.md',
      '',
      '- Tag the release',
      '',
      '## rollback.md',
      '',
      'Revert the tag.',
      ''
    ]
    expect(out['claude:skills'].relativePath).toBe('deploy/SKILL.md')
    expect(out['claude:skills'].content).toBe(
      [
        '---',
        'name: deploy',
        'description: Deploys the app',
        'allowed-tools:',
        '  - Bash',
        '---',
        ...body
      ].join('\n')
    )
    expect(out['codex:skills'].relativePath).toBe('deploy/SKILL.md')
    expect(out['codex:skills'].content).toBe(
      ['---', 'name: deploy', 'description: Deploys the app', '---', ...body].join('\n')
    )
    expect(out['opencode:skills'].relativePath).toBe('ship/SKILL.md')
    expect(out['opencode:skills'].content).toBe(
      [
        '---',
        'name: ship',
        'description: Deploys the app',
        'license: MIT',
        '---',
        ...body
      ].join('\n')
    )
  })

  it('renders a command for Claude and Opencode only', () => {
    const { resources, errors } = renderTemplates([command], fragments)
    expect(errors).toEqual([])
    const out = byTarget(resources)
    expect(Object.keys(out)).toEqual(['claude:commands', 'opencode:commands'])
    expect(out['claude:commands']).toMatchObject({ relativePath: 'fix-ci.md' })
    expect(out['claude:commands'].content).toBe(
      [
        '---',
        'name: fix-ci',
        'description: Fix failing CI',
        'argument-hint: \'[pr]\'',
        '---',
        'Find failing checks and fix them.',
        ''
      ].join('\n')
    )
    expect(out['opencode:commands'].content).toBe(
      [
        '---',
        'description: Fix failing CI',
        'agent: build',
        '---',
        'Find failing checks and fix them.',
        ''
      ].join('\n')
    )
  })

  it('hashes content as bare sha256 hex matching the disk scanner', () => {
    const { resources } = renderTemplates([agent, skill, command], fragments)
    for (const resource of resources) expect(resource.hash).toBe(nodeSha256(resource.content))
  })

  it('renders nothing for a template with no targets', () => {
    expect(renderTemplates([template({ harnesses: {} })], fragments)).toEqual({
      rendererVersion: RENDERER_VERSION,
      resources: [],
      errors: []
    })
  })
})

describe('renderTemplates determinism', () => {
  it('gives byte-identical output across runs and input orders', () => {
    const first = renderTemplates([agent, skill, command], fragments)
    const second = renderTemplates([command, skill, agent], [...fragments].reverse())
    expect(second).toEqual(first)
    expect(JSON.stringify(renderTemplates([agent, skill, command], fragments))).toBe(JSON.stringify(first))
  })

  it('normalizes CRLF so platform line endings do not change bytes', () => {
    const crlf = template({ body: 'Line one\r\nLine two\r\n', harnesses: { claude: { frontmatter: {} } } })
    const lf = template({ body: 'Line one\nLine two\n', harnesses: { claude: { frontmatter: {} } } })
    expect(renderTemplates([crlf], []).resources[0].hash).toBe(renderTemplates([lf], []).resources[0].hash)
  })
})

describe('renderTemplates errors', () => {
  const healthy = template({ kind: 'command', name: 'healthy', harnesses: { claude: { frontmatter: {} } } })

  it('reports an unknown fragment on its template and still renders others', () => {
    const broken = template({ name: 'broken', fragments: ['missing'], harnesses: { claude: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([broken, healthy], fragments)
    expect(errors).toEqual([
      expect.objectContaining({ templateKind: 'agent', templateName: 'broken', agentKind: 'claude', code: 'unknown-fragment' })
    ])
    expect(errors[0].message).toContain('missing')
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })

  it('drops every harness output of a template when one harness fails', () => {
    const partial = template({
      name: 'partial',
      harnesses: { claude: { frontmatter: {} }, opencode: { frontmatter: {}, fragments: ['missing'] } }
    })
    const { resources, errors } = renderTemplates([partial], fragments)
    expect(resources).toEqual([])
    expect(errors).toEqual([expect.objectContaining({ templateName: 'partial', agentKind: 'opencode', code: 'unknown-fragment' })])
  })

  it('reports an invalid target on its template', () => {
    const codexAgent = template({ name: 'codex-agent', harnesses: { codex: { frontmatter: {} } } })
    const codexCommand = template({ kind: 'command', name: 'codex-command', harnesses: { codex: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([codexAgent, codexCommand, healthy], fragments)
    expect(errors.map(({ templateName, agentKind, code }) => ({ templateName, agentKind, code }))).toEqual([
      { templateName: 'codex-agent', agentKind: 'codex', code: 'invalid-target' },
      { templateName: 'codex-command', agentKind: 'codex', code: 'invalid-target' }
    ])
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })

  it('reports a duplicate output path on both templates', () => {
    const first = template({ kind: 'command', name: 'alpha', harnesses: { claude: { name: 'shared', frontmatter: {} } } })
    const second = template({ kind: 'command', name: 'shared', harnesses: { claude: { frontmatter: {} }, opencode: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([first, second, healthy], fragments)
    expect(errors.map(({ templateName, agentKind, code }) => ({ templateName, agentKind, code }))).toEqual([
      { templateName: 'alpha', agentKind: 'claude', code: 'duplicate-output' },
      { templateName: 'shared', agentKind: 'claude', code: 'duplicate-output' }
    ])
    expect(errors[0].message).toContain('command/shared')
    expect(errors[1].message).toContain('command/alpha')
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })

  it('reports output paths that differ only by case as duplicates', () => {
    const upper = template({ kind: 'command', name: 'x', harnesses: { claude: { name: 'Foo', frontmatter: {} } } })
    const lower = template({ kind: 'command', name: 'foo', harnesses: { claude: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([upper, lower], fragments)
    expect(errors.map(({ templateName, code }) => ({ templateName, code }))).toEqual([
      { templateName: 'foo', code: 'duplicate-output' },
      { templateName: 'x', code: 'duplicate-output' }
    ])
    expect(resources).toEqual([])
  })

  it('writes an empty frontmatter block without a YAML map literal', () => {
    const bare = template({ kind: 'command', name: 'bare', description: '', harnesses: { opencode: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([bare], fragments)
    expect(errors).toEqual([])
    expect(resources[0].content).toBe('---\n---\nReview the diff.\n')
  })

  it('does not treat the same name in different harnesses or resource types as a duplicate', () => {
    const agentShared = template({ name: 'same', harnesses: { claude: { frontmatter: {} } } })
    const commandShared = template({ kind: 'command', name: 'same', harnesses: { claude: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([agentShared, commandShared], fragments)
    expect(errors).toEqual([])
    expect(resources).toHaveLength(2)
  })

  it('reports frontmatter that does not serialize', () => {
    const bad = template({ name: 'bad', harnesses: { claude: { frontmatter: { hook: () => undefined } } } })
    const { resources, errors } = renderTemplates([bad, healthy], fragments)
    expect(errors.map(({ templateName, code }) => ({ templateName, code }))).toEqual([
      { templateName: 'bad', code: 'invalid-frontmatter' }
    ])
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })
})

describe('renderTemplates inline fragment placeholders', () => {
  const styleRegion = [
    `<!-- tatsu:fragment style sha=${nodeSha256('Prefer small diffs.').slice(0, 12)} -->`,
    'Prefer small diffs.',
    '<!-- /tatsu:fragment style -->'
  ]

  it('expands a body placeholder in place and still appends list fragments after the body', () => {
    const inline = template({
      fragments: ['safety'],
      body: 'Intro.\n\n{{fragment:style}}\n\nOutro.\n',
      harnesses: { claude: { frontmatter: {} } }
    })
    const { resources, errors } = renderTemplates([inline], fragments)
    expect(errors).toEqual([])
    expect(resources[0].content).toBe(
      [
        '---',
        'name: reviewer',
        'description: Reviews code',
        '---',
        'Intro.',
        '',
        ...styleRegion,
        '',
        'Outro.',
        '',
        'Never push to main.',
        ''
      ].join('\n')
    )
  })

  it('expands body placeholders for a harness whose block overrides the fragment list', () => {
    const inline = template({
      fragments: ['safety'],
      body: '{{fragment:style}}\n',
      harnesses: { claude: { frontmatter: {} }, opencode: { frontmatter: {}, fragments: [] } }
    })
    const { resources, errors } = renderTemplates([inline], fragments)
    expect(errors).toEqual([])
    const out = byTarget(resources)
    expect(out['opencode:agents'].content).toBe(
      ['---', 'description: Reviews code', '---', ...styleRegion, ''].join('\n')
    )
    expect(out['claude:agents'].content).toContain([...styleRegion, '', 'Never push to main.', ''].join('\n'))
  })

  it.each([
    { name: 'an unknown placeholder', body: 'Intro.\n{{fragment:missing}}\n', code: 'unknown-fragment', mentions: 'missing' },
    { name: 'a placeholder inside a line', body: 'See {{fragment:style}} here.\n', code: 'inline-fragment', mentions: 'line 1' },
    {
      name: 'an unknown placeholder alongside a misplaced one',
      body: '{{fragment:missing}}\nSee {{fragment:style}} here.\n',
      code: 'inline-fragment',
      mentions: 'missing'
    }
  ])('reports $name as $code, renders nothing for that template, and still renders others', ({ body, code, mentions }) => {
    const broken = template({ name: 'broken', body, harnesses: { claude: { frontmatter: {} } } })
    const healthy = template({ kind: 'command', name: 'healthy', harnesses: { claude: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([broken, healthy], fragments)
    expect(errors).toEqual([expect.objectContaining({ templateName: 'broken', agentKind: 'claude', code })])
    expect(errors[0].message).toContain(mentions)
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })

  it('leaves placeholders in the description and frontmatter as literal text', () => {
    const literal = template({
      description: '{{fragment:style}}',
      body: 'Plain body.\n',
      harnesses: { claude: { frontmatter: { note: '{{fragment:safety}}' } } }
    })
    const { resources, errors } = renderTemplates([literal], fragments)
    expect(errors).toEqual([])
    const content = resources[0].content
    expect(content).not.toContain('tatsu:fragment')
    expect(content).not.toContain('Prefer small diffs.')
    expect(content).not.toContain('Never push to main.')
    const yaml = load(content.split('---\n')[1], { schema: CORE_SCHEMA }) as Record<string, unknown>
    expect(yaml).toMatchObject({ description: '{{fragment:style}}', note: '{{fragment:safety}}' })
  })
})

describe('stripLegacyTemplateMarker', () => {
  it.each([
    { name: 'drops a marker on the first line', body: '<!-- tatsu-template: skill/x -->\nbody\n', expected: 'body\n' },
    { name: 'drops a marker after leading blank lines', body: '\n<!-- tatsu-template: agent/x -->\nbody', expected: '\nbody' },
    { name: 'drops a marker with extra inner spacing', body: '<!--tatsu-template:   command/x   -->\nbody', expected: 'body' },
    { name: 'keeps a marker that is not the first non-empty line', body: 'intro\n<!-- tatsu-template: agent/x -->\n', expected: 'intro\n<!-- tatsu-template: agent/x -->\n' },
    { name: 'keeps an unrelated first-line comment', body: '<!-- keep me -->\nbody', expected: '<!-- keep me -->\nbody' },
    { name: 'keeps a marker comment with no ref', body: '<!-- tatsu-template: -->\nbody', expected: '<!-- tatsu-template: -->\nbody' },
    { name: 'leaves an empty body alone', body: '', expected: '' }
  ])('$name', ({ body, expected }) => {
    expect(stripLegacyTemplateMarker(body)).toBe(expected)
  })
})
