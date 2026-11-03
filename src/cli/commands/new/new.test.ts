import { describe, it, expect } from 'vitest'
import { initialState, type AppState } from '../../../shared/state'
import type { PaneLeaf, PaneNode, TerminalTab } from '../../../shared/state/terminals'
import type { Worktree } from '../../../shared/state/worktrees'
import type { TatsuClient } from '../../client'
import { CliError } from '../../errors'
import { createOutput } from '../../output'
import type { CommandContext } from '..'
import { NEW_TIMEOUT_MS, newCommand, renderNew, resolveRepo, tabTypeFor } from '.'

function worktree(path: string, repoRoot: string, branch: string): Worktree {
  return { path, repoRoot, branch, head: 'abc', isBare: false, isMain: path === repoRoot, createdAt: 0 }
}

function tab(id: string, type: TerminalTab['type']): TerminalTab {
  return { id, type, label: id }
}

function leaf(id: string, tabs: TerminalTab[]): PaneLeaf {
  return { type: 'leaf', id, tabs, activeTabId: tabs[0]?.id ?? '' }
}

function stateWith(repoRoots: string[], list: Worktree[] = [], panes: Record<string, PaneNode> = {}): AppState {
  return {
    ...initialState,
    worktrees: { ...initialState.worktrees, repoRoots, list },
    terminals: { ...initialState.terminals, panes }
  }
}

const NEW_PATH = '/nonexistent/repo-a-worktrees/feat-x'

interface Harness {
  requests: { name: string; args: unknown[] }[]
  snapshots: number
}

function fakeClient(reply: unknown | ((name: string) => Promise<unknown>), states: AppState[]): { client: TatsuClient; seen: Harness } {
  const seen: Harness = { requests: [], snapshots: 0 }
  const client: TatsuClient = {
    endpoint: { url: 'ws://127.0.0.1:1', source: 'flag' },
    snapshot: async () => states[Math.min(seen.snapshots++, states.length - 1)],
    request: async <T,>(name: string, ...args: unknown[]) => {
      seen.requests.push({ name, args })
      return (typeof reply === 'function' ? await (reply as (name: string) => Promise<unknown>)(name) : reply) as T
    },
    close: () => {}
  }
  return { client, seen }
}

async function runNew(argv: { positionals: string[]; values?: CommandContext['values']; json?: boolean }, client: TatsuClient) {
  let stdout = ''
  const output = createOutput({ json: argv.json ?? false, stdout: (t) => (stdout += t) })
  let connected = 0
  await newCommand.run({
    values: argv.values ?? {},
    positionals: argv.positionals,
    globals: { json: argv.json ?? false },
    env: {},
    client: async () => {
      connected++
      return client
    },
    output
  })
  output.flush()
  return { stdout, connected }
}

async function rejection(promise: Promise<unknown>): Promise<CliError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  if (!(err instanceof CliError)) throw new Error(`expected a CliError, got ${String(err)}`)
  return err
}

const oneRepo = stateWith(['/nonexistent/repo-a'])
const created = stateWith(['/nonexistent/repo-a'], [], { [NEW_PATH]: leaf('p', [tab('agent-1', 'agent'), tab('sh', 'shell')]) })

describe('newCommand contract', () => {
  it('defaults to a 10 minute timeout', () => {
    expect(NEW_TIMEOUT_MS).toBe(600_000)
    expect(newCommand.defaultTimeoutMs).toBe(NEW_TIMEOUT_MS)
  })
})

describe('new: argument validation', () => {
  it('requires exactly one branch and never connects otherwise', async () => {
    const { client } = fakeClient({}, [oneRepo])
    for (const positionals of [[], ['a', 'b']]) {
      let connected = 0
      const err = await rejection(
        newCommand.run({
          values: {},
          positionals,
          globals: { json: false },
          env: {},
          client: async () => {
            connected++
            return client
          },
          output: createOutput({ json: false, stdout: () => {} })
        }) as Promise<void>
      )
      expect(err.code).toBe('usage')
      expect(connected).toBe(0)
    }
  })

  it('rejects an unknown --agent as usage before connecting', async () => {
    const { client, seen } = fakeClient({}, [oneRepo])
    const err = await rejection(runNew({ positionals: ['x'], values: { agent: 'nope' } }, client))
    expect(err.code).toBe('usage')
    expect(err.message).toContain('claude, codex, opencode, pi')
    expect(seen.snapshots).toBe(0)
  })
})

describe('resolveRepo', () => {
  const two = stateWith(['/nonexistent/repo-a', '/nonexistent/repo-b'], [worktree('/nonexistent/wt/b-feat', '/nonexistent/repo-b', 'feat')])

  it('prefers --repo, matching a worktree path under a repo', () => {
    expect(resolveRepo(two, { repo: '/nonexistent/wt/b-feat/src', cwd: '/nonexistent/repo-a' })).toBe('/nonexistent/repo-b')
  })

  it('rejects a --repo no open repo contains, listing the repos', () => {
    let err: unknown
    try {
      resolveRepo(two, { repo: '/elsewhere', cwd: '/nonexistent/repo-a' })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(CliError)
    expect((err as CliError).code).toBe('usage')
    expect((err as CliError).details).toEqual({ repoRoots: ['/nonexistent/repo-a', '/nonexistent/repo-b'] })
  })

  it('uses the open repo containing cwd', () => {
    expect(resolveRepo(two, { cwd: '/nonexistent/repo-a/src' })).toBe('/nonexistent/repo-a')
  })

  it('falls back to the only open repo when cwd matches none', () => {
    expect(resolveRepo(oneRepo, { cwd: '/elsewhere' })).toBe('/nonexistent/repo-a')
  })

  it('is a usage error listing the repos when several are open and cwd matches none', () => {
    let err: unknown
    try {
      resolveRepo(two, { cwd: '/elsewhere' })
    } catch (e) {
      err = e
    }
    expect((err as CliError).code).toBe('usage')
    expect((err as CliError).message).toContain('--repo')
    expect((err as CliError).details).toEqual({ repoRoots: ['/nonexistent/repo-a', '/nonexistent/repo-b'] })
  })

  it('is a usage error when no repo is open', () => {
    expect(() => resolveRepo(stateWith([]), { cwd: '/elsewhere' })).toThrow(CliError)
  })
})

describe('new: request payload', () => {
  it('sends runPending with a pending: id and only the given fields', async () => {
    const { client, seen } = fakeClient({ id: 'x', outcome: 'success', createdPath: NEW_PATH }, [oneRepo, created])
    await runNew({ positionals: ['feat/x'], values: { prompt: 'do X', agent: 'codex', model: 'o3' } }, client)
    expect(seen.requests).toHaveLength(1)
    const [{ name, args }] = seen.requests
    expect(name).toBe('worktrees:runPending')
    expect(args).toHaveLength(1)
    const params = args[0] as Record<string, unknown>
    expect(params.id).toMatch(/^pending:[0-9a-f-]{36}$/)
    expect({ ...params, id: undefined }).toEqual({
      id: undefined,
      repoRoot: '/nonexistent/repo-a',
      branchName: 'feat/x',
      initialPrompt: 'do X',
      agentKind: 'codex',
      model: 'o3'
    })
  })

  it('omits absent and empty optional fields', async () => {
    const { client, seen } = fakeClient({ id: 'x', outcome: 'success', createdPath: NEW_PATH }, [oneRepo, created])
    await runNew({ positionals: ['feat/x'], values: { prompt: '', model: '' } }, client)
    const params = seen.requests[0].args[0] as Record<string, unknown>
    expect(Object.keys(params).sort()).toEqual(['branchName', 'id', 'repoRoot'])
  })
})

describe('new: outcome mapping', () => {
  it('success prints JSON with the tab type from a fresh snapshot', async () => {
    const { client, seen } = fakeClient({ id: 'x', outcome: 'success', createdPath: NEW_PATH }, [oneRepo, created])
    const r = await runNew({ positionals: ['feat/x'], values: { prompt: 'hi' }, json: true }, client)
    expect(seen.snapshots).toBe(2)
    expect(JSON.parse(r.stdout)).toEqual({
      outcome: 'success',
      path: NEW_PATH,
      branch: 'feat/x',
      repo: '/nonexistent/repo-a',
      tab: 'agent'
    })
  })

  it('setup-failed is command-failed carrying and printing the created path, and keeps the pending entry', async () => {
    const { client, seen } = fakeClient({ id: 'x', outcome: 'setup-failed', createdPath: NEW_PATH }, [oneRepo])
    const err = await rejection(runNew({ positionals: ['feat/x'] }, client))
    expect(err.code).toBe('command-failed')
    expect(err.message).toContain(NEW_PATH)
    expect(err.details).toEqual({ path: NEW_PATH })
    expect(seen.requests.map((r) => r.name)).toEqual(['worktrees:runPending'])
  })

  const gitMessage = "fatal: 'feat/x' is already checked out at '/somewhere'"

  it("error dismisses its pending entry, then is command-failed with the server's message", async () => {
    const { client, seen } = fakeClient({ id: 'x', outcome: 'error', error: `${gitMessage}\n` }, [oneRepo])
    const err = await rejection(runNew({ positionals: ['feat/x'] }, client))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe(gitMessage)
    const [run, dismiss] = seen.requests
    expect(seen.requests).toHaveLength(2)
    expect(dismiss).toEqual({ name: 'worktrees:dismissPending', args: [(run.args[0] as { id: string }).id] })
  })

  it('a failed dismiss does not mask the original error', async () => {
    const { client, seen } = fakeClient(async (name: string) => {
      if (name === 'worktrees:dismissPending') throw new CliError('unreachable', 'connection closed')
      return { id: 'x', outcome: 'error', error: gitMessage }
    }, [oneRepo])
    const err = await rejection(runNew({ positionals: ['feat/x'] }, client))
    expect(err.code).toBe('command-failed')
    expect(err.message).toBe(gitMessage)
    expect(seen.requests.map((r) => r.name)).toEqual(['worktrees:runPending', 'worktrees:dismissPending'])
  })

  it('a malformed reply is request-failed', async () => {
    const { client } = fakeClient({ nope: true }, [oneRepo])
    const err = await rejection(runNew({ positionals: ['feat/x'] }, client))
    expect(err.code).toBe('request-failed')
  })

  it('a timeout says creation continues and suggests tatsu worktrees', async () => {
    const { client } = fakeClient(async () => {
      throw new CliError('timeout', "request 'worktrees:runPending' timed out after 600000 ms")
    }, [oneRepo])
    const err = await rejection(runNew({ positionals: ['feat/x'] }, client))
    expect(err.code).toBe('timeout')
    expect(err.message).toContain('continues on the server')
    expect(err.message).toContain('tatsu worktrees')
  })

  it('passes other request errors through unchanged', async () => {
    const original = new CliError('unreachable', 'connection closed')
    const { client } = fakeClient(async () => {
      throw original
    }, [oneRepo])
    expect(await rejection(runNew({ positionals: ['feat/x'] }, client))).toBe(original)
  })
})

describe('tabTypeFor', () => {
  it('finds the first agent or chat tab across nested panes', () => {
    const tree: PaneNode = {
      type: 'split',
      id: 's',
      direction: 'horizontal',
      ratio: 0.5,
      children: [leaf('a', [tab('sh', 'shell')]), leaf('b', [tab('chat', 'json-claude')])]
    }
    expect(tabTypeFor(stateWith([], [], { [NEW_PATH]: tree }), NEW_PATH)).toBe('json-claude')
    expect(tabTypeFor(created, NEW_PATH)).toBe('agent')
  })

  it('is null without panes or without an agent tab', () => {
    expect(tabTypeFor(oneRepo, NEW_PATH)).toBeNull()
    expect(tabTypeFor(stateWith([], [], { [NEW_PATH]: leaf('a', [tab('sh', 'shell')]) }), NEW_PATH)).toBeNull()
  })
})

describe('renderNew', () => {
  const base = { outcome: 'success' as const, path: NEW_PATH, branch: 'feat/x', repo: '/nonexistent/repo-a' }

  it('says a chat agent already started with the prompt', () => {
    expect(renderNew({ ...base, tab: 'json-claude' }, { prompted: true })).toBe(
      `Created ${NEW_PATH} (feat/x)\nAgent started with your prompt.`
    )
  })

  it('says a terminal agent starts when its tab is opened', () => {
    expect(renderNew({ ...base, tab: 'agent' }, { prompted: true })).toBe(
      `Created ${NEW_PATH} (feat/x)\nAgent tab ready with your prompt — it starts when the tab is opened in Tatsu.`
    )
  })

  it('prints only the created line without a prompt or without an agent tab', () => {
    expect(renderNew({ ...base, tab: 'agent' }, { prompted: false })).toBe(`Created ${NEW_PATH} (feat/x)`)
    expect(renderNew({ ...base, tab: null }, { prompted: true })).toBe(`Created ${NEW_PATH} (feat/x)`)
  })

  it('is what the command prints in human mode', async () => {
    const { client } = fakeClient({ id: 'x', outcome: 'success', createdPath: NEW_PATH }, [oneRepo, created])
    const r = await runNew({ positionals: ['feat/x'], values: { prompt: 'hi' } }, client)
    expect(r.stdout).toBe(renderNew({ ...base, tab: 'agent' }, { prompted: true }) + '\n')
  })
})
