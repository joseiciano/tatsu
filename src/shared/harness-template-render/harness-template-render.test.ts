import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'

import {
  RENDERER_VERSION,
  readTemplateRef,
  renderTemplates,
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
  it('renders an agent for each targeted harness with each marker form', () => {
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
        'tatsu-template: agent/reviewer',
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
        '<!-- tatsu-template: agent/reviewer -->',
        'Review the diff.',
        '',
        'Prefer small diffs.',
        ''
      ].join('\n')
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
        'tatsu-template: skill/deploy',
        '---',
        ...body
      ].join('\n')
    )
    expect(out['codex:skills'].relativePath).toBe('deploy/SKILL.md')
    expect(out['codex:skills'].content).toBe(
      ['---', 'name: deploy', 'description: Deploys the app', '---', '<!-- tatsu-template: skill/deploy -->', ...body].join('\n')
    )
    expect(out['opencode:skills'].relativePath).toBe('ship/SKILL.md')
    expect(out['opencode:skills'].content).toBe(
      [
        '---',
        'name: ship',
        'description: Deploys the app',
        'license: MIT',
        '---',
        '<!-- tatsu-template: skill/deploy -->',
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
        'tatsu-template: command/fix-ci',
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
        '<!-- tatsu-template: command/fix-ci -->',
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

  it('does not treat the same name in different harnesses or resource types as a duplicate', () => {
    const agentShared = template({ name: 'same', harnesses: { claude: { frontmatter: {} } } })
    const commandShared = template({ kind: 'command', name: 'same', harnesses: { claude: { frontmatter: {} } } })
    const { resources, errors } = renderTemplates([agentShared, commandShared], fragments)
    expect(errors).toEqual([])
    expect(resources).toHaveLength(2)
  })

  it('reports frontmatter that does not serialize', () => {
    const bad = template({ name: 'bad', harnesses: { claude: { frontmatter: { hook: () => undefined } } } })
    const reserved = template({ name: 'reserved', harnesses: { claude: { frontmatter: { 'tatsu-template': 'x' } } } })
    const { resources, errors } = renderTemplates([bad, reserved, healthy], fragments)
    expect(errors.map(({ templateName, code }) => ({ templateName, code }))).toEqual([
      { templateName: 'bad', code: 'invalid-frontmatter' },
      { templateName: 'reserved', code: 'invalid-frontmatter' }
    ])
    expect(resources.map((resource) => resource.templateName)).toEqual(['healthy'])
  })
})

describe('readTemplateRef', () => {
  it('reads both marker forms from rendered output', () => {
    const { resources } = renderTemplates([agent, skill, command], fragments)
    for (const resource of resources) {
      expect(readTemplateRef(resource.content)).toBe(`${resource.templateKind}/${resource.templateName}`)
    }
  })

  it('ignores files without a valid marker', () => {
    expect(readTemplateRef('---\nname: x\n---\nbody\n')).toBeNull()
    expect(readTemplateRef('plain text')).toBeNull()
    expect(readTemplateRef('---\ntatsu-template: widget/x\n---\n')).toBeNull()
    expect(readTemplateRef('---\ntatsu-template: agent/../x\n---\n')).toBeNull()
    expect(readTemplateRef('---\nname: x\n---\nintro\n<!-- tatsu-template: agent/x -->\n')).toBeNull()
    expect(readTemplateRef('---\n: [bad\n---\n<!-- tatsu-template: agent/x -->\n')).toBe('agent/x')
    expect(readTemplateRef('<!-- tatsu-template: skill/x -->\nbody')).toBe('skill/x')
  })
})
