import * as fs from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderTemplates } from '../../shared/harness-template-render'
import type { HarnessTemplateImportChoices } from '../../shared/state/harness-config'
import {
  importTemplateSetup,
  planTemplateImport,
  readTemplateImportListing,
  type ImportFolderListing,
  type TemplateImportListing
} from '.'

const ROOT = '/dots'

function folder(name: string, files: Record<string, string>, links: Record<string, string> = {}): ImportFolderListing {
  return { root: `${ROOT}/${name}`, realRoot: `${ROOT}/${name}`, files, links, skipped: [] }
}

const REVIEWER = `---
name: reviewer
description: Reviews diffs for correctness
shared: [house-style, safety]
claude:
  tools: Read, Grep, Bash
  model: opus
opencode:
  mode: subagent
  model: anthropic/claude-opus
  temperature: 0.1
  fallback_models: [openai/gpt]
omp: false
---
Review the staged diff and report bugs.
`

const PLANNER = `---
name: planner
description: Plans work
shared: [house-style]
claude:
  model: sonnet
opencode: false
omp:
  model: x
---
Break the task into steps.
`

const HOUSE_STYLE = 'Write plainly.\n'
const SAFETY = 'Never run destructive commands.\n'

const DEPLOY_SKILL = `---
name: deploy
description: Deploy the app
allowed-tools: Bash
---
Run the deploy script. See [checklist](../../references/checklist.md).
`

const LINT_SKILL = `---
name: lint
description: Lint the repo
---
Run the linter.
`

const CHECKLIST = '# Checklist\n\n- tests pass\n'
const ROLLBACK = 'Roll back with the previous tag.\n'

const GENERATED_DEPLOY_COMMAND = `---
description: Deploy the app
---
Run the deploy script.
`

const RELEASE_COMMAND = `---
description: Cut a release
argument-hint: <version>
---
Tag and push $ARGUMENTS.
`

function fixture(): TemplateImportListing {
  return {
    agents: folder('agents', { 'reviewer.md': REVIEWER, 'planner.md': PLANNER, 'build.sh': '' }),
    agentFragments: folder('agents-shared', { 'house-style.md': HOUSE_STYLE, 'safety.md': SAFETY }),
    skills: [
      folder(
        'skills',
        { 'deploy/SKILL.md': DEPLOY_SKILL, 'deploy/notes.txt': 'x' },
        { 'deploy/rollback.md': `${ROOT}/references/rollback.md` }
      ),
      folder('skills-extra', { 'lint/SKILL.md': LINT_SKILL })
    ],
    references: folder('references', { 'checklist.md': CHECKLIST, 'rollback.md': ROLLBACK }),
    commands: folder('commands', { 'deploy.md': GENERATED_DEPLOY_COMMAND, 'release.md': RELEASE_COMMAND })
  }
}

function choices(overrides: Partial<HarnessTemplateImportChoices> = {}): HarnessTemplateImportChoices {
  return { harnesses: ['claude'], duplicateChoices: {}, conflictChoices: {}, ...overrides }
}

function run(listing = fixture(), overrides: Partial<HarnessTemplateImportChoices> = {}, existing: string[] = []) {
  return importTemplateSetup(listing, { ...choices(overrides), existing: new Set(existing) })
}

describe('importTemplateSetup', () => {
  it('maps agents with per-harness blocks, fragments, skills with references, and commands (TEST-001)', () => {
    const result = run()
    expect(result.blockingReasons).toEqual([])

    const reviewer = result.templates.find((entry) => entry.item.key === 'agent/reviewer')!
    expect(reviewer.draft).toMatchObject({
      kind: 'agent',
      name: 'reviewer',
      description: 'Reviews diffs for correctness',
      fragments: ['house-style', 'safety'],
      body: 'Review the staged diff and report bugs.\n',
      harnesses: {
        claude: { frontmatter: { tools: 'Read, Grep, Bash', model: 'opus' } },
        opencode: { frontmatter: { mode: 'subagent' } }
      }
    })
    expect(reviewer.item.droppedBlocks).toEqual(['omp: Tatsu does not manage this harness'])
    expect(reviewer.item.unsupportedSettings).toEqual([
      { harness: 'opencode', key: 'model', value: '"anthropic/claude-opus"' },
      { harness: 'opencode', key: 'fallback_models', value: '["openai/gpt"]' },
      { harness: 'opencode', key: 'temperature', value: '0.1' }
    ])
    expect(reviewer.item.targets).toEqual(['claude', 'opencode'])

    const planner = result.templates.find((entry) => entry.item.key === 'agent/planner')!
    expect(planner.draft?.harnesses.opencode).toBe(false)
    expect(planner.item.droppedBlocks).toEqual(['omp: Tatsu does not manage this harness'])

    expect(result.fragments.map((entry) => [entry.item.name, entry.content])).toEqual([
      ['house-style', HOUSE_STYLE],
      ['safety', SAFETY]
    ])

    const deploy = result.templates.find((entry) => entry.item.key === 'skill/deploy')!
    expect(deploy.draft?.harnesses).toEqual({ claude: { frontmatter: { 'allowed-tools': 'Bash' } } })
    expect(deploy.draft?.references).toEqual([
      { fileName: 'checklist.md', content: CHECKLIST },
      { fileName: 'rollback.md', content: ROLLBACK }
    ])
    expect(result.templates.find((entry) => entry.item.key === 'skill/lint')).toBeDefined()

    const release = result.templates.find((entry) => entry.item.key === 'command/release')!
    expect(release.draft?.harnesses).toEqual({ claude: { frontmatter: { 'argument-hint': '<version>' } } })

    expect(result.unknownFiles.map((issue) => issue.sourcePath).sort()).toEqual([
      `${ROOT}/agents/build.sh`,
      `${ROOT}/skills/deploy/notes.txt`
    ])
  })

  it('reports a generated command matching a skill as covered and does not import it (TEST-002)', () => {
    const result = run()
    expect(result.coveredCommands).toEqual([
      { name: 'deploy', skill: 'deploy', sourcePath: `${ROOT}/commands/deploy.md` }
    ])
    expect(result.templates.some((entry) => entry.item.key === 'command/deploy')).toBe(false)
  })

  it('imports a same-name command when the skill does not target Claude', () => {
    const result = run(fixture(), { harnesses: ['opencode'] })
    expect(result.coveredCommands).toEqual([])
    const deploy = result.templates.find((entry) => entry.item.key === 'command/deploy')!
    expect(deploy.draft).not.toBeNull()
    expect(deploy.item.notes.some((note) => note.includes('same name'))).toBe(true)
  })

  it('blocks duplicate skill names across source folders until one is chosen (TEST-003)', () => {
    const listing = fixture()
    listing.skills[1].files['deploy/SKILL.md'] = DEPLOY_SKILL.replace('Deploy the app', 'Other deploy')
    const blocked = run(listing)
    expect(blocked.duplicates).toEqual([
      {
        name: 'deploy',
        sources: [`${ROOT}/skills/deploy/SKILL.md`, `${ROOT}/skills-extra/deploy/SKILL.md`],
        choice: null
      }
    ])
    expect(blocked.blockingReasons).toHaveLength(1)
    expect(blocked.templates.some((entry) => entry.item.key === 'skill/deploy')).toBe(false)

    const resolved = run(listing, { duplicateChoices: { deploy: `${ROOT}/skills-extra` } })
    expect(resolved.blockingReasons).toEqual([])
    const deploy = resolved.templates.find((entry) => entry.item.key === 'skill/deploy')!
    expect(deploy.draft?.description).toBe('Other deploy')

    const skipped = run(listing, { duplicateChoices: { deploy: 'skip' } })
    expect(skipped.blockingReasons).toEqual([])
    expect(skipped.templates.some((entry) => entry.item.key === 'skill/deploy')).toBe(false)
  })

  it('marks existing names as conflicts and waits for skip or replace', () => {
    const undecided = run(fixture(), {}, ['agent/reviewer', 'fragment/safety'])
    const reviewer = undecided.templates.find((entry) => entry.item.key === 'agent/reviewer')!
    expect(reviewer.item).toMatchObject({ conflict: true, action: 'undecided' })
    expect(undecided.blockingReasons).toHaveLength(2)

    const decided = run(
      fixture(),
      { conflictChoices: { 'agent/reviewer': 'replace', 'fragment/safety': 'skip' } },
      ['agent/reviewer', 'fragment/safety']
    )
    expect(decided.blockingReasons).toEqual([])
    expect(decided.templates.find((entry) => entry.item.key === 'agent/reviewer')!.item.action).toBe('replace')
    expect(decided.fragments.find((entry) => entry.item.key === 'fragment/safety')!.item.action).toBe('skip')
  })

  it('drops a codex block on an agent with the reason and imports the rest', () => {
    const listing = fixture()
    listing.agents!.files['reviewer.md'] = REVIEWER.replace('omp: false', 'codex:\n  model: gpt')
    const reviewer = run(listing).templates.find((entry) => entry.item.key === 'agent/reviewer')!
    expect(reviewer.item.droppedBlocks).toHaveLength(1)
    expect(reviewer.item.droppedBlocks[0]).toMatch(/^codex: /)
    expect(reviewer.draft?.harnesses.codex).toBeUndefined()
  })

  it('lists a malformed file as invalid without dropping the others', () => {
    const listing = fixture()
    listing.agents!.files['broken.md'] = '---\nname: [\n---\nbody\n'
    const result = run(listing)
    const broken = result.templates.find((entry) => entry.item.sourcePath.endsWith('broken.md'))!
    expect(broken.item.action).toBe('invalid')
    expect(broken.item.error).toMatch(/YAML/)
    expect(result.templates.find((entry) => entry.item.key === 'agent/reviewer')!.draft).not.toBeNull()
  })

  it('renders imported Claude agents and commands byte-identical to the old build output (TEST-004)', () => {
    const result = run()
    const drafts = result.templates.flatMap((entry) => (entry.draft ? [entry.draft] : []))
    const fragments = result.fragments.map((entry) => ({ name: entry.item.name, content: entry.content }))
    const rendered = renderTemplates(drafts, fragments)
    expect(rendered.errors).toEqual([])
    const claude = new Map(
      rendered.resources
        .filter((resource) => resource.agentKind === 'claude')
        .map((resource) => [`${resource.resourceType}/${resource.relativePath}`, resource.content])
    )

    const oldBuild: Record<string, string> = {
      'agents/reviewer.md': `---
name: reviewer
description: Reviews diffs for correctness
tools: Read, Grep, Bash
model: opus
---
Review the staged diff and report bugs.

Write plainly.

Never run destructive commands.
`,
      'agents/planner.md': `---
name: planner
description: Plans work
model: sonnet
---
Break the task into steps.

Write plainly.
`,
      'commands/release.md': `---
name: release
description: Cut a release
argument-hint: <version>
---
Tag and push $ARGUMENTS.
`
    }
    for (const [key, expected] of Object.entries(oldBuild)) {
      expect(claude.get(key), key).toBe(expected)
    }
  })


  it('imports a file rendered with either legacy marker form without carrying the marker into the template', () => {
    const listing = fixture()
    listing.agents!.files['old.md'] = `---
name: old
description: Old agent
model: opus
tatsu-template: agent/old
---
Old body.
`
    listing.commands!.files['legacy.md'] = `---
description: Old command
---
<!-- tatsu-template: command/legacy -->
Legacy body.
`
    const drafts = run(listing).templates.flatMap((entry) =>
      entry.draft && (entry.item.key === 'agent/old' || entry.item.key === 'command/legacy') ? [entry.draft] : []
    )
    expect(drafts.map((draft) => `${draft.kind}/${draft.name}`)).toEqual(['agent/old', 'command/legacy'])
    for (const draft of drafts) {
      for (const block of Object.values(draft.harnesses)) {
        if (block) expect(block.frontmatter).not.toHaveProperty('tatsu-template')
      }
    }
    expect(drafts.map((draft) => draft.body)).toEqual(['Old body.\n', 'Legacy body.\n'])

    const rendered = renderTemplates(drafts, [])
    expect(rendered.errors).toEqual([])
    expect(rendered.resources.map((resource) => [resource.relativePath, resource.content])).toEqual([
      ['old.md', '---\nname: old\ndescription: Old agent\nmodel: opus\n---\nOld body.\n'],
      ['legacy.md', '---\nname: legacy\ndescription: Old command\n---\nLegacy body.\n']
    ])
  })
})

describe('planTemplateImport', () => {
  it('renders the imported files with the current disk content and lists shadows', () => {
    const plan = planTemplateImport(fixture(), choices(), {
      existingTemplates: [],
      existingFragments: [],
      templateShadows: (draft) => (draft.name === 'release' ? ['claude commands release.md'] : []),
      currentContent: (agentKind, resourceType, relativePath) =>
        agentKind === 'claude' && resourceType === 'agents' && relativePath === 'reviewer.md' ? 'old' : null
    })
    expect(plan.preview.blockingReasons).toEqual([])
    expect(plan.preview.fingerprint).toMatch(/^sha256:/)
    expect(plan.preview.shadows).toEqual(['claude commands release.md'])
    const reviewer = plan.preview.files.find((file) => file.agentKind === 'claude' && file.relativePath === 'reviewer.md')!
    expect(reviewer.current).toBe('old')
    expect(reviewer.rendered).toBe(`---
name: reviewer
description: Reviews diffs for correctness
tools: Read, Grep, Bash
model: opus
---
Review the staged diff and report bugs.

Write plainly.

Never run destructive commands.
`)
    expect(plan.templates.map((draft) => `${draft.kind}/${draft.name}`)).toEqual([
      'agent/planner',
      'agent/reviewer',
      'skill/deploy',
      'skill/lint',
      'command/release'
    ])
    expect(plan.fragments.map((fragment) => fragment.name)).toEqual(['house-style', 'safety'])
  })

  it('treats a source file that fails to parse as an existing name that needs a choice', () => {
    const plan = planTemplateImport(fixture(), choices(), {
      existingTemplates: [],
      existingFragments: [],
      existingErrors: [{ relativePath: 'agents/reviewer.md' }, { relativePath: 'skills/deploy/references/x.md' }],
      templateShadows: () => [],
      currentContent: () => null
    })
    const actions = Object.fromEntries(plan.preview.items.map((item) => [item.key, item.action]))
    expect(actions['agent/reviewer']).toBe('undecided')
    expect(actions['skill/deploy']).toBe('undecided')
    expect(plan.preview.blockingReasons).toHaveLength(2)
  })

  it('reports render errors for imported templates that use unknown fragments', () => {
    const listing = fixture()
    listing.agentFragments = null
    const plan = planTemplateImport(listing, choices(), {
      existingTemplates: [],
      existingFragments: [],
      templateShadows: () => [],
      currentContent: () => null
    })
    expect(plan.preview.renderErrors.map((issue) => issue.sourcePath)).toEqual([
      'agent/planner',
      'agent/reviewer',
      'agent/reviewer'
    ])
    expect(plan.preview.renderErrors[0].message).toMatch(/^claude: Unknown fragment/)
  })
})

describe('readTemplateImportListing', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(mkdtempSync(join(tmpdir(), 'tatsu-import-')))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function write(relativePath: string, content: string): void {
    const target = join(dir, ...relativePath.split('/'))
    fs.mkdirSync(join(target, '..'), { recursive: true })
    fs.writeFileSync(target, content)
  }

  it('reads markdown files, records links into the references folder, and leaves the source untouched', () => {
    write('references/checklist.md', CHECKLIST)
    write('references/more/rollback.md', ROLLBACK)
    write('skills/deploy/SKILL.md', DEPLOY_SKILL)
    write('skills/deploy/run.sh', 'echo')
    fs.symlinkSync(join(dir, 'references/checklist.md'), join(dir, 'skills/deploy/checklist.md'))
    fs.symlinkSync(join(dir, 'references/more'), join(dir, 'skills/deploy/references'))
    const before = fs.readdirSync(join(dir, 'skills/deploy')).sort()

    const listing = readTemplateImportListing({
      agents: null,
      agentFragments: null,
      skills: [join(dir, 'skills')],
      references: join(dir, 'references'),
      commands: null
    })
    const skills = listing.skills[0]
    expect(skills.files).toEqual({ 'deploy/SKILL.md': DEPLOY_SKILL })
    expect(skills.links).toEqual({
      'deploy/checklist.md': join(dir, 'references/checklist.md'),
      'deploy/references/rollback.md': join(dir, 'references/more/rollback.md')
    })
    expect(skills.skipped.map((issue) => issue.message)).toEqual(['Not a markdown file'])
    expect(fs.readdirSync(join(dir, 'skills/deploy')).sort()).toEqual(before)

    const result = importTemplateSetup(listing, { ...choices(), existing: new Set() })
    const deploy = result.templates.find((entry) => entry.item.key === 'skill/deploy')!
    expect(deploy.draft?.references.map((reference) => reference.fileName)).toEqual(['checklist.md', 'rollback.md'])
  })

  it('rejects a relative folder path', () => {
    expect(() =>
      readTemplateImportListing({ agents: 'agents', agentFragments: null, skills: [], references: null, commands: null })
    ).toThrow(/absolute/)
  })
})
