import { createHash } from 'crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  capIssues,
  createWorkflowDefsLoader,
  MAX_WORKFLOW_FILE_BYTES,
  MAX_WORKFLOW_FILES,
  repoDefinitionId,
  repoKeyOf,
  resolvePrimaryCheckout,
  WORKFLOW_WATCH_DEBOUNCE_MS,
  type WorkflowDefsLoaderDeps
} from '.'
import {
  initialWorkflows,
  workflowsReducer,
  type WorkflowDefinitionSummary,
  type WorkflowsEvent,
  type WorkflowsState
} from '../../shared/state/workflows'
import { renameDefinitionSource } from './definition-copy'
import { parseDocument } from 'yaml'
import type { WorkflowDiagnostic } from '../../shared/workflow-def'

const VALID_YAML = `name: Valid flow
steps:
  - id: plan
    agent: claude
    prompt: Plan it
  - id: check
    kind: shell
    run: pnpm test
`

const PLAN_EXAMPLE_YAML = `name: plan-build-review
inputs:
  task: { type: text }
item_input: task
steps:
  - id: plan
    agent: claude
    prompt: "Plan this task: {{inputs.task}}"
    gate: approve
  - id: build
    agent: codex
    prompt: "Implement this plan:\\n{{steps.plan.summary}}"
    on_loop: "Feedback:\\n{{steps.review.summary}}"
  - id: test
    kind: shell
    run: pnpm typecheck
  - id: review
    agent: opencode
    needs: [build, test]
    prompt: "Review against {{steps.plan.summary}}"
    output:
      verdict: { enum: [pass, fail] }
    loop: { back_to: build, until: { field: verdict, equals: pass }, max: 3 }
  - id: each
    kind: foreach
    over: inputs.task
`

interface LogLine {
  category: string
  message: string
  data?: unknown
}

interface FakeWatcher {
  path: string
  listener: (eventType: string, filename: string | null) => void
  errorListeners: Array<(err: unknown) => void>
  closed: boolean
  close(): void
  on(event: 'error', listener: (err: unknown) => void): FakeWatcher
}

let dir: string
let dispatched: WorkflowsEvent[]
let logs: LogLine[]
let watchers: FakeWatcher[]

function fakeWatch(path: string, listener: FakeWatcher['listener']): FakeWatcher {
  const watcher: FakeWatcher = {
    path,
    listener,
    errorListeners: [],
    closed: false,
    close() {
      watcher.closed = true
    },
    on(_event, errorListener) {
      watcher.errorListeners.push(errorListener)
      return watcher
    }
  }
  watchers.push(watcher)
  return watcher
}

function liveWatchers(): FakeWatcher[] {
  return watchers.filter((watcher) => !watcher.closed)
}

function liveWatcherOn(path: string): FakeWatcher {
  const watcher = liveWatchers().find((w) => w.path === path)
  if (!watcher) throw new Error(`no live watcher on ${path}`)
  return watcher
}

function makeLoader(target = dir, extra: Partial<WorkflowDefsLoaderDeps> = {}) {
  return createWorkflowDefsLoader({
    dir: target,
    dispatch: (event) => dispatched.push(event),
    log: (category, message, data) => logs.push({ category, message, data }),
    watch: fakeWatch,
    ...extra
  })
}

function lastDefinitions(): WorkflowDefinitionSummary[] {
  const event = dispatched.at(-1)
  if (event?.type !== 'workflows/definitionsLoaded') throw new Error('no definitions dispatched')
  return event.payload.definitions
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf-8')).digest('hex')
}

function diag(severity: WorkflowDiagnostic['severity'], message: string, line = 1): WorkflowDiagnostic {
  return { severity, code: 'bad-value', message, path: '', line, col: 1 }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workflow-defs-'))
  dispatched = []
  logs = []
  watchers = []
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createWorkflowDefsLoader().reload', () => {
  it('summarizes valid and invalid YAML files and ignores other files', () => {
    writeFileSync(join(dir, 'valid.yaml'), VALID_YAML)
    writeFileSync(join(dir, 'Plan Example.yml'), PLAN_EXAMPLE_YAML)
    writeFileSync(join(dir, 'notes.txt'), 'not a workflow')

    const count = makeLoader().reload()

    expect(count).toBe(2)
    expect(dispatched).toHaveLength(1)
    expect(dispatched[0]).toMatchObject({
      type: 'workflows/definitionsLoaded',
      payload: { scope: 'personal' }
    })
    const byId = Object.fromEntries(lastDefinitions().map((d) => [d.id, d]))
    expect(Object.keys(byId).sort()).toEqual(['personal:plan-example', 'personal:valid'])

    expect(byId['personal:valid']).toEqual({
      id: 'personal:valid',
      name: 'Valid flow',
      scope: 'personal',
      path: join(dir, 'valid.yaml'),
      hash: sha256(VALID_YAML),
      stepIds: ['plan', 'check'],
      issues: []
    })

    const invalid = byId['personal:plan-example']
    expect(invalid.name).toBe('plan-build-review')
    expect(invalid.stepIds).toEqual(['plan', 'build', 'test', 'review', 'each'])
    expect(invalid.hash).toBe(sha256(PLAN_EXAMPLE_YAML))
    expect(invalid.issues).toHaveLength(1)
    expect(invalid.issues[0]).toContain('foreach')
  })

  it('falls back to the filename stem and no steps when the file does not parse', () => {
    writeFileSync(join(dir, 'Broken Flow.yaml'), 'name: [unclosed\n')

    makeLoader().reload()

    const [summary] = lastDefinitions()
    expect(summary.id).toBe('personal:broken-flow')
    expect(summary.name).toBe('Broken Flow')
    expect(summary.stepIds).toEqual([])
    expect(summary.issues.length).toBeGreaterThan(0)
  })

  it('keeps the first file in sorted order when two files share a slug', () => {
    writeFileSync(join(dir, 'my-plan.yml'), VALID_YAML.replace('Valid flow', 'Second'))
    writeFileSync(join(dir, 'My Plan.yaml'), VALID_YAML.replace('Valid flow', 'First'))

    expect(makeLoader().reload()).toBe(1)

    const [summary] = lastDefinitions()
    expect(summary.id).toBe('personal:my-plan')
    expect(summary.name).toBe('First')
    expect(summary.path).toBe(join(dir, 'My Plan.yaml'))
    expect(logs).toContainEqual(
      expect.objectContaining({ category: 'workflow', data: expect.objectContaining({ file: 'my-plan.yml', reason: 'duplicate-id' }) })
    )
  })

  it('skips a directory named like a YAML file without throwing', () => {
    mkdirSync(join(dir, 'folder.yaml'))
    writeFileSync(join(dir, 'valid.yaml'), VALID_YAML)

    expect(makeLoader().reload()).toBe(1)
    expect(lastDefinitions().map((d) => d.id)).toEqual(['personal:valid'])
  })

  it.skipIf(process.getuid?.() === 0)('skips an unreadable file without throwing', () => {
    const locked = join(dir, 'locked.yaml')
    writeFileSync(locked, VALID_YAML)
    chmodSync(locked, 0o000)
    try {
      expect(makeLoader().reload()).toBe(0)
      expect(lastDefinitions()).toEqual([])
      expect(logs).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ file: 'locked.yaml', reason: 'unreadable' }) })
      )
    } finally {
      chmodSync(locked, 0o600)
    }
  })

  it('skips files over the size cap', () => {
    writeFileSync(join(dir, 'huge.yaml'), `name: huge\n#${'x'.repeat(MAX_WORKFLOW_FILE_BYTES)}\n`)

    expect(makeLoader().reload()).toBe(0)
    expect(logs).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ file: 'huge.yaml', reason: 'too-large' }) })
    )
  })

  it.skipIf(process.getuid?.() === 0)('lets an unreadable first file keep its slug so a later same-slug file cannot win', () => {
    const locked = join(dir, 'my-flow.yaml')
    writeFileSync(locked, VALID_YAML.replace('Valid flow', 'First'))
    writeFileSync(join(dir, 'my_flow.yaml'), VALID_YAML.replace('Valid flow', 'Second'))
    chmodSync(locked, 0o000)
    try {
      expect(makeLoader().reload()).toBe(0)
      expect(lastDefinitions()).toEqual([])
      expect(logs).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ file: 'my-flow.yaml', reason: 'unreadable' }) })
      )
      expect(logs).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ file: 'my_flow.yaml', reason: 'duplicate-id' }) })
      )
    } finally {
      chmodSync(locked, 0o600)
    }
  })

  it('skips a symlinked definition file even when its target is a valid definition', () => {
    const outside = mkdtempSync(join(tmpdir(), 'workflow-outside-'))
    try {
      writeFileSync(join(outside, 'secret.yaml'), VALID_YAML)
      symlinkSync(join(outside, 'secret.yaml'), join(dir, 'linked.yaml'))
      writeFileSync(join(dir, 'plain.yaml'), VALID_YAML)

      expect(makeLoader().reload()).toBe(1)
      expect(lastDefinitions().map((d) => d.id)).toEqual(['personal:plain'])
      expect(logs).toContainEqual(
        expect.objectContaining({ data: expect.objectContaining({ file: 'linked.yaml', reason: 'symlink' }) })
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('loads at most the file cap and logs the ignored remainder', () => {
    for (let i = 0; i <= MAX_WORKFLOW_FILES; i += 1) {
      writeFileSync(join(dir, `flow-${String(i).padStart(3, '0')}.yaml`), VALID_YAML)
    }

    expect(makeLoader().reload()).toBe(MAX_WORKFLOW_FILES)
    expect(lastDefinitions().map((d) => d.id)).not.toContain(`personal:flow-${MAX_WORKFLOW_FILES}`)
    expect(logs).toContainEqual(
      expect.objectContaining({ data: expect.objectContaining({ reason: 'too-many-files', ignored: 1 }) })
    )
  })

  it('skips files whose name yields an empty slug', () => {
    writeFileSync(join(dir, '!!!.yaml'), VALID_YAML)

    expect(makeLoader().reload()).toBe(0)
  })

  it('creates the directory when it is missing', () => {
    const missing = join(dir, 'nested', 'workflows')

    expect(makeLoader(missing).reload()).toBe(0)
    expect(lastDefinitions()).toEqual([])
    writeFileSync(join(missing, 'valid.yaml'), VALID_YAML)
    expect(makeLoader(missing).reload()).toBe(1)
  })

  it('logs file names, ids and counts but never YAML content or messages', () => {
    writeFileSync(join(dir, 'plan.yaml'), PLAN_EXAMPLE_YAML)

    makeLoader().reload()

    const serialized = JSON.stringify(logs)
    expect(serialized).not.toContain('Plan this task')
    expect(serialized).not.toContain('need phase')
    expect(logs).toContainEqual({
      category: 'workflow',
      message: 'definition loaded',
      data: { file: 'plan.yaml', id: 'personal:plan', errors: 1, warnings: 0, unsupported: 1 }
    })
    expect(logs.every((line) => line.category === 'workflow')).toBe(true)
  })
})

describe('createWorkflowDefsLoader().getDefinition', () => {
  it('returns the fresh source and validation for a known id', () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, PLAN_EXAMPLE_YAML)
    const loader = makeLoader()
    loader.reload()
    writeFileSync(file, VALID_YAML)

    const detail = loader.getDefinition('personal:plan')

    expect(detail?.source).toBe(VALID_YAML)
    expect(detail?.summary.hash).toBe(sha256(VALID_YAML))
    expect(detail?.summary.stepIds).toEqual(['plan', 'check'])
    expect(detail?.definition?.name).toBe('Valid flow')
    expect(detail?.diagnostics).toEqual([])
  })

  it('returns null for unknown, path-like and non-string ids', () => {
    writeFileSync(join(dir, 'plan.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()

    expect(loader.getDefinition('personal:other')).toBeNull()
    expect(loader.getDefinition('../plan.yaml')).toBeNull()
    expect(loader.getDefinition(join(dir, 'plan.yaml'))).toBeNull()
    expect(loader.getDefinition('personal:../plan')).toBeNull()
    expect(loader.getDefinition(42)).toBeNull()
  })

  it('returns null when a known file was deleted after the scan', () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, VALID_YAML)
    const loader = makeLoader()
    loader.reload()
    rmSync(file)

    expect(loader.getDefinition('personal:plan')).toBeNull()
  })

  it('dispatches the whole refreshed group when the file on disk changed', () => {
    const repo = makeRepo('repo')
    const file = writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    writeRepoDef(repo, 'sibling.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()
    const id = `repo:${repoKeyOf(repo)}:flow`
    dispatched = []

    loader.getDefinition(id)
    expect(dispatched).toEqual([])

    const edited = VALID_YAML.replace('Valid flow', 'Edited')
    writeFileSync(file, edited)
    expect(loader.getDefinition(id)?.summary.hash).toBe(sha256(edited))
    expect(lastRepoLoad(repo).map((d) => [d.id, d.hash])).toEqual([
      [id, sha256(edited)],
      [`repo:${repoKeyOf(repo)}:sibling`, sha256(VALID_YAML)]
    ])
  })

  it('dispatches the group without a definition whose file vanished', () => {
    const file = join(dir, 'plan.yaml')
    writeFileSync(file, VALID_YAML)
    writeFileSync(join(dir, 'keep.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()
    rmSync(file)

    expect(loader.getDefinition('personal:plan')).toBeNull()
    expect(lastDefinitions().map((d) => d.id)).toEqual(['personal:keep'])
  })
})

function makeRepo(name: string): string {
  const root = join(dir, name)
  mkdirSync(join(root, '.git'), { recursive: true })
  return root
}

function writeRepoDef(root: string, file: string, text: string): string {
  const target = join(root, '.harness', 'workflows')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, file), text)
  return join(target, file)
}

function repoLoads(root: string): WorkflowDefinitionSummary[][] {
  return dispatched.flatMap((event) =>
    event.type === 'workflows/definitionsLoaded' && event.payload.scope === 'repo' && event.payload.repoRoot === root
      ? [event.payload.definitions]
      : []
  )
}

function lastRepoLoad(root: string): WorkflowDefinitionSummary[] {
  const loads = repoLoads(root)
  if (loads.length === 0) throw new Error(`no repo load for ${root}`)
  return loads[loads.length - 1]
}

function personalDir(): string {
  return join(dir, 'personal')
}

describe('repo-scoped definitions', () => {
  it('rebuilds the loaded id from the repo root and file path', () => {
    const repo = makeRepo('ids')
    writeRepoDef(repo, 'Ship It!.yml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()

    const [loaded] = lastRepoLoad(repo)
    expect(repoDefinitionId(repo, loaded.path)).toBe(loaded.id)
    expect(loaded.id).toBe(`repo:${repoKeyOf(repo)}:ship-it`)
    expect(repoDefinitionId(repo, '/x/.harness/workflows/---.yaml')).toBeNull()
  })

  it('loads two repos under distinct repo ids with their repoRoot', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    writeRepoDef(a, 'flow.yaml', VALID_YAML.replace('Valid flow', 'A flow'))
    writeRepoDef(b, 'flow.yaml', VALID_YAML.replace('Valid flow', 'B flow'))
    const loader = makeLoader(personalDir(), { repoRoots: [a, b] })

    expect(loader.reload()).toBe(2)

    const [fromA] = lastRepoLoad(a)
    const [fromB] = lastRepoLoad(b)
    expect(fromA).toMatchObject({
      id: `repo:${repoKeyOf(a)}:flow`,
      name: 'A flow',
      scope: 'repo',
      repoRoot: a,
      path: join(realpathSync(a), '.harness', 'workflows', 'flow.yaml')
    })
    expect(fromB).toMatchObject({ id: `repo:${repoKeyOf(b)}:flow`, name: 'B flow', repoRoot: b })
    expect(repoKeyOf(a)).toMatch(/^[0-9a-f]{12}$/)
    expect(repoKeyOf(a)).not.toBe(repoKeyOf(b))
    expect(loader.getDefinition(fromA.id)?.definition?.name).toBe('A flow')
    expect(loader.getDefinition(fromB.id)?.definition?.name).toBe('B flow')
  })

  it('reads a registered linked worktree from its primary checkout only', () => {
    const primary = makeRepo('primary')
    writeRepoDef(primary, 'flow.yaml', VALID_YAML.replace('Valid flow', 'Primary copy'))
    const gitDir = join(primary, '.git', 'worktrees', 'wt')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    const linked = join(dir, 'wt')
    mkdirSync(linked)
    writeFileSync(join(linked, '.git'), `gitdir: ${gitDir}\n`)
    writeRepoDef(linked, 'flow.yaml', VALID_YAML.replace('Valid flow', 'Linked copy'))
    writeRepoDef(linked, 'only-here.yaml', VALID_YAML)

    expect(resolvePrimaryCheckout(linked)).toBe(realpathSync(primary))
    makeLoader(personalDir(), { repoRoots: [linked] }).reload()

    const defs = lastRepoLoad(linked)
    expect(defs.map((d) => d.name)).toEqual(['Primary copy'])
    expect(defs[0].repoRoot).toBe(linked)
    expect(defs[0].id).toBe(`repo:${repoKeyOf(linked)}:flow`)
  })

  it('loads an empty group for a root that is not a git checkout or is bare', () => {
    const plain = join(dir, 'plain')
    writeRepoDef(plain, 'flow.yaml', VALID_YAML)
    const bare = join(dir, 'bare')
    mkdirSync(join(bare, 'objects'), { recursive: true })
    writeFileSync(join(bare, '.git'), 'gitdir: .\n')

    expect(makeLoader(personalDir(), { repoRoots: [plain, bare] }).reload()).toBe(0)
    expect(lastRepoLoad(plain)).toEqual([])
    expect(lastRepoLoad(bare)).toEqual([])
  })

  it('refuses a symlinked .harness or workflows directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'workflow-outside-'))
    try {
      mkdirSync(join(outside, 'workflows'))
      writeFileSync(join(outside, 'workflows', 'flow.yaml'), VALID_YAML)
      const viaHarness = makeRepo('via-harness')
      symlinkSync(outside, join(viaHarness, '.harness'))
      const viaWorkflows = makeRepo('via-workflows')
      mkdirSync(join(viaWorkflows, '.harness'))
      symlinkSync(join(outside, 'workflows'), join(viaWorkflows, '.harness', 'workflows'))

      expect(makeLoader(personalDir(), { repoRoots: [viaHarness, viaWorkflows] }).reload()).toBe(0)
      expect(lastRepoLoad(viaHarness)).toEqual([])
      expect(lastRepoLoad(viaWorkflows)).toEqual([])
      expect(logs.filter((line) => line.message === 'repo definitions refused')).toHaveLength(2)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('never creates the workflows directory inside a repo', () => {
    const repo = makeRepo('repo')

    makeLoader(personalDir(), { repoRoots: [repo] }).reload()

    expect(lastRepoLoad(repo)).toEqual([])
    expect(() => realpathSync(join(repo, '.harness'))).toThrow()
  })

  it('rejects malformed repo ids', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()
    const key = repoKeyOf(repo)

    expect(loader.getDefinition(`repo:${key}:flow`)).not.toBeNull()
    expect(loader.getDefinition(`repo:${key.toUpperCase()}:flow`)).toBeNull()
    expect(loader.getDefinition(`repo:${key.slice(1)}:flow`)).toBeNull()
    expect(loader.getDefinition(`repo:${key}:../flow`)).toBeNull()
    expect(loader.getDefinition('repo:000000000000:flow')).toBeNull()
  })
})

describe('repo root changes', () => {
  it('drops a removed root with an empty load and loads an added root', () => {
    const a = makeRepo('a')
    const b = makeRepo('b')
    writeRepoDef(a, 'flow.yaml', VALID_YAML)
    writeRepoDef(b, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [a] })
    loader.reload()
    const aWatcher = liveWatcherOn(join(realpathSync(a), '.harness', 'workflows'))
    dispatched = []

    loader.setRepoRoots([b])

    expect(repoLoads(a)).toEqual([[]])
    expect(lastRepoLoad(b).map((d) => d.id)).toEqual([`repo:${repoKeyOf(b)}:flow`])
    expect(aWatcher.closed).toBe(true)
    expect(loader.getDefinition(`repo:${repoKeyOf(a)}:flow`)).toBeNull()
  })

  it('does not reload roots that stay registered', () => {
    const a = makeRepo('a')
    writeRepoDef(a, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [a] })
    loader.reload()
    dispatched = []

    loader.setRepoRoots([a])

    expect(dispatched).toEqual([])
  })
})

describe('definition watchers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reflects an edit and a delete in a repo after the debounce', () => {
    const repo = makeRepo('repo')
    const file = writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    writeRepoDef(repo, 'other.yaml', VALID_YAML)
    makeLoader(personalDir(), { repoRoots: [repo] }).reload()
    const watcher = liveWatcherOn(join(realpathSync(repo), '.harness', 'workflows'))
    const edited = VALID_YAML.replace('Valid flow', 'Edited')
    writeFileSync(file, edited)
    dispatched = []

    watcher.listener('change', 'flow.yaml')
    watcher.listener('change', 'flow.yaml')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS - 1)
    expect(repoLoads(repo)).toEqual([])
    vi.advanceTimersByTime(1)

    expect(repoLoads(repo)).toHaveLength(1)
    expect(lastRepoLoad(repo).map((d) => [d.id.split(':')[2], d.hash])).toEqual([
      ['flow', sha256(edited)],
      ['other', sha256(VALID_YAML)]
    ])

    rmSync(file)
    liveWatcherOn(join(realpathSync(repo), '.harness', 'workflows')).listener('rename', 'flow.yaml')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    expect(lastRepoLoad(repo).map((d) => d.id.split(':')[2])).toEqual(['other'])
  })

  it('falls back to the parent watcher when the watched workflows directory is removed', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    makeLoader(personalDir(), { repoRoots: [repo] }).reload()
    const workflows = join(realpathSync(repo), '.harness', 'workflows')
    const watcher = liveWatcherOn(workflows)

    rmSync(workflows, { recursive: true })
    watcher.listener('rename', 'workflows')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)

    expect(lastRepoLoad(repo)).toEqual([])
    expect(watcher.closed).toBe(true)
    expect(liveWatcherOn(join(realpathSync(repo), '.harness')).closed).toBe(false)
  })

  it('reopens the watcher when the workflows directory is replaced at the same path', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    makeLoader(personalDir(), { repoRoots: [repo] }).reload()
    const workflows = join(realpathSync(repo), '.harness', 'workflows')
    const watcher = liveWatcherOn(workflows)

    rmSync(workflows, { recursive: true })
    writeRepoDef(repo, 'fresh.yaml', VALID_YAML)
    watcher.listener('rename', 'flow.yaml')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)

    expect(lastRepoLoad(repo).map((d) => d.id.split(':')[2])).toEqual(['fresh'])
    expect(liveWatcherOn(workflows)).not.toBe(watcher)
  })

  it('reflects a personal edit after the debounce', () => {
    const loader = makeLoader(personalDir())
    loader.reload()
    writeFileSync(join(personalDir(), 'fresh.yaml'), VALID_YAML)
    dispatched = []

    liveWatcherOn(personalDir()).listener('rename', 'fresh.yaml')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)

    expect(lastDefinitions().map((d) => d.id)).toEqual(['personal:fresh'])
  })

  it('ignores events for files that are not YAML', () => {
    makeLoader(personalDir()).reload()
    dispatched = []

    liveWatcherOn(personalDir()).listener('change', 'notes.txt')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)

    expect(dispatched).toEqual([])
  })

  it('watches the parent until the workflows directory appears, ignoring run artifacts', () => {
    const repo = makeRepo('repo')
    const checkout = realpathSync(repo)
    makeLoader(personalDir(), { repoRoots: [repo] }).reload()
    const rootWatcher = liveWatcherOn(checkout)

    mkdirSync(join(repo, '.harness', 'runs'), { recursive: true })
    rootWatcher.listener('rename', 'src')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    expect(repoLoads(repo)).toHaveLength(1)
    rootWatcher.listener('rename', '.harness')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    expect(rootWatcher.closed).toBe(true)
    const harnessWatcher = liveWatcherOn(join(checkout, '.harness'))
    dispatched = []

    harnessWatcher.listener('rename', 'runs')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    expect(dispatched).toEqual([])

    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    harnessWatcher.listener('rename', 'workflows')
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    expect(lastRepoLoad(repo).map((d) => d.id)).toEqual([`repo:${repoKeyOf(repo)}:flow`])
    expect(harnessWatcher.closed).toBe(true)
    expect(liveWatcherOn(join(checkout, '.harness', 'workflows')).closed).toBe(false)
  })

  it('logs a watcher error without throwing and rebuilds the watcher on the next reload', () => {
    const loader = makeLoader(personalDir())
    loader.reload()
    const watcher = liveWatcherOn(personalDir())

    expect(() => watcher.errorListeners.forEach((listener) => listener(new Error('boom')))).not.toThrow()
    expect(watcher.closed).toBe(true)
    expect(logs.map((line) => line.message)).toContain('definitions watcher failed')

    loader.reload()
    expect(liveWatcherOn(personalDir())).not.toBe(watcher)
  })

  it('still dispatches when watching throws', () => {
    writeFileSync(join(dir, 'valid.yaml'), VALID_YAML)
    const loader = makeLoader(dir, {
      watch: () => {
        throw Object.assign(new Error('nope'), { code: 'ENOSPC' })
      }
    })

    expect(loader.reload()).toBe(1)
    expect(logs).toContainEqual(expect.objectContaining({ message: 'definitions watcher unavailable' }))
  })

  it('dispose closes watchers and drops pending reloads', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()
    liveWatcherOn(personalDir()).listener('change', 'x.yaml')
    dispatched = []

    loader.dispose()
    vi.advanceTimersByTime(WORKFLOW_WATCH_DEBOUNCE_MS)
    loader.setRepoRoots([])

    expect(dispatched).toEqual([])
    expect(liveWatchers()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })
})

function folded(): WorkflowsState {
  return dispatched.reduce((state, event) => workflowsReducer(state, event), initialWorkflows)
}

function expectReloadNoOp(loader: { reload(): number }): void {
  const before = folded()
  const mark = dispatched.length
  loader.reload()
  expect(dispatched.length).toBeGreaterThan(mark)
  expect(dispatched.slice(mark).reduce((state, event) => workflowsReducer(state, event), before)).toBe(before)
}

function savedEvents(): WorkflowDefinitionSummary[] {
  return dispatched.flatMap((event) => (event.type === 'workflows/definitionSaved' ? [event.payload] : []))
}

const EDITED_YAML = VALID_YAML.replace('pnpm test', 'pnpm build')

describe('saveDefinition', () => {
  it('writes a personal definition under its slug and matches what a rescan yields', () => {
    const loader = makeLoader()
    loader.reload()

    const result = loader.saveDefinition({ scope: 'personal', name: 'Ship It!', source: VALID_YAML })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.summary).toMatchObject({ id: 'personal:ship-it', name: 'Valid flow', path: join(dir, 'ship-it.yaml'), hash: sha256(VALID_YAML) })
    expect(readFileSync(join(dir, 'ship-it.yaml'), 'utf8')).toBe(VALID_YAML)
    expect(readdirSync(dir)).toEqual(['ship-it.yaml'])
    expect(savedEvents()).toEqual([result.summary])
    expect(loader.getDefinition('personal:ship-it')?.source).toBe(VALID_YAML)
    expectReloadNoOp(loader)
  })

  it('writes a repo definition in the primary checkout and leaves trust keyed to the old hash', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()
    const id = `repo:${repoKeyOf(repo)}:flow`
    const trusted = workflowsReducer(folded(), { type: 'workflows/trustGranted', payload: { defId: id, hash: sha256(VALID_YAML) } })

    const created = loader.saveDefinition({ scope: 'repo', repoRoot: repo, name: 'second', source: VALID_YAML })
    const edited = loader.saveDefinition({ scope: 'repo', repoRoot: repo, defId: id, name: 'flow', source: EDITED_YAML })

    expect(created.ok && created.summary.path).toBe(join(realpathSync(repo), '.harness', 'workflows', 'second.yaml'))
    expect(created.ok && created.summary.id).toBe(`repo:${repoKeyOf(repo)}:second`)
    expect(readFileSync(join(repo, '.harness', 'workflows', 'flow.yaml'), 'utf8')).toBe(EDITED_YAML)
    const state = dispatched.slice(-2).reduce((acc, event) => workflowsReducer(acc, event), trusted)
    expect(state.definitions[id].hash).toBe(sha256(EDITED_YAML))
    expect(state.trust[id]).toBe(sha256(VALID_YAML))
    expectReloadNoOp(loader)
  })

  it('refuses an unregistered repo root and a repo without a workflows directory without creating one', () => {
    const repo = makeRepo('bare-dirs')
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()

    expect(loader.saveDefinition({ scope: 'repo', repoRoot: `${repo}/`, name: 'x', source: VALID_YAML })).toEqual({ ok: false, reason: 'unknown-repo' })
    expect(loader.saveDefinition({ scope: 'repo', repoRoot: join(dir, 'other'), name: 'x', source: VALID_YAML })).toEqual({ ok: false, reason: 'unknown-repo' })
    expect(loader.saveDefinition({ scope: 'repo', repoRoot: repo, name: 'x', source: VALID_YAML })).toEqual({ ok: false, reason: 'no-repo-dir' })
    expect(existsSync(join(repo, '.harness'))).toBe(false)
  })

  it('refuses to write through a symlinked .harness directory', () => {
    const outside = mkdtempSync(join(tmpdir(), 'workflow-outside-'))
    try {
      mkdirSync(join(outside, 'workflows'))
      const repo = makeRepo('linked')
      symlinkSync(outside, join(repo, '.harness'))
      const loader = makeLoader(personalDir(), { repoRoots: [repo] })
      loader.reload()

      expect(loader.saveDefinition({ scope: 'repo', repoRoot: repo, name: 'x', source: VALID_YAML })).toEqual({ ok: false, reason: 'no-repo-dir' })
      expect(readdirSync(join(outside, 'workflows'))).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('refuses path-like names and names with no usable slug, writing nothing', () => {
    const personal = personalDir()
    const loader = makeLoader(personal)
    loader.reload()

    for (const name of ['../../escape', '/etc/passwd', 'a/b', 'a\\b', '.hidden', 'nul\u0000byte', '..', 'x..y']) {
      expect(loader.saveDefinition({ scope: 'personal', name, source: VALID_YAML })).toEqual({ ok: false, reason: 'unsafe-name' })
    }
    for (const name of ['', '---', '日本']) {
      expect(loader.saveDefinition({ scope: 'personal', name, source: VALID_YAML })).toEqual({ ok: false, reason: 'invalid-name' })
    }
    expect(readdirSync(personal)).toEqual([])
    expect(readdirSync(dir).sort()).toEqual(['personal'])
    expect(loader.saveDefinition({ scope: 'personal', name: 'Ship It!', source: VALID_YAML }).ok).toBe(true)
    expect(readdirSync(personal)).toEqual(['ship-it.yaml'])
  })

  it('refuses a source over the size cap and writes nothing', () => {
    const loader = makeLoader()
    loader.reload()
    const source = `# ${'é'.repeat(MAX_WORKFLOW_FILE_BYTES / 2)}\n${VALID_YAML}`

    expect(loader.saveDefinition({ scope: 'personal', name: 'big', source })).toEqual({ ok: false, reason: 'too-large' })
    expect(readdirSync(dir)).toEqual([])
    expect(savedEvents()).toEqual([])
  })

  it('refuses to overwrite another file sharing the slug in either extension unless defId names it', () => {
    writeFileSync(join(dir, 'Flow.yml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()

    expect(loader.saveDefinition({ scope: 'personal', name: 'flow', source: EDITED_YAML })).toEqual({ ok: false, reason: 'exists' })
    expect(loader.saveDefinition({ scope: 'personal', name: 'FLOW!', source: EDITED_YAML })).toEqual({ ok: false, reason: 'exists' })
    expect(readFileSync(join(dir, 'Flow.yml'), 'utf8')).toBe(VALID_YAML)

    const result = loader.saveDefinition({ scope: 'personal', defId: 'personal:flow', name: 'renamed', source: EDITED_YAML })

    expect(result.ok && result.summary.path).toBe(join(dir, 'Flow.yml'))
    expect(readFileSync(join(dir, 'Flow.yml'), 'utf8')).toBe(EDITED_YAML)
    expect(readdirSync(dir)).toEqual(['Flow.yml'])
  })

  it('refuses an unknown defId, a defId from another scope and a file replaced by a symlink', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    const personal = personalDir()
    const loader = makeLoader(personal, { repoRoots: [repo] })
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'mine.yaml'), VALID_YAML)
    loader.reload()

    expect(loader.saveDefinition({ scope: 'personal', defId: 'personal:nope', name: 'nope', source: VALID_YAML })).toEqual({ ok: false, reason: 'unknown-definition' })
    expect(loader.saveDefinition({ scope: 'personal', defId: `repo:${repoKeyOf(repo)}:flow`, name: 'flow', source: VALID_YAML })).toEqual({ ok: false, reason: 'scope-mismatch' })
    expect(loader.saveDefinition({ scope: 'repo', repoRoot: repo, defId: 'personal:mine', name: 'mine', source: VALID_YAML })).toEqual({ ok: false, reason: 'scope-mismatch' })

    const target = join(dir, 'victim.yaml')
    writeFileSync(target, 'untouched')
    unlinkSync(join(personal, 'mine.yaml'))
    symlinkSync(target, join(personal, 'mine.yaml'))
    expect(loader.saveDefinition({ scope: 'personal', defId: 'personal:mine', name: 'mine', source: EDITED_YAML })).toEqual({ ok: false, reason: 'not-a-file' })
    expect(readFileSync(target, 'utf8')).toBe('untouched')
  })

  it('refuses a new file once the directory holds the file cap', () => {
    for (let i = 0; i < MAX_WORKFLOW_FILES; i++) writeFileSync(join(dir, `f${i}.yaml`), VALID_YAML)
    const loader = makeLoader()
    loader.reload()

    expect(loader.saveDefinition({ scope: 'personal', name: 'one-more', source: VALID_YAML })).toEqual({ ok: false, reason: 'too-many-files' })
    expect(existsSync(join(dir, 'one-more.yaml'))).toBe(false)
  })
})

describe('duplicateDefinition', () => {
  it('copies into the personal folder with a distinct name rewritten into the source', () => {
    const repo = makeRepo('repo')
    writeRepoDef(repo, 'flow.yaml', `# keep me\n${VALID_YAML}`)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()
    const id = `repo:${repoKeyOf(repo)}:flow`

    const first = loader.duplicateDefinition(id, () => true)
    const second = loader.duplicateDefinition(id, () => true)

    expect(first.ok && [first.summary.id, first.summary.name]).toEqual(['personal:valid-flow-copy', 'Valid flow-copy'])
    expect(second.ok && [second.summary.id, second.summary.name]).toEqual(['personal:valid-flow-copy-2', 'Valid flow-copy-2'])
    const copied = readFileSync(join(personalDir(), 'valid-flow-copy.yaml'), 'utf8')
    expect(copied).toBe(`# keep me\n${VALID_YAML.replace('name: Valid flow', 'name: "Valid flow-copy"')}`)
    expect(first.ok && first.summary.scope).toBe('personal')
  })

  it('slugs a display name with a slash when duplicating', () => {
    writeFileSync(join(dir, 'deploy.yaml'), VALID_YAML.replace('name: Valid flow', 'name: ci/deploy'))
    const loader = makeLoader()
    loader.reload()

    const copy = loader.duplicateDefinition('personal:deploy', () => true)

    expect(copy.ok && [copy.summary.id, copy.summary.name]).toEqual(['personal:ci-deploy-copy', 'ci/deploy-copy'])
    expect(readdirSync(dir).sort()).toEqual(['ci-deploy-copy.yaml', 'deploy.yaml'])
  })

  it('writes nothing when the caller refuses the definition', () => {
    writeFileSync(join(dir, 'flow.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()
    const seen: string[] = []

    expect(loader.duplicateDefinition('personal:flow', (detail) => (seen.push(detail.summary.hash), false))).toEqual({ ok: false, reason: 'not-allowed' })
    expect(seen).toEqual([sha256(VALID_YAML)])
    expect(readdirSync(dir)).toEqual(['flow.yaml'])
    expect(loader.duplicateDefinition('personal:nope', () => true)).toEqual({ ok: false, reason: 'unknown-definition' })
  })
})

describe('renameDefinitionSource', () => {
  it('replaces only the top-level name scalar', () => {
    const source = `name: old # trailing\nsteps:\n  - id: a\n    name: inner\n`
    expect(renameDefinitionSource(source, 'new: "x"')).toBe(`name: "new: \\"x\\"" # trailing\nsteps:\n  - id: a\n    name: inner\n`)
    expect(parseDocument(renameDefinitionSource(source, 'new: "x"')).get('name')).toBe('new: "x"')
  })

  it('handles a block scalar name and a map without a name', () => {
    expect(parseDocument(renameDefinitionSource('name: |\n  multi\n  line\nsteps: []\n', 'copy')).toJS()).toEqual({ name: 'copy', steps: [] })
    expect(parseDocument(renameDefinitionSource('steps: []\n', 'copy')).toJS()).toEqual({ steps: [], name: 'copy' })
  })

  it('leaves unparseable or non-map sources unchanged', () => {
    expect(renameDefinitionSource('name: [unclosed', 'copy')).toBe('name: [unclosed')
    expect(renameDefinitionSource('- a\n- b\n', 'copy')).toBe('- a\n- b\n')
  })
})

describe('deleteDefinition', () => {
  it('removes only the named definition file and dispatches its removal', () => {
    writeFileSync(join(dir, 'a.yaml'), VALID_YAML)
    writeFileSync(join(dir, 'b.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()

    expect(loader.deleteDefinition('personal:a')).toEqual({ ok: true })

    expect(readdirSync(dir)).toEqual(['b.yaml'])
    expect(dispatched.at(-1)).toEqual({ type: 'workflows/definitionDeleted', payload: { defId: 'personal:a' } })
    expect(loader.getDefinition('personal:a')).toBeNull()
    expect(Object.keys(folded().definitions)).toEqual(['personal:b'])
    expectReloadNoOp(loader)
  })

  it('deletes a repo definition from the primary checkout', () => {
    const repo = makeRepo('repo')
    const path = writeRepoDef(repo, 'flow.yaml', VALID_YAML)
    const loader = makeLoader(personalDir(), { repoRoots: [repo] })
    loader.reload()

    expect(loader.deleteDefinition(`repo:${repoKeyOf(repo)}:flow`)).toEqual({ ok: true })
    expect(existsSync(path)).toBe(false)
  })

  it('refuses unknown, path-like and non-string ids and a file swapped for a symlink', () => {
    writeFileSync(join(dir, 'a.yaml'), VALID_YAML)
    const loader = makeLoader()
    loader.reload()
    for (const id of ['personal:nope', 'personal:../a', '../a.yaml', 42, null]) {
      expect(loader.deleteDefinition(id)).toEqual({ ok: false, reason: 'unknown-definition' })
    }
    const outside = mkdtempSync(join(tmpdir(), 'workflow-outside-'))
    try {
      const victim = join(outside, 'victim.yaml')
      writeFileSync(victim, VALID_YAML)
      unlinkSync(join(dir, 'a.yaml'))
      symlinkSync(victim, join(dir, 'a.yaml'))

      expect(loader.deleteDefinition('personal:a')).toEqual({ ok: false, reason: 'not-a-file' })
      expect(existsSync(victim)).toBe(true)
      expect(existsSync(join(dir, 'a.yaml'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('capIssues', () => {
  it('puts errors first, keeps at most five and truncates each to 200 characters', () => {
    const issues = capIssues([
      diag('warning', 'warn one', 1),
      diag('error', 'x'.repeat(500), 2),
      diag('error', 'err two', 3),
      diag('error', 'err three', 4),
      diag('error', 'err four', 5),
      diag('error', 'err five', 6),
      diag('error', 'err six', 7)
    ])

    expect(issues).toHaveLength(5)
    expect(issues.every((issue) => issue.length <= 200)).toBe(true)
    expect(issues[0].startsWith('Line 2: xxx')).toBe(true)
    expect(issues.slice(1)).toEqual(['Line 3: err two', 'Line 4: err three', 'Line 5: err four', 'Line 6: err five'])
  })

  it('returns no issues for no diagnostics', () => {
    expect(capIssues([])).toEqual([])
  })
})
