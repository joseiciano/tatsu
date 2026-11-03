import { describe, it, expect } from 'vitest'
import type { HarnessConfigFileRef, HarnessConfigScope } from '../../../shared/state/harness-config'
import type { TatsuClient } from '../../client'
import { CliError } from '../../errors'
import { createOutput } from '../../output'
import type { CommandContext } from '..'
import { configLsCommand, renderConfigLs } from '.'

function ref(overrides: Partial<HarnessConfigFileRef> & Pick<HarnessConfigFileRef, 'label' | 'relativePath'>): HarnessConfigFileRef {
  return {
    id: `claude:skills:${overrides.relativePath}`,
    agentKind: 'claude',
    resourceType: 'skills',
    canonicalResourceType: 'skills',
    aliasResourceTypes: [],
    absolutePath: `/home/.claude/skills/${overrides.relativePath}`,
    hash: 'h',
    existsOnDisk: true,
    managed: false,
    updatedAt: 0,
    ...overrides
  }
}

const HELLO = ref({ label: 'hello', relativePath: 'hello/SKILL.md' })
const LINKED = ref({ label: 'linked-skill', relativePath: 'linked-skill/SKILL.md', linkedFrom: '/dotfiles/skills/linked-skill' })
const BUILT = ref({ label: 'greet', relativePath: 'greet/SKILL.md', templateRef: 'skill/greet', linkedFrom: '/x' })

function fakeClient(byScope: Record<string, unknown>) {
  const requests: { name: string; args: unknown[] }[] = []
  let connected = 0
  const client: TatsuClient = {
    endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
    snapshot: async () => {
      throw new Error('unused')
    },
    request: async <T,>(name: string, ...args: unknown[]) => {
      requests.push({ name, args })
      const payload = args[0] as { scope: HarnessConfigScope }
      return byScope[`${payload.scope.agentKind}:${payload.scope.resourceType}`] as T
    },
    close: () => {}
  }
  return {
    client,
    requests,
    connections: () => connected,
    connect: async () => {
      connected++
      return client
    }
  }
}

const ok = (resources: HarnessConfigFileRef[]) => ({ ok: true, value: { resources, scannedAt: 1 } })

async function runLs(fake: ReturnType<typeof fakeClient>, opts: { values?: CommandContext['values']; positionals?: string[]; json?: boolean } = {}) {
  let stdout = ''
  const output = createOutput({ json: opts.json ?? false, stdout: (t) => (stdout += t) })
  await configLsCommand.run({
    values: opts.values ?? {},
    positionals: opts.positionals ?? [],
    globals: { json: opts.json ?? false },
    env: {},
    client: fake.connect,
    output
  })
  output.flush()
  return stdout
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!(err instanceof CliError)) throw new Error(`expected a CliError, got ${String(err)}`)
  return err
}

describe('renderConfigLs', () => {
  it('prints a header per scope and label, path and flags per resource', () => {
    const text = renderConfigLs([
      { scope: { agentKind: 'claude', resourceType: 'skills' }, resources: [HELLO, LINKED, BUILT] },
      { scope: { agentKind: 'opencode', resourceType: 'commands' }, resources: [] }
    ])
    expect(text).toBe(
      [
        'Claude Code · skills',
        '  hello         hello/SKILL.md',
        '  linked-skill  linked-skill/SKILL.md  linked',
        '  greet         greet/SKILL.md         template, linked',
        '',
        'Opencode · commands',
        '  (none)'
      ].join('\n')
    )
  })

  it('leaves no trailing whitespace on rows without flags', () => {
    const text = renderConfigLs([{ scope: { agentKind: 'claude', resourceType: 'skills' }, resources: [HELLO, BUILT] }])
    for (const line of text.split('\n')) expect(line).toBe(line.trimEnd())
  })
})

describe('configLsCommand', () => {
  it('is registered as `config ls`', () => {
    expect(configLsCommand.name).toBe('config ls')
  })

  it('scans each filtered scope sequentially with exactly {scope}', async () => {
    const fake = fakeClient({ 'claude:commands': ok([]), 'opencode:commands': ok([]) })
    await runLs(fake, { values: { type: 'commands' } })
    expect(fake.requests).toEqual([
      { name: 'harnessConfig:scan', args: [{ scope: { agentKind: 'claude', resourceType: 'commands' } }] },
      { name: 'harnessConfig:scan', args: [{ scope: { agentKind: 'opencode', resourceType: 'commands' } }] }
    ])
  })

  it('scans every supported scope without filters', async () => {
    const fake = fakeClient(new Proxy({}, { get: () => ok([]) }))
    await runLs(fake)
    expect(fake.requests).toHaveLength(8)
  })

  it('prints [{scope, resources}] with --json', async () => {
    const fake = fakeClient({ 'claude:skills': ok([HELLO, LINKED]) })
    const out = await runLs(fake, { values: { agent: 'claude', type: 'skills' }, json: true })
    expect(JSON.parse(out)).toEqual([{ scope: { agentKind: 'claude', resourceType: 'skills' }, resources: [HELLO, LINKED] }])
  })

  it('prints the human listing', async () => {
    const fake = fakeClient({ 'claude:skills': ok([HELLO, LINKED]) })
    const out = await runLs(fake, { values: { agent: 'claude', type: 'skills' } })
    expect(out).toContain('linked-skill  linked-skill/SKILL.md  linked')
  })

  it.each([
    [{ agent: 'pi' }],
    [{ agent: 'codex', type: 'commands' }],
    [{ agent: 'nope' }],
    [{ type: 'hooks' }]
  ])('rejects %j as usage before connecting', async (values) => {
    const fake = fakeClient({})
    const err = await rejection(runLs(fake, { values }))
    expect(err.code).toBe('usage')
    expect(fake.connections()).toBe(0)
  })

  it('rejects an extra argument', async () => {
    const err = await rejection(runLs(fakeClient({}), { positionals: ['extra'] }))
    expect(err.code).toBe('usage')
  })

  it('surfaces a backend error through the envelope mapping', async () => {
    const fake = fakeClient({ 'claude:skills': { ok: false, error: { code: 'read-failed', message: 'cannot read skills' } } })
    const err = await rejection(runLs(fake, { values: { agent: 'claude', type: 'skills' } }))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe('cannot read skills')
  })

  it('rejects a scan value without a resources array', async () => {
    const fake = fakeClient({ 'claude:skills': { ok: true, value: { scannedAt: 1 } } })
    const err = await rejection(runLs(fake, { values: { agent: 'claude', type: 'skills' } }))
    expect(err.code).toBe('request-failed')
  })
})

