import type { AgentKind } from '../../shared/state/terminals'
export interface BrowserTabSummary {
  id: string
  url: string
  title: string
}

export interface BrowserQueries {
  listTabsForWorktree: (worktreePath: string) => BrowserTabSummary[]
  getTabWorktree: (tabId: string) => string | null
  getTabUrl: (tabId: string) => string | null
  getTabConsoleLogs: (
    tabId: string
  ) => Array<{ ts: number; level: string; message: string }>
  screenshotTab: (
    tabId: string,
    opts?: { format?: 'jpeg' | 'png'; quality?: number }
  ) => Promise<{ data: string; format: 'jpeg' | 'png' } | null>
  getTabDom: (tabId: string) => Promise<string | null>
  getTabClickables: (tabId: string) => Promise<unknown | null>
  navigateTab: (tabId: string, url: string) => void
  backTab: (tabId: string) => void
  forwardTab: (tabId: string) => void
  reloadTab: (tabId: string) => void
  createTab: (worktreePath: string, url: string) => { id: string; url: string }
  clickTab: (
    tabId: string,
    x: number,
    y: number,
    options?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
  ) => void
  typeTab: (tabId: string, text: string, key?: string) => void
  scrollTab: (tabId: string, deltaX: number, deltaY: number) => Promise<void>
  showCursor: (tabId: string, x: number, y: number) => Promise<void>
}

export interface ShellTabSummary {
  id: string
  label: string
  command?: string
  cwd?: string
  alive: boolean
}

export interface ReadShellOutputOptions {
  lines: number
  match?: string
  context?: number
}

export interface ShellQueries {
  listShellsForWorktree: (worktreePath: string) => ShellTabSummary[]
  getShellWorktree: (shellId: string) => string | null
  readShellOutput: (
    shellId: string,
    opts: ReadShellOutputOptions
  ) => { output: string; matchCount?: number; error?: string }
  createShell: (
    worktreePath: string,
    opts: { command?: string; cwd?: string; label?: string }
  ) => { id: string; label: string }
  killShell: (shellId: string) => void
}

export interface CallerScope {
  terminalId: string
  worktreePath: string
  repoRoot: string
  isMain: boolean
}

export interface BrowserPerms {
  enabled: boolean
  mode: 'view' | 'full'
}

export interface ControlServerDeps {
  getRepoRoots: () => string[]
  getWorktreeBase: () => 'remote' | 'local'
  getPrReviewPrompt: () => string
  broadcast: (channel: string, ...args: unknown[]) => void
  runWorktreeSetup: (ctx: { repoRoot: string; worktreePath: string; branch: string }) => Promise<void>
  runPendingPRWorktree: (params: {
    id: string
    repoRoot: string
    prNumber: number
    initialPrompt?: string
    agentKind?: AgentKind
    model?: string
  }) => Promise<{ ok: true; path: string; branch: string } | { ok: false; error: string }>
  resolveCallerScope: (terminalId: string) => CallerScope | null
  getBrowserPerms: () => BrowserPerms
  browser: BrowserQueries
  shell: ShellQueries
}