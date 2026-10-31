import * as fs from 'fs'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HarnessConfigError, type HarnessConfigFilesystem } from '../harness-config'
import type { HarnessTemplateDraft } from '../../shared/harness-templates'
import {
  harnessConfigReducer,
  initialHarnessConfig,
  type HarnessConfigEvent,
  type HarnessConfigState
} from '../../shared/state/harness-config'
import { TemplateSourceStore, type TemplateSourceStoreDeps } from '.'

vi.mock('../debug', () => ({ log: vi.fn(), formatErr: (error: unknown) => String(error) }))

let dir: string
let events: HarnessConfigEvent[]
let state: HarnessConfigState

function makeStore(overrides: Partial<TemplateSourceStoreDeps> = {}): TemplateSourceStore {
  return new TemplateSourceStore({
    sourceDir: () => dir,
    store: {
      dispatch(event) {
        events.push(event)
        state = harnessConfigReducer(state, event)
      }
    },
    watch: () => ({ close: vi.fn() }),
    clock: () => Date.UTC(2026, 9, 22, 10, 0, 0),
    ...overrides
  })
}

function write(relativePath: string, content: string): void {
  const target = join(dir, ...relativePath.split('/'))
  fs.mkdirSync(join(target, '..'), { recursive: true })
  fs.writeFileSync(target, content)
}

function read(relativePath: string): string {
  return fs.readFileSync(join(dir, ...relativePath.split('/')), 'utf8')
}

function list(relativeDir: string): string[] {
  return fs.readdirSync(join(dir, ...relativeDir.split('/'))).sort()
}

function draft(overrides: Partial<HarnessTemplateDraft> = {}): HarnessTemplateDraft {
  return {
    kind: 'agent',
    name: 'reviewer',
    description: 'Reviews code',
    fragments: ['style'],
    body: 'Review the diff.\n',
    harnesses: { claude: { frontmatter: { model: 'opus' } }, codex: false },
    references: [],
    ...overrides
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tatsu-templates-'))
  events = []
  state = initialHarnessConfig
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

describe('TemplateSourceStore load', () => {
  it('loads every file shape from the source folder', () => {
    write('agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews\nclaude:\n  model: opus\ncodex: false\n---\nBody\n')
    write('commands/ship.md', '---\ndescription: Ships\nopencode: {}\n---\nShip it\n')
    write('skills/deploy/TEMPLATE.md', '---\ndescription: Deploys\nclaude: {}\n---\nDeploy\n')
    write('skills/deploy/references/guide.md', '# Guide\n')
    write('fragments/style.md', 'Be brief.\n')
    write('agents/reviewer.md.x-backup-20261022T100000000Z', 'old')
    write('README.md', 'not a template')

    makeStore().load()

    expect(state.templates.templates.map((t) => `${t.kind}/${t.name}`)).toEqual([
      'agent/reviewer',
      'skill/deploy',
      'command/ship'
    ])
    const skill = state.templates.templates[1]
    expect(skill.relativePath).toBe('skills/deploy/TEMPLATE.md')
    expect(skill.references).toEqual([{ fileName: 'guide.md', content: '# Guide\n' }])
    expect(state.templates.templates[0].harnesses).toEqual({ claude: { frontmatter: { model: 'opus' } }, codex: false })
    expect(state.templates.fragments).toEqual([
      expect.objectContaining({ name: 'style', content: 'Be brief.\n', relativePath: 'fragments/style.md' })
    ])
    expect(state.templates.errors).toEqual([])
    expect(state.templates.loadedAt).toBe(Date.UTC(2026, 9, 22, 10, 0, 0))
  })

  it('reports one malformed file and still loads the others', () => {
    write('agents/good.md', '---\nclaude: {}\n---\nGood\n')
    write('agents/bad.md', '---\nname: [unclosed\n---\n')
    write('commands/nofront.md', 'no frontmatter')
    write('fragments/ok.md', 'ok')

    makeStore().load()

    expect(state.templates.templates.map((t) => t.name)).toEqual(['good'])
    expect(state.templates.fragments.map((f) => f.name)).toEqual(['ok'])
    expect(state.templates.errors.map((e) => e.relativePath)).toEqual(['agents/bad.md', 'commands/nofront.md'])
    expect(state.templates.errors[0].message).toMatch(/not valid YAML/)
  })

  it('loads an empty model when the source folder does not exist', () => {
    rmSync(dir, { recursive: true, force: true })
    makeStore().load()
    expect(state.templates.templates).toEqual([])
    expect(state.templates.errors).toEqual([])
  })

  it('skips a skill folder that only holds backups', () => {
    write('skills/old/TEMPLATE.md.x-backup-20261022T100000000Z', 'old')
    makeStore().load()
    expect(state.templates.templates).toEqual([])
    expect(state.templates.errors).toEqual([])
  })

  it('reports symlinked template files instead of following them', () => {
    write('outside.md', '---\n---\n')
    fs.mkdirSync(join(dir, 'agents'))
    fs.symlinkSync(join(dir, 'outside.md'), join(dir, 'agents', 'linked.md'))
    makeStore().load()
    expect(state.templates.templates).toEqual([])
    expect(state.templates.errors).toEqual([
      { relativePath: 'agents/linked.md', message: 'Symbolic links are not read from the template source folder' }
    ])
  })
})

describe('TemplateSourceStore refresh', () => {
  it('applies an outside edit to a fragment file through the watcher', () => {
    vi.useFakeTimers()
    let trigger: () => void = () => {}
    write('fragments/style.md', 'Be brief.\n')
    const store = makeStore({
      debounceMs: 50,
      watch: (_dir, onChange) => {
        trigger = onChange
        return { close: vi.fn() }
      }
    })
    store.start()
    events = []

    write('fragments/style.md', 'Be thorough.\n')
    trigger()
    trigger()
    vi.advanceTimersByTime(50)

    expect(events.map((event) => event.type)).toEqual(['harnessConfig/fragmentChanged'])
    expect(state.templates.fragments[0].content).toBe('Be thorough.\n')
  })

  it('dispatches nothing when nothing changed', () => {
    write('agents/a.md', '---\nclaude: {}\n---\n')
    write('fragments/f.md', 'f')
    const store = makeStore()
    store.load()
    const before = state
    events = []
    store.refresh()
    expect(events).toEqual([])
    expect(state).toBe(before)
  })

  it('moves a file between valid and broken', () => {
    write('agents/a.md', '---\nclaude: {}\n---\n')
    const store = makeStore()
    store.load()

    write('agents/a.md', 'broken')
    store.refresh()
    expect(state.templates.templates).toEqual([])
    expect(state.templates.errors.map((e) => e.relativePath)).toEqual(['agents/a.md'])

    write('agents/a.md', '---\nclaude: {}\n---\nfixed')
    store.refresh()
    expect(state.templates.templates.map((t) => t.body)).toEqual(['fixed'])
    expect(state.templates.errors).toEqual([])
  })

  it('removes deleted files and clears errors for removed broken files', () => {
    write('fragments/f.md', 'f')
    write('agents/bad.md', 'broken')
    const store = makeStore()
    store.load()
    fs.rmSync(join(dir, 'fragments', 'f.md'))
    fs.rmSync(join(dir, 'agents', 'bad.md'))
    store.refresh()
    expect(state.templates.fragments).toEqual([])
    expect(state.templates.errors).toEqual([])
  })

  it('updates a skill when a reference file changes', () => {
    write('skills/s/TEMPLATE.md', '---\nclaude: {}\n---\n')
    write('skills/s/references/r.md', 'one')
    const store = makeStore()
    store.load()
    write('skills/s/references/r.md', 'two')
    store.refresh()
    expect(state.templates.templates[0].references).toEqual([{ fileName: 'r.md', content: 'two' }])
  })
})

describe('TemplateSourceStore writes', () => {
  it('creates the folder and writes a template that loads back', () => {
    rmSync(dir, { recursive: true, force: true })
    const store = makeStore()
    store.load()
    const saved = store.saveTemplate(draft())
    expect(saved.relativePath).toBe('agents/reviewer.md')
    expect(read('agents/reviewer.md')).toContain('name: reviewer')
    expect(state.templates.templates).toEqual([saved])
  })

  it('backs up an existing template before overwriting it', () => {
    const store = makeStore()
    store.load()
    store.saveTemplate(draft())
    const original = read('agents/reviewer.md')
    store.saveTemplate(draft({ body: 'Changed\n' }))
    expect(list('agents')).toEqual(['reviewer.md', 'reviewer.md.x-backup-20261022T100000000Z'])
    expect(read('agents/reviewer.md.x-backup-20261022T100000000Z')).toBe(original)
    expect(state.templates.templates[0].body).toBe('Changed\n')
  })

  it('aborts the save when the backup fails', () => {
    const failing: HarnessConfigFilesystem = {
      ...(fs as unknown as HarnessConfigFilesystem),
      writeFileSync(path, data, options) {
        if (String(path).includes('.x-backup-')) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
        fs.writeFileSync(path, data, options)
      }
    }
    const store = makeStore({ filesystem: failing })
    store.load()
    store.saveTemplate(draft())
    const original = read('agents/reviewer.md')

    expect(() => store.saveTemplate(draft({ body: 'Changed\n' }))).toThrowError(
      expect.objectContaining({ code: 'backup-failed' })
    )
    expect(read('agents/reviewer.md')).toBe(original)
    expect(list('agents')).toEqual(['reviewer.md'])
  })

  it('does not back up or rewrite an unchanged file', () => {
    const store = makeStore()
    store.load()
    store.saveTemplate(draft())
    events = []
    store.saveTemplate(draft())
    expect(list('agents')).toEqual(['reviewer.md'])
    expect(events).toEqual([])
  })

  it('rejects an agent template targeting Codex with an explanation', () => {
    const store = makeStore()
    store.load()
    let caught: unknown
    try {
      store.saveTemplate(draft({ harnesses: { codex: { frontmatter: {} } } }))
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HarnessConfigError)
    expect((caught as HarnessConfigError).code).toBe('invalid-target')
    expect((caught as HarnessConfigError).message).toMatch(/Codex/)
    expect(fs.existsSync(join(dir, 'agents'))).toBe(false)
  })

  it('rejects unsafe names', () => {
    const store = makeStore()
    expect(() => store.saveTemplate(draft({ name: '../escape' }))).toThrowError(
      expect.objectContaining({ code: 'invalid-name' })
    )
    expect(() => store.saveFragment('a/b', 'x')).toThrowError(expect.objectContaining({ code: 'invalid-name' }))
  })

  it('refuses to write through a symlinked folder inside the source', () => {
    const outside = mkdtempSync(join(tmpdir(), 'tatsu-outside-'))
    try {
      fs.symlinkSync(outside, join(dir, 'fragments'))
      const store = makeStore()
      expect(() => store.saveFragment('style', 'x')).toThrowError(expect.objectContaining({ code: 'unsafe-path' }))
      expect(fs.readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('writes skill references and removes ones dropped from the template', () => {
    const store = makeStore()
    store.load()
    store.saveTemplate(
      draft({
        kind: 'skill',
        name: 'deploy',
        references: [
          { fileName: 'a.md', content: 'A' },
          { fileName: 'b.md', content: 'B' }
        ]
      })
    )
    expect(list('skills/deploy/references')).toEqual(['a.md', 'b.md'])

    store.saveTemplate(draft({ kind: 'skill', name: 'deploy', references: [{ fileName: 'a.md', content: 'A' }] }))
    expect(list('skills/deploy/references')).toEqual(['a.md', 'b.md.x-backup-20261022T100000000Z'])
    expect(state.templates.templates[0].references).toEqual([{ fileName: 'a.md', content: 'A' }])
  })

  it('deletes a template with a backup and reports unknown templates', () => {
    const store = makeStore()
    store.load()
    store.saveTemplate(draft({ kind: 'skill', name: 'deploy', references: [{ fileName: 'a.md', content: 'A' }] }))
    store.deleteTemplate('skill', 'deploy')
    expect(state.templates.templates).toEqual([])
    expect(list('skills/deploy')).toEqual(['TEMPLATE.md.x-backup-20261022T100000000Z', 'references'])
    store.refresh()
    expect(state.templates.errors).toEqual([])
    expect(() => store.deleteTemplate('agent', 'missing')).toThrowError(
      expect.objectContaining({ code: 'unknown-resource' })
    )
  })

  it('saves and deletes fragments', () => {
    const store = makeStore()
    store.load()
    const saved = store.saveFragment('style', 'Be brief.\n')
    expect(saved).toEqual(expect.objectContaining({ name: 'style', relativePath: 'fragments/style.md' }))
    expect(state.templates.fragments).toEqual([saved])
    store.deleteFragment('style')
    expect(state.templates.fragments).toEqual([])
    expect(list('fragments')).toEqual(['style.md.x-backup-20261022T100000000Z'])
  })
})

describe('TemplateSourceStore watcher errors', () => {
  it('re-arms the watcher after it fails', () => {
    vi.useFakeTimers()
    const onErrors: (() => void)[] = []
    const store = makeStore({
      debounceMs: 10,
      watch: (_dir, _onChange, onError) => {
        onErrors.push(onError)
        return { close: vi.fn() }
      }
    })
    store.start()
    write('fragments/style.md', 'x')
    onErrors[0]()
    vi.advanceTimersByTime(10)
    expect(onErrors).toHaveLength(2)
    expect(state.templates.fragments.map((f) => f.name)).toEqual(['style'])
  })
})
