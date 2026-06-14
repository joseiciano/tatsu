export type PtyStatus = 'idle' | 'processing' | 'waiting' | 'needs-approval'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

export interface ShellActivity {
  active: boolean
  processName?: string
}

/** OSC 9;4 progress state, mirrored from @xterm/addon-progress.
 *  state: 0 = none, 1 = normal, 2 = error, 3 = indeterminate, 4 = paused/warning. */
export interface TerminalProgress {
  state: 0 | 1 | 2 | 3 | 4
  value: number
}

export type AgentKind = 'claude' | 'codex' | 'opencode'

export interface TerminalTab {
  id: string
  type: 'agent' | 'shell' | 'diff' | 'file' | 'browser' | 'json-claude'
  label: string
  /** User-defined override for `label`. When set (non-empty after trim),
   *  the tab renders this instead of the auto-derived label. Cleared
   *  with an empty string via terminals/tabRenamed — the reducer drops
   *  the field rather than persisting "". */
  customLabel?: string
  /** Meaningful for json-claude and shell tabs. 'asleep' means no live
   *  subprocess; the tab still exists in the tree and its session
   *  history (in the jsonClaude slice + on-disk jsonl for json-claude,
   *  scrollback file for shell) is intact. Persisted tabs of both types
   *  hydrate as 'asleep' so app launch doesn't construct an xterm or
   *  spawn a subprocess per tab; they wake on first focus. */
  mode?: 'awake' | 'asleep'
  /** For agent tabs: which CLI agent this tab runs. */
  agentKind?: AgentKind
  /** For agent + json-claude tabs: override the model resolved from
   *  settings (claudeModel/codexModel). Set when a worktree was spawned
   *  with a one-shot pick (New Worktree screen "Model" field or the MCP
   *  create_worktree `model` param). Empty/undefined = use settings. */
  model?: string
  /** For diff/file tabs: the file path */
  filePath?: string
  /** For diff tabs: whether the diff is for staged changes */
  staged?: boolean
  /** For diff tabs: show the branch diff (base...HEAD) instead of working-tree diff */
  branchDiff?: boolean
  /** For diff tabs: when set, show this commit's full diff instead of a file diff */
  commitHash?: string
  /** For agent tabs: UUID passed to the agent CLI so the tab resumes its own session. */
  sessionId?: string
  /** For agent tabs: one-shot kickoff prompt. In-memory only — main strips it before persistence. */
  initialPrompt?: string
  /** For agent tabs: one-shot teleport session id. In-memory only — main strips it before persistence. */
  teleportSessionId?: string
  /** For browser tabs: the URL currently loaded (restored on reload). */
  url?: string
  /** For shell tabs: command to run via `zsh -ilc <command>` instead of
   * spawning an interactive login shell. Set by agents via the shell MCP. */
  command?: string
  /** For shell tabs: directory to run in. Relative paths resolve against the
   * worktree root; absolute paths are used as-is. */
  cwd?: string
}

// ---------------------------------------------------------------------------
// Pane tree types — the layout is a binary tree where leaves hold tabs and
// split nodes define a direction + ratio for their two children.
// ---------------------------------------------------------------------------

export type SplitDirection = 'horizontal' | 'vertical'

export interface PaneLeaf {
  type: 'leaf'
  id: string
  tabs: TerminalTab[]
  activeTabId: string
}

export interface PaneSplit {
  type: 'split'
  id: string
  direction: SplitDirection
  children: [PaneNode, PaneNode]
  ratio: number
}

export type PaneNode = PaneLeaf | PaneSplit

/** Backwards-compat alias — some call sites still reference the old name. */
export type WorkspacePane = PaneLeaf

/** Tmux-style session state for a single xterm-backed terminal: exactly
 *  one client (if any) holds control — their viewport sizes the PTY and
 *  their keystrokes are forwarded — while everyone else watches the same
 *  rendered byte stream as spectators. JSON-mode agent tabs re-render
 *  per client and don't need this; they're intentionally not tracked. */
export interface TerminalSession {
  /** Server-assigned clientId of the current controller, or null if the
   *  controller disconnected and nobody has clicked "take control" yet. */
  controllerClientId: string | null
  /** ClientIds currently watching this terminal read-only. Order is the
   *  order they joined; the UI uses it as a stable sort for the chip. */
  spectatorClientIds: string[]
  /** Last-applied grid dimensions, set whenever the current controller
   *  issues a resize (either via pty:resize or terminal:takeControl).
   *  Null until the first resize — new joiners see the PTY's spawn-time
   *  dimensions until somebody takes control and sets real dims. */
  size: { cols: number; rows: number } | null
}

export interface TerminalsState {
  /** PTY status per terminal id. */
  statuses: Record<string, PtyStatus>
  /** Only meaningful when status is 'needs-approval'; null otherwise. */
  pendingTools: Record<string, PendingTool | null>
  /** Per-terminal foreground-process indicator for shell tabs. */
  shellActivity: Record<string, ShellActivity>
  /** Per-terminal OSC 9;4 progress, dispatched from the controller's
   *  ProgressAddon. Absent entries mean no active progress. */
  progress: Record<string, TerminalProgress>
  /** Pane layout tree per worktree path. Authored entirely in main via the
   * panes-fsm methods. */
  panes: Record<string, PaneNode>
  /** Per-worktree most-recent-activity timestamp (ms since epoch). Used by
   * the sidebar for recency sort. Updated by the activity-deriver in main
   * whenever a contained terminal changes status. */
  lastActive: Record<string, number>
  /** Controller + spectator roster per xterm-backed terminal id. Entries
   *  are created lazily on the first join (or on pty:create) and deleted
   *  when the last client leaves. See the `controlTaken` reducer cases
   *  for the exact transitions. */
  sessions: Record<string, TerminalSession>
}

export type TerminalsEvent =
  | {
      type: 'terminals/statusChanged'
      payload: { id: string; status: PtyStatus; pendingTool: PendingTool | null }
    }
  | {
      type: 'terminals/shellActivityChanged'
      payload: { id: string; active: boolean; processName?: string }
    }
  | {
      type: 'terminals/progressChanged'
      payload: { id: string; state: 0 | 1 | 2 | 3 | 4; value: number }
    }
  | { type: 'terminals/removed'; payload: string }
  | {
      type: 'terminals/panesReplaced'
      payload: Record<string, PaneNode>
    }
  | {
      type: 'terminals/panesForWorktreeChanged'
      payload: { worktreePath: string; panes: PaneNode }
    }
  | {
      type: 'terminals/panesForWorktreeCleared'
      payload: string
    }
  | {
      type: 'terminals/lastActiveChanged'
      payload: { worktreePath: string; ts: number }
    }
  | {
      type: 'terminals/paneRatioChanged'
      payload: { worktreePath: string; splitId: string; ratio: number }
    }
  | {
      type: 'terminals/sessionIdDiscovered'
      payload: { terminalId: string; sessionId: string }
    }
  | {
      type: 'terminals/controlTaken'
      payload: { terminalId: string; clientId: string; cols: number; rows: number }
    }
  | {
      type: 'terminals/controlReleased'
      payload: { terminalId: string; clientId: string }
    }
  | {
      type: 'terminals/clientJoined'
      payload: { terminalId: string; clientId: string }
    }
  | {
      type: 'terminals/clientDisconnected'
      payload: { clientId: string }
    }
  | {
      type: 'terminals/sizeChanged'
      payload: { terminalId: string; cols: number; rows: number }
    }
  | {
      type: 'terminals/tabTypeChanged'
      payload: {
        worktreePath: string
        tabId: string
        newId: string
        newType: 'agent' | 'json-claude'
        newLabel: string
      }
    }
  | {
      type: 'terminals/tabSlept'
      payload: { worktreePath: string; tabId: string }
    }
  | {
      type: 'terminals/tabWoken'
      payload: { worktreePath: string; tabId: string }
    }
  | {
      type: 'terminals/tabRenamed'
      payload: { worktreePath: string; tabId: string; label: string }
    }
