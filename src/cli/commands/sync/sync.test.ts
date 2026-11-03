import { describe, it, expect } from 'vitest'
import type {
  HarnessConfigComparison,
  HarnessConfigFileRef,
  HarnessConfigScope,
  HarnessConfigSyncPlan
} from '../../../shared/state/harness-config'
import type { connect as connectWs, TatsuClient } from '../../client'
import { main, type CliIO } from '../../main'
import { classifyPlan, renderPlan, renderStatus, syncPlanCommand, syncStatusCommand } from '.'

const SKILLS: HarnessConfigScope = { agentKind: 'claude', resourceType: 'skills' }

function ref(relativePath: string, overrides: Partial<HarnessConfigFileRef> = {}): HarnessConfigFileRef {
  return {
    id: `claude:skills:${relativePath}`,
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    label: relativePath.split('/')[0],
    relativePath,
    absolutePath: `/home/.claude/skills/${relativePath}`,
    hash: 'h',
    existsOnDisk: true,
    managed: false,
    updatedAt: 0,
    ...overrides
  }
}

const GREET = ref('greet/SKILL.md', { existsOnDisk: false, source: 'template', templateRef: 'skill/greet' })
const BUILT_CHANGED = { disk: ref('built/SKILL.md'), config: ref('built/SKILL.md', { source: 'template', templateRef: 'skill/built' }) }
const HAND_CHANGED = { disk: ref('hand/SKILL.md'), config: ref('hand/SKILL.md') }
const RENDER_ERROR = { templateRef: 'skill/broken', message: 'bad frontmatter', held: [] }
const FRAGMENT_ERROR = { id: 'claude:skills:frag/SKILL.md', label: 'frag', relativePath: 'frag/SKILL.md', message: 'unknown fragment x' }
const FRAGMENT_EDIT = { id: 'claude:skills:edit/SKILL.md', label: 'edit', relativePath: 'edit/SKILL.md', fragments: ['tone', 'style'] }

function plan(overrides: Partial<HarnessConfigSyncPlan> = {}): HarnessConfigSyncPlan {
  return {
    planId: 'plan-1',
    scope: SKILLS,
    direction: 'sync-to-disk',
    status: 'synced',
    configOnly: [],
    changed: [],
    generatedAt: 1,
    fingerprint: 'f',
    ...overrides
  }
}

function comparison(scope: HarnessConfigScope, overrides: Partial<HarnessConfigComparison> = {}): HarnessConfigComparison {
  return { scope, status: 'synced', configOnly: [], changed: [], comparedAt: 1, ...overrides }
}

describe('classifyPlan', () => {
  it('is in-sync for an empty plan', () => {
    expect(classifyPlan(plan())).toEqual({ kind: 'in-sync' })
  })

  it('has writes for a detach-only plan', () => {
    expect(classifyPlan(plan({ detach: [BUILT_CHANGED.config.id] }))).toEqual({ kind: 'writes', issues: 0 })
  })

  it('is issues-only when there is nothing to write but issues exist', () => {
    const p = plan({ status: 'conflict', renderErrors: [RENDER_ERROR], fragmentErrors: [FRAGMENT_ERROR], fragmentEdits: [FRAGMENT_EDIT] })
    expect(classifyPlan(p)).toEqual({ kind: 'issues-only', issues: 3 })
  })

  it('counts issues alongside writes', () => {
    const p = plan({ status: 'conflict', configOnly: [GREET], changed: [HAND_CHANGED], fragmentEdits: [FRAGMENT_EDIT] })
    expect(classifyPlan(p)).toEqual({ kind: 'writes', issues: 1 })
  })
})

describe('renderStatus', () => {
  it('prints one row per scope with counts and notes', () => {
    const text = renderStatus([
      comparison(SKILLS, { status: 'config-only', configOnly: [GREET] }),
      comparison({ agentKind: 'codex', resourceType: 'skills' }, {
        status: 'conflict',
        changed: [HAND_CHANGED],
        renderErrors: [RENDER_ERROR],
        fragmentErrors: [FRAGMENT_ERROR, FRAGMENT_ERROR],
        fragmentEdits: [FRAGMENT_EDIT]
      }),
      comparison({ agentKind: 'opencode', resourceType: 'commands' })
    ])
    expect(text).toBe(
      [
        'SCOPE                 STATUS       NOT ON DISK  CHANGED  NOTES',
        'Claude Code · skills  config-only  1            0',
        'Codex · skills        conflict     0            1        1 render error, 2 fragment errors, 1 fragment edit',
        'Opencode · commands   synced       0            0'
      ].join('\n')
    )
  })
})

describe('renderPlan', () => {
  it('shows the template id on a template-built changed row that is not detached', () => {
    const text = renderPlan(plan({ status: 'conflict', changed: [BUILT_CHANGED] }))
    expect(text).toContain('Content changed:\n  built/SKILL.md  [template skill/built]  claude:skills:built/SKILL.md')
  })

  it('prints Already in sync. for an empty plan, without an apply line', () => {
    const text = renderPlan(plan())
    expect(text).toContain('Already in sync.')
    expect(text).not.toContain('Apply with')
  })

  it('prints the issues and Nothing to write when only issues exist', () => {
    const text = renderPlan(plan({ status: 'conflict', renderErrors: [RENDER_ERROR], fragmentEdits: [FRAGMENT_EDIT] }))
    expect(text).toContain('Render errors:\n  skill/broken: bad frontmatter')
    expect(text).toContain('Fragment edits:\n  edit/SKILL.md: edited sections tone, style')
    expect(text).toContain('Nothing to write; 2 issues need attention.')
    expect(text).not.toContain('Already in sync.')
    expect(text).not.toContain('Apply with')
  })

  it('prints the full plan with template ids, detaches, issues and the apply line', () => {
    const text = renderPlan(
      plan({
        status: 'conflict',
        configOnly: [GREET],
        changed: [BUILT_CHANGED, HAND_CHANGED],
        detach: ['claude:skills:built/SKILL.md'],
        fragmentErrors: [FRAGMENT_ERROR]
      })
    )
    expect(text).toBe(
      [
        'Plan plan-1 · Claude Code · skills',
        '',
        'Not on disk:',
        '  greet/SKILL.md',
        '',
        'Content changed:',
        '  hand/SKILL.md',
        '',
        'Detach:',
        '  claude:skills:built/SKILL.md',
        '',
        'Fragment errors:',
        '  frag/SKILL.md: unknown fragment x',
        '',
        'Apply with: tatsu sync apply --agent claude --type skills --plan plan-1 --yes'
      ].join('\n')
    )
  })
})

const NO_FILES: CliIO['files'] = {
  readFile: async (path) => {
    throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  },
  homedir: () => '/nonexistent-home',
  platform: 'linux',
  isPidAlive: () => false
}

function fakeBackend(reply: (name: string, payload: { scope: HarnessConfigScope }) => unknown) {
  const requests: { name: string; args: unknown[] }[] = []
  let connections = 0
  const client: TatsuClient = {
    endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
    snapshot: async () => {
      throw new Error('unused')
    },
    request: async <T,>(name: string, ...args: unknown[]) => {
      requests.push({ name, args })
      return reply(name, args[0] as { scope: HarnessConfigScope }) as T
    },
    close: () => {}
  }
  const connect: typeof connectWs = async () => {
    connections++
    return client
  }
  return { connect, requests, connections: () => connections }
}

async function cli(argv: string[], backend: ReturnType<typeof fakeBackend>) {
  let stdout = ''
  let stderr = ''
  const code = await main(
    [...argv, '--url', 'ws://127.0.0.1:9', '--token', 't'],
    { stdout: (t) => (stdout += t), stderr: (t) => (stderr += t), env: {}, files: NO_FILES, connect: backend.connect },
    [syncStatusCommand, syncPlanCommand]
  )
  return { code, stdout, stderr }
}

const ok = (value: unknown) => ({ ok: true, value })
const syncedEverywhere = () => fakeBackend((_name, { scope }) => ok(comparison(scope)))

describe('sync status', () => {
  it('compares each filtered scope with exactly {scope}', async () => {
    const backend = syncedEverywhere()
    const r = await cli(['sync', 'status', '--type', 'commands'], backend)
    expect(r.code).toBe(0)
    expect(backend.requests).toStrictEqual([
      { name: 'harnessConfig:compare', args: [{ scope: { agentKind: 'claude', resourceType: 'commands' } }] },
      { name: 'harnessConfig:compare', args: [{ scope: { agentKind: 'opencode', resourceType: 'commands' } }] }
    ])
  })

  it('exits 0 with --check when every scope is synced', async () => {
    const backend = syncedEverywhere()
    const r = await cli(['sync', 'status', '--check'], backend)
    expect(r.code).toBe(0)
    expect(backend.requests).toHaveLength(8)
    expect(r.stderr).toBe('')
  })

  it('prints the table and then exits 1 with --check when a scope drifted', async () => {
    const backend = fakeBackend((_name, { scope }) =>
      ok(scope.agentKind === 'claude' && scope.resourceType !== 'agents' ? comparison(scope, { status: 'config-only', configOnly: [GREET] }) : comparison(scope))
    )
    const r = await cli(['sync', 'status', '--check'], backend)
    expect(r.code).toBe(1)
    expect(r.stdout).toContain('Claude Code · skills    config-only')
    expect(r.stderr).toBe('tatsu: 2 scopes out of sync\n')
  })

  it('uses the singular for one drifted scope', async () => {
    const backend = fakeBackend((_name, { scope }) => ok(comparison(scope, { status: 'conflict' })))
    const r = await cli(['sync', 'status', '--agent', 'claude', '--type', 'skills', '--check'], backend)
    expect(r.code).toBe(1)
    expect(r.stderr).toBe('tatsu: 1 scope out of sync\n')
  })

  it('exits 0 without --check even when a scope drifted', async () => {
    const backend = fakeBackend((_name, { scope }) => ok(comparison(scope, { status: 'conflict' })))
    const r = await cli(['sync', 'status'], backend)
    expect(r.code).toBe(0)
  })

  it('prints HarnessConfigComparison[] with --json, also when --check fails', async () => {
    const drifted = comparison(SKILLS, { status: 'config-only', configOnly: [GREET] })
    const backend = fakeBackend(() => ok(drifted))
    const r = await cli(['sync', 'status', '--agent', 'claude', '--type', 'skills', '--check', '--json'], backend)
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stdout)).toEqual([drifted])
    expect(JSON.parse(r.stderr)).toMatchObject({ error: { code: 'command-failed', message: '1 scope out of sync' } })
  })

  it.each([[['--agent', 'pi']], [['--agent', 'codex', '--type', 'commands']], [['extra']]])(
    'rejects %j as usage before connecting',
    async (args) => {
      const backend = syncedEverywhere()
      const r = await cli(['sync', 'status', ...args], backend)
      expect(r.code).toBe(2)
      expect(backend.connections()).toBe(0)
    }
  )

  it('rejects a compare value that is not a comparison', async () => {
    const backend = fakeBackend(() => ok({ scope: SKILLS }))
    const r = await cli(['sync', 'status', '--agent', 'claude', '--type', 'skills'], backend)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("malformed reply to 'harnessConfig:compare'")
  })
})

describe('sync plan', () => {
  it('requests exactly {scope} without --detach and prints the plan', async () => {
    const backend = fakeBackend(() => ok(plan({ status: 'config-only', configOnly: [GREET] })))
    const r = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills'], backend)
    expect(r.code).toBe(0)
    expect(backend.requests).toStrictEqual([{ name: 'harnessConfig:planSyncToDisk', args: [{ scope: SKILLS }] }])
    expect(r.stdout).toContain('Apply with: tatsu sync apply --agent claude --type skills --plan plan-1 --yes')
  })

  it('sends every --detach id', async () => {
    const backend = fakeBackend(() => ok(plan({ detach: ['a', 'b'] })))
    const r = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills', '--detach', 'a', '--detach', 'b'], backend)
    expect(r.code).toBe(0)
    expect(backend.requests).toStrictEqual([{ name: 'harnessConfig:planSyncToDisk', args: [{ scope: SKILLS, detach: ['a', 'b'] }] }])
  })

  it('prints the HarnessConfigSyncPlan with --json', async () => {
    const p = plan({ status: 'config-only', configOnly: [GREET] })
    const r = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills', '--json'], fakeBackend(() => ok(p)))
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout)).toEqual(p)
  })

  it('exits 0 for a plan that only has issues', async () => {
    const r = await cli(
      ['sync', 'plan', '--agent', 'claude', '--type', 'skills'],
      fakeBackend(() => ok(plan({ status: 'conflict', renderErrors: [RENDER_ERROR] })))
    )
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('Nothing to write; 1 issue needs attention.')
  })

  it.each([
    [['--agent', 'claude']],
    [['--type', 'skills']],
    [[]],
    [['--agent', 'codex', '--type', 'commands']],
    [['--agent', 'claude', '--type', 'skills', 'extra']]
  ])('rejects %j as usage before connecting', async (args) => {
    const backend = fakeBackend(() => ok(plan()))
    const r = await cli(['sync', 'plan', ...args], backend)
    expect(r.code).toBe(2)
    expect(backend.connections()).toBe(0)
  })

  it('maps unknown-resource to usage only when --detach was given', async () => {
    const unknown = () => fakeBackend(() => ({ ok: false, error: { code: 'unknown-resource', message: 'Only template-built files that exist on disk can be detached' } }))
    const withDetach = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills', '--detach', 'nope'], unknown())
    expect(withDetach.code).toBe(2)
    const without = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills'], unknown())
    expect(without.code).toBe(1)
  })

  it('rejects a plan value without a planId', async () => {
    const backend = fakeBackend(() => ok({ ...plan(), planId: undefined }))
    const r = await cli(['sync', 'plan', '--agent', 'claude', '--type', 'skills'], backend)
    expect(r.code).toBe(1)
    expect(r.stderr).toContain("malformed reply to 'harnessConfig:planSyncToDisk'")
  })
})
