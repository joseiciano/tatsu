import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import {
  agentSessionName,
  createAgentSpawner,
  DEFAULT_SPAWN_COLS,
  DEFAULT_SPAWN_ROWS,
  parseSpawnSpec,
  resolveSpawnSize
} from '.'
import type { AgentSpawnConfig, AgentSpawnerDeps } from '.'
import type { AgentKind, AgentModule, AgentSpawnOpts, HarnessMcpServerSpec } from '../agents'
import * as claude from '../agents/claude'
import * as codex from '../agents/codex'
import * as opencode from '../agents/opencode'
import * as pi from '../agents/pi'
import { log } from '../debug'
import type { Worktree } from '../../shared/state/worktrees'
import { initialTerminals } from '../../shared/state/terminals'
import type { PaneLeaf, PaneNode, TerminalSession, TerminalsState } from '../../shared/state/terminals'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

type CreateArgs = [
  id: string,
  cwd: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> | undefined,
  isShell: boolean,
  cols: number,
  rows: number
]

const HISTORY = 'HISTORY_BYTES'

function fakePty(opts: { createSucceeds?: boolean } = {}) {
  const running = new Set<string>()
  const createCalls: CreateArgs[] = []
  const pty: AgentSpawnerDeps['pty'] = {
    hasTerminal: (id: string) => running.has(id),
    create: ((...args: CreateArgs) => {
      createCalls.push(args)
      if (opts.createSucceeds === false) return false
      running.add(args[0])
      return true
    }) as AgentSpawnerDeps['pty']['create'],
    getHistory: () => HISTORY
  }
  return { pty, createCalls, running }
}

const DEFAULT_COMMANDS: Record<AgentKind, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi'
}

function fakeAgents(real: Partial<Record<AgentKind, AgentModule>> = {}) {
  const buildSpawnArgs = vi.fn((_opts: AgentSpawnOpts) => 'AGENT_CMD')
  const getAgent = (kind: AgentKind): AgentModule =>
    real[kind] ?? ({ defaultCommand: DEFAULT_COMMANDS[kind], buildSpawnArgs } as unknown as AgentModule)
  return { getAgent, buildSpawnArgs }
}

const SPEC: HarnessMcpServerSpec = {
  command: '/bin/el',
  args: ['/r/b.js', '--config', '/c.json'],
  env: { ELECTRON_RUN_AS_NODE: '1' }
}

const ENV: Pick<
  AgentSpawnConfig,
  'claudeEnvVars' | 'codexEnvVars' | 'opencodeEnvVars' | 'piEnvVars'
> = {
  claudeEnvVars: { WHO: 'claude' },
  codexEnvVars: { WHO: 'codex' },
  opencodeEnvVars: { WHO: 'opencode' },
  piEnvVars: { WHO: 'pi' }
}

function build(
  overrides: {
    config?: AgentSpawnConfig
    createSucceeds?: boolean
    writeMcpConfig?: (terminalId: string) => string | null
    realAgents?: Partial<Record<AgentKind, AgentModule>>
    inheritedEnv?: Readonly<Record<string, string | undefined>>
  } = {}
) {
  const store = new Store()
  const { pty, createCalls, running } = fakePty({ createSucceeds: overrides.createSucceeds })
  const { getAgent, buildSpawnArgs } = fakeAgents(overrides.realAgents)
  const writeMcpConfig = vi.fn(
    overrides.writeMcpConfig ?? ((terminalId: string) => `/tmp/mcp-${terminalId}.json`)
  )
  const config: AgentSpawnConfig = overrides.config ?? { ...ENV }
  const spawner = createAgentSpawner({
    pty,
    store,
    getConfig: () => config,
    writeMcpConfig,
    mcpServerSpec: () => SPEC,
    inheritedEnv: overrides.inheritedEnv ?? {},
    getAgent
  })
  const session = (id: string) => store.getSnapshot().state.terminals.sessions[id]
  return { spawner, store, createCalls, running, buildSpawnArgs, writeMcpConfig, session }
}

function mainWorktree(path: string): Worktree {
  return {
    path,
    branch: 'main',
    head: 'deadbeef',
    isBare: false,
    isMain: true,
    createdAt: 0,
    repoRoot: '/r/repo'
  }
}

describe('AgentSpawner.buildAgentCommand', () => {
  it('builds Claude opts from config, launch settings and the MCP file (TEST-001)', () => {
    const cwd = '/r/repo'
    const { spawner, store, buildSpawnArgs } = build({
      config: {
        claudeCommand: 'claude-beta',
        claudeModel: 'sonnet',
        harnessSystemPrompt: 'SYS',
        harnessSystemPromptMain: 'MAIN',
        claudeTuiFullscreen: false
      }
    })
    store.dispatch({ type: 'worktrees/listChanged', payload: [mainWorktree(cwd)] })

    const command = spawner.buildAgentCommand({
      terminalId: 't1',
      cwd,
      agentKind: 'claude',
      sessionId: 'sess-1',
      initialPrompt: 'do it',
      teleportSessionId: 'tele-1',
      sessionName: 'repo/main',
      modelOverride: ' opus '
    })

    expect(command).toBe('AGENT_CMD')
    expect(buildSpawnArgs).toHaveBeenCalledTimes(1)
    expect(buildSpawnArgs.mock.calls[0][0]).toMatchInlineSnapshot(`
      {
        "bashAllow": [],
        "command": "claude-beta",
        "cwd": "/r/repo",
        "initialPrompt": "do it",
        "mcpConfigPath": "/tmp/mcp-t1.json",
        "mcpServer": {
          "args": [
            "/r/b.js",
            "--config",
            "/c.json",
          ],
          "command": "/bin/el",
          "env": {
            "ELECTRON_RUN_AS_NODE": "1",
          },
        },
        "model": "opus",
        "permissionLevel": undefined,
        "sessionId": "sess-1",
        "sessionName": "repo/main",
        "systemPrompt": "SYS

      MAIN",
        "teleportSessionId": "tele-1",
        "tuiFullscreen": false,
      }
    `)
  })

  describe('non-Claude kinds (TEST-002)', () => {
    const kinds = [
      { kind: 'codex', commandKey: 'codexCommand', modelKey: 'codexModel' },
      { kind: 'opencode', commandKey: 'opencodeCommand', modelKey: 'opencodeModel' },
      { kind: 'pi', commandKey: 'piCommand', modelKey: 'piModel' }
    ] as const

    const modelCases = [
      { name: 'trimmed override beats config model', override: '  big  ', configModel: 'cfg', expected: 'big' },
      { name: 'whitespace-only override falls back to config model', override: '   ', configModel: 'cfg', expected: 'cfg' },
      { name: 'config model used when no override', override: undefined, configModel: 'cfg', expected: 'cfg' },
      { name: 'null when neither is set', override: undefined, configModel: null, expected: null }
    ]

    for (const { kind, commandKey, modelKey } of kinds) {
      for (const c of modelCases) {
        it(`${kind}: ${c.name}`, () => {
          const { spawner, buildSpawnArgs } = build({
            config: { [modelKey]: c.configModel } as AgentSpawnConfig
          })
          spawner.buildAgentCommand({
            terminalId: 't1',
            cwd: '/wt',
            agentKind: kind,
            modelOverride: c.override
          })
          expect(buildSpawnArgs.mock.calls[0][0].model).toBe(c.expected)
        })
      }

      it(`${kind}: uses the configured command, else the module default`, () => {
        const configured = build({ config: { [commandKey]: `my-${kind}` } as AgentSpawnConfig })
        configured.spawner.buildAgentCommand({ terminalId: 't1', cwd: '/wt', agentKind: kind })
        expect(configured.buildSpawnArgs.mock.calls[0][0].command).toBe(`my-${kind}`)

        const empty = build({ config: { [commandKey]: '' } as AgentSpawnConfig })
        empty.spawner.buildAgentCommand({ terminalId: 't1', cwd: '/wt', agentKind: kind })
        expect(empty.buildSpawnArgs.mock.calls[0][0].command).toBe(DEFAULT_COMMANDS[kind])
      })
    }

    it('codex and opencode get the MCP config file; pi never writes one', () => {
      for (const kind of ['codex', 'opencode'] as const) {
        const { spawner, buildSpawnArgs, writeMcpConfig } = build()
        spawner.buildAgentCommand({ terminalId: `t-${kind}`, cwd: '/wt', agentKind: kind })
        expect(buildSpawnArgs.mock.calls[0][0].mcpConfigPath).toBe(`/tmp/mcp-t-${kind}.json`)
        expect(writeMcpConfig).toHaveBeenCalledTimes(1)
      }

      const { spawner, buildSpawnArgs, writeMcpConfig } = build()
      spawner.buildAgentCommand({ terminalId: 't-pi', cwd: '/wt', agentKind: 'pi' })
      expect(writeMcpConfig).not.toHaveBeenCalled()
      expect(buildSpawnArgs.mock.calls[0][0].mcpConfigPath).toBeNull()
    })

    it('spawnAgentTerminal passes each kind its own env vars, plus HARNESS_MCP_CONFIG except for pi', () => {
      for (const kind of ['claude', 'codex', 'opencode'] as const) {
        const { spawner, createCalls } = build()
        spawner.spawnAgentTerminal({ terminalId: `t-${kind}`, cwd: '/wt', agentKind: kind })
        expect(createCalls).toHaveLength(1)
        expect(createCalls[0][4]).toEqual({ WHO: kind, HARNESS_MCP_CONFIG: `/tmp/mcp-t-${kind}.json` })
      }

      const { spawner, createCalls } = build()
      spawner.spawnAgentTerminal({ terminalId: 't-pi', cwd: '/wt', agentKind: 'pi' })
      expect(createCalls[0][4]).toEqual({ WHO: 'pi' })
    })
  })

  it('maps a null MCP config path to mcpConfigPath: null (TEST-003)', () => {
    const { spawner, buildSpawnArgs } = build({ writeMcpConfig: () => null })
    const command = spawner.buildAgentCommand({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })
    expect(command).toBe('AGENT_CMD')
    expect(buildSpawnArgs.mock.calls[0][0].mcpConfigPath).toBeNull()
  })
})

describe('AgentSpawner.buildAgentLaunch (TEST-012)', () => {
  const MCP_PATH = () => '/c.json'
  const opencodeConfig = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT)

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('opencode (real module)', () => {
    const realAgents = { opencode: opencode as unknown as AgentModule }
    const req = { terminalId: 't1', cwd: '/wt', agentKind: 'opencode' as const }

    it('env carries the configured vars, HARNESS_MCP_CONFIG and an OPENCODE_CONFIG_CONTENT with harness-control', () => {
      const { spawner, writeMcpConfig } = build({ realAgents, writeMcpConfig: MCP_PATH })

      const { env } = spawner.buildAgentLaunch(req)

      expect(writeMcpConfig).toHaveBeenCalledTimes(1)
      expect(env).toEqual({
        WHO: 'opencode',
        HARNESS_MCP_CONFIG: '/c.json',
        OPENCODE_CONFIG_CONTENT: expect.any(String)
      })
      expect(opencodeConfig(env).mcp['harness-control']).toEqual({
        type: 'local',
        command: ['/bin/el', '/r/b.js', '--config', '/c.json'],
        environment: { ELECTRON_RUN_AS_NODE: '1' },
        enabled: true
      })
    })

    it('merges a user OPENCODE_CONFIG_CONTENT from the inherited env', () => {
      const { spawner } = build({
        realAgents,
        writeMcpConfig: MCP_PATH,
        inheritedEnv: { OPENCODE_CONFIG_CONTENT: '{"model":"m"}' }
      })

      const config = opencodeConfig(spawner.buildAgentLaunch(req).env)

      expect(config.model).toBe('m')
      expect(config.mcp['harness-control']).toBeDefined()
    })

    it('reads the injected inherited env, not the test process env', () => {
      vi.stubEnv('OPENCODE_CONFIG_CONTENT', '{"model":"from-process"}')
      const { spawner } = build({ realAgents, writeMcpConfig: MCP_PATH, inheritedEnv: {} })

      const config = opencodeConfig(spawner.buildAgentLaunch(req).env)

      expect(config).not.toHaveProperty('model')
    })

    it('spawnAgentTerminal hands pty.create the command and env from buildAgentLaunch', () => {
      const { spawner, createCalls } = build({ realAgents, writeMcpConfig: MCP_PATH })
      const launch = spawner.buildAgentLaunch(req)

      spawner.spawnAgentTerminal(req)

      expect(createCalls).toHaveLength(1)
      expect(createCalls[0][3]).toEqual(['-ilc', launch.command])
      expect(createCalls[0][4]).toEqual(launch.env)
      expect(opencodeConfig(createCalls[0][4] as Record<string, string>).mcp['harness-control']).toBeDefined()
    })
  })

  it('claude: env is its vars plus HARNESS_MCP_CONFIG, and the module gets the MCP server spec', () => {
    const { spawner, buildSpawnArgs } = build({ writeMcpConfig: MCP_PATH })

    const launch = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })

    expect(launch).toEqual({ command: 'AGENT_CMD', env: { WHO: 'claude', HARNESS_MCP_CONFIG: '/c.json' } })
    expect(buildSpawnArgs.mock.calls[0][0].mcpServer).toEqual(SPEC)
  })

  it('codex (real module): command carries the harness-control -c overrides, env is its vars plus HARNESS_MCP_CONFIG', () => {
    const { spawner } = build({ realAgents: { codex: codex as unknown as AgentModule }, writeMcpConfig: MCP_PATH })

    const { command, env } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'codex' })

    expect(command).toContain(`-c 'mcp_servers.harness-control.command=`)
    expect(command).toContain(`-c 'mcp_servers.harness-control.args=["/r/b.js","--config","/c.json"]'`)
    expect(env).toEqual({ WHO: 'codex', HARNESS_MCP_CONFIG: '/c.json' })
  })

  it('pi: no MCP file, no HARNESS_MCP_CONFIG, no MCP opts', () => {
    const { spawner, buildSpawnArgs, writeMcpConfig } = build({ writeMcpConfig: MCP_PATH })

    const { env } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'pi' })

    expect(writeMcpConfig).not.toHaveBeenCalled()
    expect(env).toEqual({ WHO: 'pi' })
    expect(buildSpawnArgs.mock.calls[0][0]).toMatchObject({ mcpConfigPath: null, mcpServer: null })
  })

  describe('writeMcpConfig returning null', () => {
    it('claude: mcpServer is null and env has no HARNESS_MCP_CONFIG', () => {
      const { spawner, buildSpawnArgs } = build({ writeMcpConfig: () => null })

      const { env } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })

      expect(buildSpawnArgs.mock.calls[0][0].mcpServer).toBeNull()
      expect(env).toEqual({ WHO: 'claude' })
    })

    it('codex (real module): command has no overrides and env has no HARNESS_MCP_CONFIG', () => {
      const { spawner } = build({
        realAgents: { codex: codex as unknown as AgentModule },
        writeMcpConfig: () => null
      })

      const launch = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'codex' })

      expect(launch).toEqual({ command: 'codex', env: { WHO: 'codex' } })
    })

    it('opencode: env has neither OPENCODE_CONFIG_CONTENT nor HARNESS_MCP_CONFIG', () => {
      const { spawner } = build({
        realAgents: { opencode: opencode as unknown as AgentModule },
        writeMcpConfig: () => null
      })

      const { env } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'opencode' })

      expect(env).toEqual({ WHO: 'opencode' })
    })
  })
})

describe('AgentSpawner.spawnAgentTerminal', () => {
  it('main spawn with no client starts at the default size with no controller (TEST-004)', () => {
    const { spawner, createCalls, session } = build()

    const outcome = spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })

    expect(outcome).toBe('spawned')
    expect(createCalls).toEqual([
      [
        't1',
        '/wt',
        '',
        ['-ilc', 'AGENT_CMD'],
        { ...ENV.claudeEnvVars, HARNESS_MCP_CONFIG: '/tmp/mcp-t1.json' },
        false,
        DEFAULT_SPAWN_COLS,
        DEFAULT_SPAWN_ROWS
      ]
    ])
    expect(session('t1')).toEqual({
      controllerClientId: null,
      spectatorClientIds: [],
      size: { cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS }
    })
  })

  it.each([
    { name: 'zero', cols: 0, rows: 0 },
    { name: 'negative', cols: -5, rows: -1 },
    { name: 'fractional', cols: 90.5, rows: 40.5 },
    { name: 'NaN', cols: Number.NaN, rows: Number.NaN }
  ])('falls back to the default size for $name cols/rows', ({ cols, rows }) => {
    const { spawner, createCalls, session } = build()
    spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude', cols, rows })
    expect(createCalls[0].slice(6)).toEqual([DEFAULT_SPAWN_COLS, DEFAULT_SPAWN_ROWS])
    expect(session('t1')?.size).toEqual({ cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS })
  })

  it('client spawn gives that client control at its fitted size (TEST-005)', () => {
    const { spawner, createCalls, session } = build()

    const outcome = spawner.spawnAgentTerminal(
      { terminalId: 't1', cwd: '/wt', agentKind: 'claude', cols: 90, rows: 40 },
      'c1'
    )

    expect(outcome).toBe('spawned')
    expect(createCalls[0].slice(6)).toEqual([90, 40])
    expect(session('t1')).toEqual({
      controllerClientId: 'c1',
      spectatorClientIds: [],
      size: { cols: 90, rows: 40 }
    })
  })

  it('attaches to a running PTY without rebuilding or respawning it (TEST-006)', () => {
    const { spawner, createCalls, buildSpawnArgs, session } = build()
    const req = { terminalId: 't1', cwd: '/wt', agentKind: 'claude' as const, cols: 90, rows: 40 }
    expect(spawner.spawnAgentTerminal(req, 'c1')).toBe('spawned')

    const outcome = spawner.spawnAgentTerminal(
      { ...req, agentKind: 'codex', initialPrompt: 'different spec', cols: 50, rows: 10 },
      'c2'
    )

    expect(outcome).toBe('attached')
    expect(createCalls).toHaveLength(1)
    expect(buildSpawnArgs).toHaveBeenCalledTimes(1)
    expect(session('t1')).toEqual({
      controllerClientId: 'c1',
      spectatorClientIds: ['c2'],
      size: { cols: 90, rows: 40 }
    })
  })

  it('attaching from main without a client leaves the roster untouched', () => {
    const { spawner, store } = build()
    spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' }, 'c1')
    const before = store.getSnapshot().state.terminals.sessions

    expect(spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })).toBe('attached')
    expect(store.getSnapshot().state.terminals.sessions).toBe(before)
  })

  it.each([
    { name: 'main spawn', clientId: undefined },
    { name: 'client spawn', clientId: 'c1' }
  ])('reports failed and adds no session when create fails ($name) (TEST-007)', ({ clientId }) => {
    const { spawner, session } = build({ createSucceeds: false })

    const outcome = spawner.spawnAgentTerminal(
      { terminalId: 't1', cwd: '/wt', agentKind: 'claude', cols: 90, rows: 40 },
      clientId
    )

    expect(outcome).toBe('failed')
    expect(session('t1')).toBeUndefined()
  })
})

describe('AgentSpawner.spawnShellTerminal (TEST-008)', () => {
  it.each([
    { name: 'with a command runs it through a login shell', command: 'npm test', args: ['-ilc', 'npm test'] },
    { name: 'without a command opens an interactive login shell', command: undefined, args: ['-il'] },
    { name: 'with an empty command opens an interactive login shell', command: '', args: ['-il'] }
  ])('$name', ({ command, args }) => {
    const { spawner, createCalls, buildSpawnArgs } = build()

    const outcome = spawner.spawnShellTerminal({ terminalId: 's1', cwd: '/wt/sub', command, cols: 80, rows: 24 })

    expect(outcome).toBe('spawned')
    expect(createCalls).toEqual([['s1', '/wt/sub', '', args, undefined, true, 80, 24]])
    expect(buildSpawnArgs).not.toHaveBeenCalled()
  })
})

describe('AgentSpawner.attach (TEST-009)', () => {
  it('reports a dead terminal with its history and touches neither roster nor PTY', () => {
    const { spawner, store, createCalls } = build()
    const before = store.getSnapshot().state.terminals.sessions

    expect(spawner.attach('t1', 'c1')).toEqual({ alive: false, history: HISTORY })
    expect(store.getSnapshot().state.terminals.sessions).toBe(before)
    expect(createCalls).toHaveLength(0)
  })

  it('a client attaching to a running PTY with no session becomes controller', () => {
    const { spawner, running, session, createCalls } = build()
    running.add('t1')

    expect(spawner.attach('t1', 'c1')).toEqual({ alive: true, history: HISTORY })
    expect(session('t1')?.controllerClientId).toBe('c1')
    expect(createCalls).toHaveLength(0)
  })

  it('on a main-spawned PTY the first client takes control and the next spectates', () => {
    const { spawner, session } = build()
    spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude' })
    expect(session('t1')?.controllerClientId).toBeNull()

    spawner.attach('t1', 'c1')
    spawner.attach('t1', 'c2')

    expect(session('t1')).toEqual({
      controllerClientId: 'c1',
      spectatorClientIds: ['c2'],
      size: { cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS }
    })
  })
})

describe('AgentSpawner.createOrAttach (TEST-010)', () => {
  it('spawns a missing agent terminal with empty history and gives the client control', () => {
    const { spawner, createCalls, session } = build()

    const result = spawner.createOrAttach(
      { kind: 'agent', terminalId: 't1', cwd: '/wt', agentKind: 'claude' },
      'c1',
      90,
      40
    )

    expect(result).toEqual({ outcome: 'spawned', history: '' })
    expect(createCalls).toHaveLength(1)
    expect(createCalls[0][5]).toBe(false)
    expect(session('t1')).toEqual({ controllerClientId: 'c1', spectatorClientIds: [], size: { cols: 90, rows: 40 } })
  })

  it('spawns a shell spec as a shell PTY', () => {
    const { spawner, createCalls, buildSpawnArgs } = build()

    const result = spawner.createOrAttach({ kind: 'shell', terminalId: 's1', cwd: '/wt', command: 'ls' }, 'c1', 80, 24)

    expect(result).toEqual({ outcome: 'spawned', history: '' })
    expect(createCalls).toEqual([['s1', '/wt', '', ['-ilc', 'ls'], undefined, true, 80, 24]])
    expect(buildSpawnArgs).not.toHaveBeenCalled()
  })

  it('attaches to a running PTY, replays its history and ignores the new spec', () => {
    const { spawner, createCalls, buildSpawnArgs, session } = build()
    spawner.createOrAttach({ kind: 'agent', terminalId: 't1', cwd: '/wt', agentKind: 'claude' }, 'c1', 90, 40)
    buildSpawnArgs.mockClear()

    const result = spawner.createOrAttach(
      { kind: 'agent', terminalId: 't1', cwd: '/wt', agentKind: 'codex', initialPrompt: 'other' },
      'c2',
      50,
      10
    )

    expect(result).toEqual({ outcome: 'attached', history: HISTORY })
    expect(buildSpawnArgs).not.toHaveBeenCalled()
    expect(createCalls).toHaveLength(1)
    expect(session('t1')?.spectatorClientIds).toEqual(['c2'])
  })
})

describe('resolveSpawnSize (TEST-011)', () => {
  const WT = '/wt'

  function leaf(id: string, tabIds: string[]): PaneLeaf {
    return {
      type: 'leaf',
      id,
      tabs: tabIds.map((tabId) => ({ id: tabId, type: 'agent', label: tabId })),
      activeTabId: tabIds[0]
    }
  }

  function sized(cols: number, rows: number): TerminalSession {
    return { controllerClientId: 'c1', spectatorClientIds: [], size: { cols, rows } }
  }

  function stateWith(tree: PaneNode, sessions: Record<string, TerminalSession>): TerminalsState {
    return { ...initialTerminals, panes: { [WT]: tree }, sessions }
  }

  const tree: PaneNode = {
    type: 'split',
    id: 'root',
    direction: 'horizontal',
    ratio: 0.5,
    children: [leaf('other-leaf', ['far']), leaf('own-leaf', ['target', 'unsized', 'sibling'])]
  }

  it('a sized sibling in the same leaf beats a sized tab in an earlier leaf, ignoring the target itself', () => {
    const state = stateWith(tree, {
      target: sized(200, 60),
      unsized: { controllerClientId: null, spectatorClientIds: [], size: null },
      sibling: sized(100, 50),
      far: sized(80, 24)
    })
    expect(resolveSpawnSize(state, WT, 'target')).toEqual({ cols: 100, rows: 50 })
  })

  it('falls back to a sized tab in another leaf when no sibling is sized', () => {
    const state = stateWith(tree, { target: sized(200, 60), far: sized(80, 24) })
    expect(resolveSpawnSize(state, WT, 'target')).toEqual({ cols: 80, rows: 24 })
  })

  it.each([
    { name: 'no sized sessions', state: stateWith(tree, {}) },
    { name: 'only the target is sized', state: stateWith(tree, { target: sized(200, 60) }) },
    { name: 'no pane tree for the worktree', state: { ...initialTerminals, sessions: { far: sized(80, 24) } } }
  ])('uses the default spawn size with $name', ({ state }) => {
    expect(resolveSpawnSize(state, WT, 'target')).toEqual({ cols: DEFAULT_SPAWN_COLS, rows: DEFAULT_SPAWN_ROWS })
  })
})

describe('agentSessionName (TEST-012)', () => {
  it.each([
    { name: 'enabled with a worktree', wt: { repoRoot: '/a/b/repo', branch: 'feat' }, enabled: true, expected: 'repo/feat' },
    { name: 'repoRoot with no slash', wt: { repoRoot: 'repo', branch: 'feat' }, enabled: true, expected: 'repo/feat' },
    { name: 'disabled', wt: { repoRoot: '/a/b/repo', branch: 'feat' }, enabled: false, expected: undefined },
    { name: 'no worktree', wt: undefined, enabled: true, expected: undefined }
  ])('$name', ({ wt, enabled, expected }) => {
    expect(agentSessionName(wt, enabled)).toBe(expected)
  })
})

describe('parseSpawnSpec (TEST-012b)', () => {
  const valid = { kind: 'agent', terminalId: 't1', cwd: '/wt', agentKind: 'claude' }

  it.each([
    { name: 'unknown kind', raw: { ...valid, kind: 'bogus' } },
    { name: 'missing kind', raw: { terminalId: 't1', cwd: '/wt' } },
    { name: 'empty terminalId', raw: { ...valid, terminalId: '' } },
    { name: 'empty cwd', raw: { ...valid, cwd: '' } },
    { name: 'non-string terminalId', raw: { ...valid, terminalId: 42 } },
    { name: 'non-string cwd', raw: { ...valid, cwd: ['/wt'] } },
    { name: 'null', raw: null },
    { name: 'a string', raw: 'agent' }
  ])('rejects $name', ({ raw }) => {
    expect(parseSpawnSpec(raw)).toBeNull()
  })

  it('maps an unknown agentKind to the claude fallback and keeps the agent fields', () => {
    expect(
      parseSpawnSpec({ ...valid, agentKind: 'gpt-9', sessionId: 's', initialPrompt: 'go', modelOverride: 'opus' })
    ).toEqual({
      kind: 'agent',
      terminalId: 't1',
      cwd: '/wt',
      agentKind: 'claude',
      sessionId: 's',
      initialPrompt: 'go',
      modelOverride: 'opus'
    })
  })

  it('round-trips a valid shell spec', () => {
    const spec = { kind: 'shell', terminalId: 's1', cwd: '/wt', command: 'npm test' }
    expect(parseSpawnSpec(spec)).toEqual(spec)
  })
})

describe('permission level plumbing (TEST-008)', () => {
  beforeEach(() => {
    vi.mocked(log).mockClear()
  })

  const logLines = () => vi.mocked(log).mock.calls.map((c) => c.join(' '))

  it('spawnAgentTerminal carries the level and the sanitized bashAllow into the agent opts', () => {
    const { spawner, buildSpawnArgs } = build()

    spawner.spawnAgentTerminal({
      terminalId: 't1',
      cwd: '/wt',
      agentKind: 'claude',
      permissionLevel: 'edit',
      bashAllow: ['npm test', 'bad,entry']
    })

    expect(buildSpawnArgs.mock.calls[0][0]).toMatchObject({ permissionLevel: 'edit', bashAllow: ['npm test'] })
  })

  it('logs the count of dropped bashAllow entries, not the entries', () => {
    const { spawner } = build()

    spawner.spawnAgentTerminal({
      terminalId: 't1',
      cwd: '/wt',
      agentKind: 'claude',
      permissionLevel: 'edit',
      bashAllow: ['npm test', 'bad,entry']
    })

    expect(log).toHaveBeenCalledWith('agent-spawn', expect.stringContaining('dropped 1'))
    expect(logLines().some((l) => l.includes('bad,entry'))).toBe(false)
  })

  it.each([
    { name: 'a requested level', permissionLevel: 'edit' as const, expected: 'perm=edit' },
    { name: 'no level', permissionLevel: undefined, expected: 'perm=default' }
  ])('the spawn log line reports $name', ({ permissionLevel, expected }) => {
    const { spawner } = build()

    spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude', permissionLevel })

    const spawnLine = logLines().find((l) => l.includes('spawned id=t1'))
    expect(spawnLine).toContain(expected)
  })
})

describe('clients cannot set a permission level (TEST-009)', () => {
  it('createOrAttach ignores a permissionLevel smuggled onto the spec', () => {
    const { spawner, buildSpawnArgs } = build()

    spawner.createOrAttach(
      { kind: 'agent', terminalId: 't1', cwd: '/wt', agentKind: 'claude', permissionLevel: 'full' } as any,
      'c1'
    )

    expect(buildSpawnArgs).toHaveBeenCalledTimes(1)
    expect(buildSpawnArgs.mock.calls[0][0].permissionLevel).toBeUndefined()
  })

  it('buildAgentCommand with the legacy handler field list applies no level', () => {
    const { spawner, buildSpawnArgs } = build()

    spawner.buildAgentCommand({
      terminalId: 't1',
      cwd: '/wt',
      agentKind: 'claude',
      sessionId: 's',
      initialPrompt: 'go',
      teleportSessionId: 'tele',
      sessionName: 'repo/main',
      modelOverride: 'opus'
    })

    expect(buildSpawnArgs.mock.calls[0][0].permissionLevel).toBeUndefined()
  })

  it('attach wins: a running PTY is not respawned for a request with a different level', () => {
    const { spawner, buildSpawnArgs, createCalls } = build()
    spawner.spawnAgentTerminal({ terminalId: 't1', cwd: '/wt', agentKind: 'claude', permissionLevel: 'read-only' })
    buildSpawnArgs.mockClear()

    const outcome = spawner.spawnAgentTerminal({
      terminalId: 't1',
      cwd: '/wt',
      agentKind: 'claude',
      permissionLevel: 'full'
    })

    expect(outcome).toBe('attached')
    expect(buildSpawnArgs).not.toHaveBeenCalled()
    expect(createCalls).toHaveLength(1)
  })
})

describe('buildAgentLaunch with real agent modules per permission level (TEST-010)', () => {
  const MCP_PATH = () => '/c.json'
  const READ_ONLY_LIST = 'Read,Grep,Glob,Edit(.harness/runs/**),mcp__harness-control__complete_step'

  beforeEach(() => {
    vi.mocked(log).mockClear()
  })

  describe('claude', () => {
    const realAgents = { claude: claude as unknown as AgentModule }

    it.each([
      {
        level: 'read-only' as const,
        flags: ` --allowedTools '${READ_ONLY_LIST}' --permission-mode dontAsk`
      },
      {
        level: 'edit' as const,
        flags:
          " --allowedTools 'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash(git status:*),mcp__harness-control__complete_step' --permission-mode dontAsk"
      },
      { level: 'full' as const, flags: ' --permission-mode bypassPermissions' }
    ])('$level puts the mapping-table flags right after the command', ({ level, flags }) => {
      const { spawner } = build({ realAgents, writeMcpConfig: MCP_PATH })

      const { command } = spawner.buildAgentLaunch({
        terminalId: 't1',
        cwd: '/wt',
        agentKind: 'claude',
        initialPrompt: 'go',
        permissionLevel: level,
        bashAllow: ['git status', 'bad,entry']
      })

      expect(command).toContain(`claude${flags}`)
    })

    it('no level adds no permission flags', () => {
      const { spawner } = build({ realAgents, writeMcpConfig: MCP_PATH })

      const { command } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'claude', bashAllow: ['git status'] })

      expect(command).not.toContain('--permission-mode')
      expect(command).not.toContain('--allowedTools')
    })
  })

  describe('opencode', () => {
    const realAgents = { opencode: opencode as unknown as AgentModule }
    const launch = (permissionLevel?: 'read-only' | 'edit' | 'full') =>
      build({ realAgents, writeMcpConfig: MCP_PATH }).spawner.buildAgentLaunch({
        terminalId: 't1',
        cwd: '/wt',
        agentKind: 'opencode',
        permissionLevel,
        bashAllow: ['git status', 'bad,entry']
      })
    const config = (env: Record<string, string>) => JSON.parse(env.OPENCODE_CONFIG_CONTENT)

    it.each([
      { level: 'read-only' as const, bash: 'deny', edit: { '*': 'deny', '.harness/runs/**': 'allow' } },
      {
        level: 'edit' as const,
        bash: { '*': 'deny', 'git status': 'allow', 'git status *': 'allow' },
        edit: 'allow'
      }
    ])('$level launches harness-step and ships its permission map with the MCP server', ({ level, bash, edit }) => {
      const { command, env } = launch(level)

      expect(command).toContain('opencode --agent harness-step')
      const parsed = config(env)
      expect(parsed.mcp['harness-control']).toBeDefined()
      expect(parsed.agent['harness-step'].permission).toMatchObject({ '*': 'deny', bash, edit })
    })

    it('full launches harness-step with an allow-all map', () => {
      const { command, env } = launch('full')

      expect(command).toContain('opencode --agent harness-step')
      expect(config(env).agent['harness-step'].permission).toEqual({ '*': 'allow' })
    })

    it('no level launches no step agent', () => {
      const { command, env } = launch(undefined)

      expect(command).not.toContain('--agent')
      expect(config(env)).not.toHaveProperty('agent')
    })
  })

  describe('codex', () => {
    const realAgents = { codex: codex as unknown as AgentModule }

    it.each([
      { level: 'read-only' as const, sandbox: 'read-only' },
      { level: 'edit' as const, sandbox: 'workspace-write' },
      { level: 'full' as const, sandbox: 'danger-full-access' }
    ])('$level adds the MCP approve override and the mapping-table flags before the prompt', ({ level, sandbox }) => {
      const { spawner } = build({ realAgents, writeMcpConfig: MCP_PATH })

      const { command, env } = spawner.buildAgentLaunch({
        terminalId: 't1',
        cwd: '/wt',
        agentKind: 'codex',
        initialPrompt: 'go',
        permissionLevel: level,
        bashAllow: ['git status']
      })

      expect(command).toContain(
        `-c 'mcp_servers.harness-control.default_tools_approval_mode="approve"' --sandbox ${sandbox} --ask-for-approval never 'go'`
      )
      expect(env).toEqual({ ...ENV.codexEnvVars, HARNESS_MCP_CONFIG: '/c.json' })
    })

    it('no level adds neither sandbox/approval flags nor the approve override', () => {
      const { spawner } = build({ realAgents, writeMcpConfig: MCP_PATH })

      const { command } = spawner.buildAgentLaunch({ terminalId: 't1', cwd: '/wt', agentKind: 'codex', initialPrompt: 'go' })

      expect(command).not.toContain('--sandbox')
      expect(command).not.toContain('--ask-for-approval')
      expect(command).not.toContain('default_tools_approval_mode')
    })
  })

  describe('pi', () => {
    const realAgents = { pi: pi as unknown as AgentModule }
    const NOT_SUPPORTED = 'permissionLevel not supported for pi; spawning with defaults'
    const req = { terminalId: 't1', cwd: '/wt', agentKind: 'pi' as const, initialPrompt: 'go', bashAllow: ['git status'] }

    it.each(['read-only', 'edit', 'full'] as const)('%s spawns exactly as with no level and logs that it is ignored', (level) => {
      const { spawner } = build({ realAgents })
      const withoutLevel = spawner.buildAgentLaunch(req)
      expect(log).not.toHaveBeenCalledWith('agent-spawn', NOT_SUPPORTED)

      const withLevel = spawner.buildAgentLaunch({ ...req, permissionLevel: level })

      expect(withLevel).toEqual(withoutLevel)
      expect(log).toHaveBeenCalledWith('agent-spawn', NOT_SUPPORTED)
    })
  })
})
