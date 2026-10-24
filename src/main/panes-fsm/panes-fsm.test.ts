import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import { PanesFSM } from '.'
import { createAgentSpawner } from '../agent-spawn'
import type { AgentSpawnerDeps } from '../agent-spawn'
import type { AgentModule, AgentSpawnOpts } from '../agents'
import type { PaneLeaf, PaneNode, TerminalTab } from '../../shared/state/terminals'
import { getLeaves } from '../../shared/state/terminals'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

type PanesFSMOptions = ConstructorParameters<typeof PanesFSM>[1]

function buildFSM(
  extra: Partial<PanesFSMOptions> = {},
  store: Store = new Store()
): { fsm: PanesFSM; store: Store } {
  const fsm = new PanesFSM(store, {
    persist: () => {},
    getRepoRootForWorktree: () => undefined,
    getLatestClaudeSessionId: async () => null,
    ...extra
  })
  return { fsm, store }
}

function allTabs(store: Store, wtPath: string): TerminalTab[] {
  const tree = store.getSnapshot().state.terminals.panes[wtPath]
  return tree ? getLeaves(tree).flatMap((l) => l.tabs) : []
}

function startSpy() {
  return vi.fn<NonNullable<PanesFSMOptions['startAgentTab']>>()
}

function seedLeaf(store: Store, wtPath: string, leaf: PaneLeaf): void {
  store.dispatch({
    type: 'terminals/panesForWorktreeChanged',
    payload: { worktreePath: wtPath, panes: leaf }
  })
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('PanesFSM.splitPane', () => {
  it('mints a UUID id for a json-claude clone so the Claude CLI accepts --session-id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json'
    const sourceTabId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      model: 'opus'
    }
    const sourcePane: PaneLeaf = {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    }
    seedLeaf(store, wtPath, sourcePane)

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')

    expect(newPane).not.toBeNull()
    expect(newPane!.tabs).toHaveLength(1)
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('json-claude')
    expect(cloned.id).toMatch(UUID_RE)
    expect(cloned.id).not.toBe(sourceTabId)
    // tab.id and sessionId must agree — Chat tabs treat them as one value
    expect(cloned.sessionId).toBe(cloned.id)
    expect(cloned.mode).toBe('awake')
    // Inherits the source's model + label
    expect(cloned.model).toBe('opus')
    expect(cloned.label).toBe('Chat')
  })

  it('does not carry over initialPrompt/teleportSessionId from the source chat', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json2'
    const sourceTabId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake',
      initialPrompt: 'stale kickoff',
      teleportSessionId: 'stale-teleport'
    }
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    })

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.initialPrompt).toBeUndefined()
    expect(cloned.teleportSessionId).toBeUndefined()
  })

  it('clones an agent source into a fresh shell tab (regression check)', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/agent'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-agent',
      tabs: [
        {
          id: 'agent-1',
          type: 'agent',
          agentKind: 'claude',
          label: 'Claude',
          sessionId: 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
        }
      ],
      activeTabId: 'agent-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-agent', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('shell')
    expect(cloned.id).toMatch(/^shell-/)
  })

  it('clones a diff source by copying the source tab with a new diff-prefixed id', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/diff'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-diff',
      tabs: [
        {
          id: 'diff-1',
          type: 'diff',
          label: 'src/foo.ts',
          filePath: 'src/foo.ts',
          staged: false
        }
      ],
      activeTabId: 'diff-1'
    })

    const newPane = fsm.splitPane(wtPath, 'pane-diff', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('diff')
    expect(cloned.id).toMatch(/^diff-/)
    expect(cloned.id).not.toBe('diff-1')
    expect(cloned.filePath).toBe('src/foo.ts')
  })

  it('clones json-claude tab without adding runtime metadata', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/json-runtime'
    const sourceTabId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    const sourceTab: TerminalTab = {
      id: sourceTabId,
      type: 'json-claude',
      label: 'Chat',
      sessionId: sourceTabId,
      mode: 'awake'
    }
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [sourceTab],
      activeTabId: sourceTabId
    })

    const newPane = fsm.splitPane(wtPath, 'pane-source', 'horizontal')
    const cloned = newPane!.tabs[0]
    expect(cloned.type).toBe('json-claude')
    expect('runtime' in cloned).toBe(false)
  })

  it('wraps the source pane in a split node containing both children', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/split'
    const sourceTabId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-source',
      tabs: [
        {
          id: sourceTabId,
          type: 'json-claude',
          label: 'Chat',
          sessionId: sourceTabId,
          mode: 'awake'
        }
      ],
      activeTabId: sourceTabId
    })

    fsm.splitPane(wtPath, 'pane-source', 'vertical')
    const tree = store.getSnapshot().state.terminals.panes[wtPath] as PaneNode
    expect(tree.type).toBe('split')
    if (tree.type === 'split') {
      expect(tree.direction).toBe('vertical')
      expect(tree.children).toHaveLength(2)
      expect(tree.children[0].id).toBe('pane-source')
    }
  })
})

describe('PanesFSM.ensureInitialized', () => {
  it('does not create a default json-claude tab unless json mode is selected', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/default-runtime'
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeUndefined()
  })

  it('creates a json-claude tab with no runtime metadata when json mode is selected', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultClaudeTabType: () => 'json'
    })
    const wtPath = '/wt/acp-runtime'
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeDefined()
    expect('runtime' in chatTab!).toBe(false)
  })
})

describe('PanesFSM.convertTabType', () => {
  it('converts agent → json-claude without runtime metadata', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/convert-default'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude', sessionId: 'sess-1' }
      ],
      activeTabId: 'agent-1'
    })

    fsm.convertTabType(wtPath, 'agent-1', 'json-claude')

    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('json-claude')
    expect('runtime' in tab).toBe(false)
  })

  it('converts json-claude → agent without preserving runtime metadata', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/roundtrip'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake' }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('agent')
    expect('runtime' in tab).toBe(false)
  })

  it('round-trips json-claude → agent → json-claude without runtime metadata', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/full-roundtrip'
    const sessionId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake' }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')
    const afterAgent = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const agentTabId = afterAgent.tabs[0].id

    fsm.convertTabType(wtPath, agentTabId, 'json-claude')
    const afterJson = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const tab = afterJson.tabs[0]
    expect(tab.type).toBe('json-claude')
    expect('runtime' in tab).toBe(false)
  })
})

describe('PanesFSM.restoreFromConfig', () => {
  it('hydrates persisted shell and json-claude tabs as asleep, agent tabs as awake', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            { id: 'sh-1', type: 'shell', label: 'Shell' },
            { id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude' },
            {
              id: 'chat-1',
              type: 'json-claude',
              label: 'Chat',
              sessionId: 'chat-1'
            }
          ],
          activeTabId: 'sh-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    expect(tree?.type).toBe('leaf')
    const leaf = tree as PaneLeaf
    const shellTab = leaf.tabs.find((t) => t.id === 'sh-1')
    const agentTab = leaf.tabs.find((t) => t.id === 'agent-1')
    const chatTab = leaf.tabs.find((t) => t.id === 'chat-1')
    expect(shellTab?.mode).toBe('asleep')
    expect(agentTab?.mode).toBeUndefined()
    expect(chatTab?.mode).toBe('asleep')
  })

  it('drops persisted runtime on hydrated json-claude tabs', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore-runtime'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [
            {
              id: 'chat-1',
              type: 'json-claude',
              label: 'Chat',
              sessionId: 'chat-1'
            }
          ],
          activeTabId: 'chat-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.id === 'chat-1')
    expect(chatTab && 'runtime' in chatTab).toBe(false)
  })
})

describe('PanesFSM.addTab', () => {
  it('adopts a sleeping tree instead of replacing it', async () => {
    const persisted: Record<string, PaneNode>[] = []
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: (p) => persisted.push(p),
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/sleeping'
    await fsm.restoreFromConfig({
      _ignored: {
        [wtPath]: {
          type: 'leaf',
          id: 'pane-1',
          tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }],
          activeTabId: 'sh-1'
        }
      }
    })
    fsm.addTab(wtPath, { id: 'sh-2', type: 'shell', label: 'Shell 2' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.id).toBe('pane-1')
    expect(leaf.tabs.map((t) => t.id)).toEqual(['sh-1', 'sh-2'])
    const saved = persisted[persisted.length - 1][wtPath] as PaneLeaf
    expect(saved.tabs.map((t) => t.id)).toEqual(['sh-1', 'sh-2'])
  })

  it('falls back to the first pane when paneId does not exist', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/missing-pane'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }],
      activeTabId: 'sh-1'
    })
    fsm.addTab(wtPath, { id: 'sh-2', type: 'shell', label: 'Shell 2' }, 'pane-gone')
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.map((t) => t.id)).toEqual(['sh-1', 'sh-2'])
  })
})

describe('PanesFSM main-side agent start', () => {
  const WORKTREE = { repoRoot: '/r/repo', branch: 'feat' }
  const agentTab = (id: string): TerminalTab => ({
    id,
    type: 'agent',
    agentKind: 'claude',
    label: 'Claude',
    sessionId: `${id}-session`
  })

  describe('opt-in start (TEST-015)', () => {
    it('ensureInitialized with fromMain starts the new agent tab once, after it is in the slice', () => {
      const wtPath = '/wt/from-main'
      const inSliceAtCall: boolean[] = []
      const store = new Store()
      const startAgentTab = startSpy().mockImplementation((wt, tab) => {
        inSliceAtCall.push(allTabs(store, wt).some((t) => t.id === tab.id))
      })
      const { fsm } = buildFSM({ startAgentTab }, store)

      fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'go', worktree: WORKTREE })

      expect(startAgentTab).toHaveBeenCalledTimes(1)
      const [calledWt, calledTab, calledWorktree] = startAgentTab.mock.calls[0]
      expect(calledWt).toBe(wtPath)
      expect(calledTab.type).toBe('agent')
      expect(calledTab.initialPrompt).toBe('go')
      expect(calledWorktree).toEqual(WORKTREE)
      expect(allTabs(store, wtPath).find((t) => t.type === 'agent')?.id).toBe(calledTab.id)
      expect(inSliceAtCall).toEqual([true])
    })

    it('ensureInitialized without fromMain does not start the agent tab', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      fsm.ensureInitialized('/wt/ui', { initialPrompt: 'go', worktree: WORKTREE })
      expect(allTabs(store, '/wt/ui').some((t) => t.type === 'agent')).toBe(true)
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it('addTab with fromMain starts an agent tab committed as a new leaf', () => {
      const wtPath = '/wt/add-empty'
      const inSliceAtCall: boolean[] = []
      const store = new Store()
      const startAgentTab = startSpy().mockImplementation((wt, tab) => {
        inSliceAtCall.push(allTabs(store, wt).some((t) => t.id === tab.id))
      })
      const { fsm } = buildFSM({ startAgentTab }, store)

      fsm.addTab(wtPath, agentTab('agent-new'), undefined, { fromMain: true })

      expect(startAgentTab).toHaveBeenCalledTimes(1)
      expect(startAgentTab.mock.calls[0][0]).toBe(wtPath)
      expect(startAgentTab.mock.calls[0][1].id).toBe('agent-new')
      expect(inSliceAtCall).toEqual([true])
    })

    it('addTab with fromMain starts an agent tab appended to an existing pane', () => {
      const wtPath = '/wt/add-append'
      const inSliceAtCall: boolean[] = []
      const store = new Store()
      const startAgentTab = startSpy().mockImplementation((wt, tab) => {
        inSliceAtCall.push(allTabs(store, wt).some((t) => t.id === tab.id))
      })
      const { fsm } = buildFSM({ startAgentTab }, store)
      seedLeaf(store, wtPath, {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: 'sh-1', type: 'shell', label: 'Shell' }],
        activeTabId: 'sh-1'
      })

      fsm.addTab(wtPath, agentTab('agent-new'), undefined, { fromMain: true })

      expect(startAgentTab).toHaveBeenCalledTimes(1)
      expect(startAgentTab.mock.calls[0][1].id).toBe('agent-new')
      expect(inSliceAtCall).toEqual([true])
    })

    it('addTab without fromMain does not start the agent tab', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/add-ui'
      fsm.addTab(wtPath, agentTab('agent-a'))
      fsm.addTab(wtPath, agentTab('agent-b'), undefined, {})
      expect(allTabs(store, wtPath).map((t) => t.id)).toEqual(['agent-a', 'agent-b'])
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it.each<{ name: string; tab: TerminalTab }>([
      { name: 'shell', tab: { id: 'sh-new', type: 'shell', label: 'Shell' } },
      { name: 'browser', tab: { id: 'br-new', type: 'browser', label: 'Browser', url: 'https://x' } }
    ])('addTab of a $name tab with fromMain does not start anything', ({ tab }) => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      fsm.addTab('/wt/non-agent', tab, undefined, { fromMain: true })
      expect(allTabs(store, '/wt/non-agent').map((t) => t.id)).toEqual([tab.id])
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it('restartAgentTab does not start the restarted agent tab', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/restart'
      seedLeaf(store, wtPath, {
        type: 'leaf',
        id: 'pane-1',
        tabs: [agentTab('agent-1')],
        activeTabId: 'agent-1'
      })
      fsm.restartAgentTab(wtPath, 'agent-1', 'agent-2')
      expect(allTabs(store, wtPath).map((t) => t.id)).toEqual(['agent-2'])
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it('convertTabType to agent does not start the converted tab', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/convert'
      const sessionId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
      seedLeaf(store, wtPath, {
        type: 'leaf',
        id: 'pane-1',
        tabs: [{ id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake' }],
        activeTabId: sessionId
      })
      fsm.convertTabType(wtPath, sessionId, 'agent')
      expect(allTabs(store, wtPath).map((t) => t.type)).toEqual(['agent'])
      expect(startAgentTab).not.toHaveBeenCalled()
    })
  })

  describe('double start is harmless (TEST-015b)', () => {
    function buildWithSpawner() {
      const store = new Store()
      const running = new Set<string>()
      const create = vi.fn((id: string) => {
        running.add(id)
        return true
      })
      const pty: AgentSpawnerDeps['pty'] = {
        hasTerminal: (id: string) => running.has(id),
        create: create as unknown as AgentSpawnerDeps['pty']['create'],
        getHistory: () => ''
      }
      const buildSpawnArgs = vi.fn((_opts: AgentSpawnOpts) => 'AGENT_CMD')
      const spawner = createAgentSpawner({
        pty,
        store,
        getConfig: () => ({}),
        writeMcpConfig: () => '/mcp.json',
        mcpServerSpec: (configPath) => ({ command: '/bin/el', args: ['/r/b.js', '--config', configPath], env: {} }),
        getAgent: () => ({ defaultCommand: 'claude', buildSpawnArgs }) as unknown as AgentModule
      })
      const outcomes: string[] = []
      const startAgentTab: NonNullable<PanesFSMOptions['startAgentTab']> = (wtPath, tab) => {
        outcomes.push(
          spawner.spawnAgentTerminal({
            terminalId: tab.id,
            cwd: wtPath,
            agentKind: tab.agentKind ?? 'claude'
          })
        )
      }
      const { fsm } = buildFSM({ startAgentTab }, store)
      return { fsm, store, create, buildSpawnArgs, outcomes, startAgentTab }
    }

    it('a second ensureInitialized for the same worktree spawns no second PTY', () => {
      const { fsm, create, buildSpawnArgs, outcomes } = buildWithSpawner()
      const wtPath = '/wt/double-init'
      fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'go', worktree: WORKTREE })
      fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'go', worktree: WORKTREE })
      expect(outcomes).toEqual(['spawned'])
      expect(create).toHaveBeenCalledTimes(1)
      expect(buildSpawnArgs).toHaveBeenCalledTimes(1)
    })

    it('starting the same agent tab twice attaches the second time instead of spawning', () => {
      const { fsm, store, create, buildSpawnArgs, outcomes, startAgentTab } = buildWithSpawner()
      const wtPath = '/wt/double-start'
      fsm.addTab(wtPath, agentTab('agent-twice'), undefined, { fromMain: true })
      const tab = allTabs(store, wtPath).find((t) => t.id === 'agent-twice')!
      startAgentTab(wtPath, tab)
      expect(outcomes).toEqual(['spawned', 'attached'])
      expect(create).toHaveBeenCalledTimes(1)
      expect(buildSpawnArgs).toHaveBeenCalledTimes(1)
    })
  })

  describe('restored tabs do not start (TEST-016)', () => {
    const persistedAgent = (wtPath: string) => ({
      _ignored: {
        [wtPath]: {
          type: 'leaf' as const,
          id: 'pane-restored',
          tabs: [
            {
              id: 'agent-restored',
              type: 'agent' as const,
              label: 'Claude',
              agentKind: 'claude' as const,
              sessionId: 'restored-session'
            }
          ],
          activeTabId: 'agent-restored'
        }
      }
    })

    it('boot-style ensureInitialized without opts creates the default tabs and starts nothing', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      fsm.ensureInitialized('/wt/boot')
      expect(allTabs(store, '/wt/boot').map((t) => t.type)).toEqual(['agent', 'shell'])
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it('ensureInitialized with fromMain promotes a sleeping tree without starting its agent tab', async () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/restored-init'
      await fsm.restoreFromConfig(persistedAgent(wtPath))

      fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'x' })

      expect(allTabs(store, wtPath).map((t) => t.id)).toEqual(['agent-restored'])
      expect(startAgentTab).not.toHaveBeenCalled()
    })

    it('addTab adopts a sleeping tree without starting its agent tab, and fromMain starts only the new tab', async () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/restored-add'
      await fsm.restoreFromConfig(persistedAgent(wtPath))

      fsm.addTab(wtPath, { id: 'sh-new', type: 'shell', label: 'Shell' })
      expect(allTabs(store, wtPath).map((t) => t.id)).toEqual(['agent-restored', 'sh-new'])
      expect(startAgentTab).not.toHaveBeenCalled()

      fsm.addTab(wtPath, agentTab('agent-new'), undefined, { fromMain: true })
      expect(startAgentTab).toHaveBeenCalledTimes(1)
      expect(startAgentTab.mock.calls[0][1].id).toBe('agent-new')
    })
  })

  describe('json default (TEST-017)', () => {
    it('ensureInitialized with fromMain starts the json-claude session with the prompt, not an agent PTY', () => {
      const startAgentTab = startSpy()
      const startJsonClaudeWithPrompt =
        vi.fn<NonNullable<PanesFSMOptions['startJsonClaudeWithPrompt']>>()
      const { fsm, store } = buildFSM({
        startAgentTab,
        startJsonClaudeWithPrompt,
        getDefaultClaudeTabType: () => 'json'
      })
      const wtPath = '/wt/json-default'

      fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'x' })

      const chat = allTabs(store, wtPath).find((t) => t.type === 'json-claude')!
      expect(startJsonClaudeWithPrompt.mock.calls).toEqual([[chat.id, wtPath, 'x']])
      expect(startAgentTab).not.toHaveBeenCalled()
    })
  })

  describe('no double start (TEST-022)', () => {
    it('a later ensureInitialized without opts returns the same tree and does not start again', () => {
      const startAgentTab = startSpy()
      const { fsm, store } = buildFSM({ startAgentTab })
      const wtPath = '/wt/no-double'

      const first = fsm.ensureInitialized(wtPath, { fromMain: true, initialPrompt: 'go' })
      const panesBefore = store.getSnapshot().state.terminals.panes
      const second = fsm.ensureInitialized(wtPath)

      expect(second).toBe(first)
      expect(store.getSnapshot().state.terminals.panes).toBe(panesBefore)
      expect(startAgentTab).toHaveBeenCalledTimes(1)
    })
  })
})
