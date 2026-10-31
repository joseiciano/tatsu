import { describe, it, expect, vi } from 'vitest'
import { Store } from '../store'
import { PanesFSM } from '.'
import type { PaneLeaf, PaneNode, TerminalTab } from '../../shared/state/terminals'

vi.mock('../perf-log', () => ({
  perfLog: vi.fn(),
  getPerfLogFilePath: vi.fn(() => '/tmp/perf.log')
}))

vi.mock('../debug', () => ({
  log: vi.fn()
}))

function buildFSM(): { fsm: PanesFSM; store: Store } {
  const store = new Store()
  const fsm = new PanesFSM(store, {
    persist: () => {},
    getRepoRootForWorktree: () => undefined,
    getLatestClaudeSessionId: async () => null
  })
  return { fsm, store }
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
    expect(cloned.agentKind).toBe('claude')
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
      getDefaultTabType: () => 'json'
    })
    const wtPath = '/wt/acp-runtime'
    fsm.ensureInitialized(wtPath)
    const tree = store.getSnapshot().state.terminals.panes[wtPath]
    const leaf = tree as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeDefined()
    expect('runtime' in chatTab!).toBe(false)
    expect(chatTab!.agentKind).toBe('claude')
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
    expect(tab.agentKind).toBe('claude')
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

  it('converts opencode agent → json-claude preserving agentKind', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/convert-opencode'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'agent-1', type: 'agent', label: 'Opencode', agentKind: 'opencode', sessionId: 'sess-1' }
      ],
      activeTabId: 'agent-1'
    })

    fsm.convertTabType(wtPath, 'agent-1', 'json-claude')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('json-claude')
    expect(tab.agentKind).toBe('opencode')
    expect('runtime' in tab).toBe(false)
  })

  it('converts json-claude → opencode agent preserving agentKind', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/convert-opencode-back'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake', agentKind: 'opencode' }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('agent')
    expect(tab.agentKind).toBe('opencode')
  })

  it('converts codex agent → json-claude preserving agentKind', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/convert-codex'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'agent-1', type: 'agent', label: 'Codex', agentKind: 'codex', sessionId: 'sess-1' }
      ],
      activeTabId: 'agent-1'
    })

    fsm.convertTabType(wtPath, 'agent-1', 'json-claude')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('json-claude')
    expect(tab.agentKind).toBe('codex')
  })

  it('converts json-claude → codex agent preserving agentKind', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/convert-codex-back'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake', agentKind: 'codex' }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const tab = leaf.tabs[0]
    expect(tab.type).toBe('agent')
    expect(tab.agentKind).toBe('codex')
  })

  it('labels a converted agent tab with the agent display name', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/convert-label'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: sessionId, type: 'json-claude', label: 'Chat', sessionId, mode: 'awake', agentKind: 'opencode' }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs[0].label).toBe('Opencode')
  })

  it('leaves a pi agent tab and its PTY untouched when asked to convert to json-claude', () => {
    const store = new Store()
    const killTabPty = vi.fn()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      killTabPty
    })
    const wtPath = '/wt/convert-pi'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-pi', type: 'agent', label: 'Pi', agentKind: 'pi' }],
      activeTabId: 'agent-pi'
    })

    fsm.convertTabType(wtPath, 'agent-pi', 'json-claude')

    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs).toHaveLength(1)
    expect(leaf.tabs[0]).toMatchObject({ id: 'agent-pi', type: 'agent', agentKind: 'pi' })
    expect(leaf.activeTabId).toBe('agent-pi')
    expect(killTabPty).not.toHaveBeenCalled()
  })

  it('carries an opencode agent tab sessionId onto the chat tab as agentSessionId', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/acp-to-chat'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-1', type: 'agent', label: 'Opencode', agentKind: 'opencode', sessionId: 'ses_term' }],
      activeTabId: 'agent-1'
    })

    fsm.convertTabType(wtPath, 'agent-1', 'json-claude')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.type).toBe('json-claude')
    expect(tab.agentSessionId).toBe('ses_term')
  })

  it('resumes an opencode chat tab agentSessionId as the terminal sessionId', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/acp-to-terminal'
    const sessionId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        {
          id: sessionId,
          type: 'json-claude',
          label: 'Chat',
          sessionId,
          agentKind: 'opencode',
          agentSessionId: 'ses_chat',
          mode: 'awake'
        }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.type).toBe('agent')
    expect(tab.sessionId).toBe('ses_chat')
  })

  it('falls back to the chat tab sessionId when an opencode chat has no agentSessionId', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/acp-to-terminal-fresh'
    const sessionId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: sessionId, type: 'json-claude', label: 'Chat', sessionId, agentKind: 'opencode', mode: 'awake' }],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.sessionId).toBe(sessionId)
  })

  it('round-trips an opencode agentSessionId through chat → terminal → chat', () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/acp-roundtrip'
    const sessionId = 'cccccccc-cccc-4ccc-cccc-cccccccccccc'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        {
          id: sessionId,
          type: 'json-claude',
          label: 'Chat',
          sessionId,
          agentKind: 'opencode',
          agentSessionId: 'ses_keep',
          mode: 'awake'
        }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')
    const agentTabId = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0].id
    fsm.convertTabType(wtPath, agentTabId, 'json-claude')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.type).toBe('json-claude')
    expect(tab.agentSessionId).toBe('ses_keep')
  })

  it('never carries an agentSessionId across a claude conversion', () => {
    const { fsm, store } = buildFSM()
    const toChatPath = '/wt/claude-to-chat'
    seedLeaf(store, toChatPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-1', type: 'agent', label: 'Claude', agentKind: 'claude', sessionId: 'sess-1' }],
      activeTabId: 'agent-1'
    })
    const toTerminalPath = '/wt/claude-to-terminal'
    const sessionId = 'dddddddd-dddd-4ddd-dddd-dddddddddddd'
    seedLeaf(store, toTerminalPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        {
          id: sessionId,
          type: 'json-claude',
          label: 'Chat',
          sessionId,
          agentKind: 'claude',
          agentSessionId: 'stray',
          mode: 'awake'
        }
      ],
      activeTabId: sessionId
    })

    fsm.convertTabType(toChatPath, 'agent-1', 'json-claude')
    fsm.convertTabType(toTerminalPath, sessionId, 'agent')

    const chatTab = (store.getSnapshot().state.terminals.panes[toChatPath] as PaneLeaf).tabs[0]
    expect('agentSessionId' in chatTab).toBe(false)
    const agentTab = (store.getSnapshot().state.terminals.panes[toTerminalPath] as PaneLeaf).tabs[0]
    expect(agentTab.sessionId).toBe(sessionId)
  })

  it('refuses to convert an opencode agent tab to chat when the release gate is off, but still converts claude', () => {
    const store = new Store()
    const killTabPty = vi.fn()
    const persist = vi.fn()
    const fsm = new PanesFSM(store, {
      persist,
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      chatEnabledFor: (kind) => kind === 'claude',
      killTabPty
    })
    const opencodePath = '/wt/gate-off-opencode'
    seedLeaf(store, opencodePath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-oc', type: 'agent', label: 'Opencode', agentKind: 'opencode', sessionId: 'sess-oc' }],
      activeTabId: 'agent-oc'
    })
    const claudePath = '/wt/gate-off-claude'
    seedLeaf(store, claudePath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-cl', type: 'agent', label: 'Claude', agentKind: 'claude', sessionId: 'sess-cl' }],
      activeTabId: 'agent-cl'
    })

    fsm.convertTabType(opencodePath, 'agent-oc', 'json-claude')

    const opencodeLeaf = store.getSnapshot().state.terminals.panes[opencodePath] as PaneLeaf
    expect(opencodeLeaf.tabs).toHaveLength(1)
    expect(opencodeLeaf.tabs[0]).toMatchObject({ id: 'agent-oc', type: 'agent', agentKind: 'opencode' })
    expect(opencodeLeaf.activeTabId).toBe('agent-oc')
    expect(killTabPty).not.toHaveBeenCalled()
    expect(persist).not.toHaveBeenCalled()

    fsm.convertTabType(claudePath, 'agent-cl', 'json-claude')

    const claudeTab = (store.getSnapshot().state.terminals.panes[claudePath] as PaneLeaf).tabs[0]
    expect(claudeTab).toMatchObject({ type: 'json-claude', agentKind: 'claude' })
  })

  it('converts an opencode agent tab to chat when the release gate is on', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      chatEnabledFor: () => true
    })
    const wtPath = '/wt/gate-on-opencode'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'agent-oc', type: 'agent', label: 'Opencode', agentKind: 'opencode', sessionId: 'sess-oc' }],
      activeTabId: 'agent-oc'
    })

    fsm.convertTabType(wtPath, 'agent-oc', 'json-claude')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab).toMatchObject({ type: 'json-claude', agentKind: 'opencode' })
  })

  it('converts an opencode chat tab back to an agent tab even when the release gate is off', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      chatEnabledFor: () => false
    })
    const wtPath = '/wt/gate-off-chat-to-agent'
    const sessionId = 'eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: sessionId, type: 'json-claude', label: 'Chat', sessionId, agentKind: 'opencode', mode: 'awake' }],
      activeTabId: sessionId
    })

    fsm.convertTabType(wtPath, sessionId, 'agent')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab).toMatchObject({ type: 'agent', agentKind: 'opencode' })
  })
})

describe('PanesFSM.setTabAgentSessionId', () => {
  it('records the agent session id on the tab and persists the updated panes', () => {
    const store = new Store()
    const persisted: Record<string, PaneNode>[] = []
    const fsm = new PanesFSM(store, {
      persist: (panes) => persisted.push(panes),
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/set-agent-session'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'chat-1', type: 'json-claude', label: 'Chat', sessionId: 'chat-1', agentKind: 'opencode' }],
      activeTabId: 'chat-1'
    })

    fsm.setTabAgentSessionId(wtPath, 'chat-1', 'ses_new')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.agentSessionId).toBe('ses_new')
    const last = persisted.at(-1)?.[wtPath] as PaneLeaf | undefined
    expect(last?.tabs[0].agentSessionId).toBe('ses_new')
  })

  it('does not persist when the tab is unknown', () => {
    const store = new Store()
    const persist = vi.fn()
    const fsm = new PanesFSM(store, {
      persist,
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/set-agent-session-missing'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'chat-1', type: 'json-claude', label: 'Chat', sessionId: 'chat-1', agentKind: 'opencode' }],
      activeTabId: 'chat-1'
    })

    fsm.setTabAgentSessionId(wtPath, 'missing', 'ses_new')
    fsm.setTabAgentSessionId('/wt/unknown', 'chat-1', 'ses_new')

    expect(persist).not.toHaveBeenCalled()
  })
})

describe('PanesFSM.setTabLabel', () => {
  it('sets the tab label, keeps a user rename, and persists the updated panes', () => {
    const store = new Store()
    const persisted: Record<string, PaneNode>[] = []
    const fsm = new PanesFSM(store, {
      persist: (panes) => persisted.push(panes),
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/set-label'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [
        { id: 'chat-1', type: 'json-claude', label: 'Chat', customLabel: 'Mine', sessionId: 'chat-1', agentKind: 'opencode' }
      ],
      activeTabId: 'chat-1'
    })

    fsm.setTabLabel(wtPath, 'chat-1', 'Fix the parser')

    const tab = (store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf).tabs[0]
    expect(tab.label).toBe('Fix the parser')
    expect(tab.customLabel).toBe('Mine')
    const last = persisted.at(-1)?.[wtPath] as PaneLeaf | undefined
    expect(last?.tabs[0].label).toBe('Fix the parser')
  })

  it('does not persist when the tab is unknown', () => {
    const store = new Store()
    const persist = vi.fn()
    const fsm = new PanesFSM(store, {
      persist,
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null
    })
    const wtPath = '/wt/set-label-missing'
    seedLeaf(store, wtPath, {
      type: 'leaf',
      id: 'pane-1',
      tabs: [{ id: 'chat-1', type: 'json-claude', label: 'Chat', sessionId: 'chat-1', agentKind: 'opencode' }],
      activeTabId: 'chat-1'
    })

    fsm.setTabLabel(wtPath, 'missing', 'Fix the parser')
    fsm.setTabLabel('/wt/unknown', 'chat-1', 'Fix the parser')

    expect(persist).not.toHaveBeenCalled()
  })
})

describe('PanesFSM.ensureInitialized per-agent default tab type', () => {
  it('creates a json-claude tab for opencode when its default type is json', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: (kind) => (kind === 'opencode' ? 'json' : 'xterm')
    })
    const wtPath = '/wt/acp-opencode-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'opencode' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeDefined()
    expect(chatTab!.agentKind).toBe('opencode')
  })

  it('creates a json-claude tab for codex when its default type is json', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: (kind) => (kind === 'codex' ? 'json' : 'xterm')
    })
    const wtPath = '/wt/acp-codex-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'codex' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeDefined()
    expect(chatTab!.agentKind).toBe('codex')
  })

  it('does not create a json-claude tab for claude when its default type is xterm', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: (kind) => (kind === 'opencode' ? 'json' : 'xterm')
    })
    const wtPath = '/wt/acp-claude-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'claude' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab).toBeUndefined()
  })

  it('creates an xterm agent tab for pi even when its default type is json', () => {
    const store = new Store()
    const startJsonClaudeWithPrompt = vi.fn()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: () => 'json',
      startJsonClaudeWithPrompt
    })
    const wtPath = '/wt/acp-pi-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'pi', initialPrompt: 'hello pi' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.find((t) => t.type === 'json-claude')).toBeUndefined()
    const agentTab = leaf.tabs.find((t) => t.type === 'agent')
    expect(agentTab).toMatchObject({ agentKind: 'pi', initialPrompt: 'hello pi' })
    expect(leaf.activeTabId).toBe(agentTab!.id)
    expect(startJsonClaudeWithPrompt).not.toHaveBeenCalled()
  })

  it('creates an agent tab for opencode with default type json when the release gate is off', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: () => 'json',
      chatEnabledFor: (kind) => kind === 'claude'
    })
    const wtPath = '/wt/gate-off-opencode-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'opencode' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    expect(leaf.tabs.find((t) => t.type === 'json-claude')).toBeUndefined()
    const agentTab = leaf.tabs.find((t) => t.type === 'agent')
    expect(agentTab?.agentKind).toBe('opencode')
    expect(leaf.activeTabId).toBe(agentTab!.id)
  })

  it('creates a json-claude tab for opencode with default type json when the release gate is on', () => {
    const store = new Store()
    const fsm = new PanesFSM(store, {
      persist: () => {},
      getRepoRootForWorktree: () => undefined,
      getLatestClaudeSessionId: async () => null,
      getDefaultTabType: () => 'json',
      chatEnabledFor: () => true
    })
    const wtPath = '/wt/gate-on-opencode-default'
    fsm.ensureInitialized(wtPath, { agentKind: 'opencode' })
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const chatTab = leaf.tabs.find((t) => t.type === 'json-claude')
    expect(chatTab?.agentKind).toBe('opencode')
    expect(leaf.tabs.find((t) => t.type === 'agent')).toBeUndefined()
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

  it('keeps a persisted agentSessionId on json-claude tabs and adds no key when absent', async () => {
    const { fsm, store } = buildFSM()
    const wtPath = '/wt/restore-agent-session'
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
              agentKind: 'opencode',
              sessionId: 'chat-1',
              agentSessionId: 'ses_saved'
            },
            { id: 'chat-2', type: 'json-claude', label: 'Chat', agentKind: 'opencode', sessionId: 'chat-2' }
          ],
          activeTabId: 'chat-1'
        }
      }
    })
    fsm.ensureInitialized(wtPath)
    const leaf = store.getSnapshot().state.terminals.panes[wtPath] as PaneLeaf
    const withId = leaf.tabs.find((t) => t.id === 'chat-1')
    const withoutId = leaf.tabs.find((t) => t.id === 'chat-2')
    expect(withId?.agentSessionId).toBe('ses_saved')
    expect(withoutId && 'agentSessionId' in withoutId).toBe(false)
  })
})
