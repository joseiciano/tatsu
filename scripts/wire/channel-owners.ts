export type ChannelKind = 'request' | 'signal'
export type Host = 'headless' | 'desktop' | 'desktop-dev'

export type ModuleId =
  | 'core-server'
  | 'headless-web'
  | 'terminals'
  | 'worktrees-git'
  | 'tauri-shell'
  | 'browser'
  | 'harness-config'
  | 'aux-services'
  | 'github'
  | 'chat'
  | 'mcp-control'

export interface ChannelRecord {
  kind: ChannelKind
  name: string
  host: Host
  file: string
}

export interface ChannelEntry {
  name: string
  owner: ModuleId
  headlessOwner?: ModuleId
  devOnly?: true
}

export interface ChannelCatalog {
  requests: ChannelEntry[]
  signals: ChannelEntry[]
}

export const REMOVED_CHANNELS = ['harnessConfig:planAdoptFromDisk', 'harnessConfig:adoptFromDisk']

const PACKAGE_OWNERS: Record<string, ModuleId> = {
  'desktop-shell': 'tauri-shell',
  'harness-config-transport': 'harness-config',
  'harness-config-settings': 'harness-config'
}

const MAIN_ENTRY = 'index.ts'

const MAIN_ENTRY_PREFIXES: Record<string, ModuleId> = {
  activity: 'core-server',
  agent: 'terminals',
  announcements: 'aux-services',
  browser: 'browser',
  config: 'core-server',
  connections: 'core-server',
  debug: 'core-server',
  fs: 'worktrees-git',
  hooks: 'core-server',
  jsonClaude: 'chat',
  panes: 'terminals',
  pr: 'github',
  prs: 'github',
  pty: 'terminals',
  repo: 'worktrees-git',
  repoConfig: 'core-server',
  runtimes: 'chat',
  scratchpad: 'core-server',
  snooze: 'aux-services',
  terminal: 'terminals',
  terminals: 'terminals',
  updater: 'headless-web',
  worktree: 'worktrees-git',
  worktrees: 'worktrees-git'
}

const NAME_OWNERS: Record<string, ModuleId> = {
  'browser:setBounds': 'browser',
  'claude:getAuthStatus': 'chat',
  'config:getAvailableEditors': 'worktrees-git',
  'costs:getAllSessions': 'aux-services',
  'costs:setInterest': 'chat',
  'editor:open': 'worktrees-git',
  'mcp:prepareForTerminal': 'mcp-control',
  'net:getLanAddresses': 'core-server',
  'perf:getMetrics': 'aux-services',
  'perf:logSlowRender': 'core-server',
  'settings:clearGithubToken': 'github',
  'settings:hasGithubToken': 'github',
  'settings:setGithubToken': 'github',
  'settings:setHarnessStarred': 'github',
  'stats:getWeekly': 'aux-services',
  'updater:getVersion': 'core-server'
}

const HEADLESS_FALLBACKS = new Set(['updater:checkForUpdates', 'updater:quitAndInstall'])

function packageOf(file: string): string {
  return file.includes('/') ? file.slice(0, file.indexOf('/')) : file
}

export function ownerOf(record: ChannelRecord): ModuleId {
  const byName = NAME_OWNERS[record.name]
  if (byName) return byName
  const pkg = packageOf(record.file)
  if (pkg === MAIN_ENTRY) {
    const byPrefix = MAIN_ENTRY_PREFIXES[record.name.slice(0, record.name.indexOf(':'))]
    if (byPrefix) return byPrefix
  } else if (PACKAGE_OWNERS[pkg]) {
    return PACKAGE_OWNERS[pkg]
  }
  throw new Error(`no owner for ${record.kind} channel ${record.name} (registered in src/main/${record.file})`)
}

function entryFor(name: string, records: ChannelRecord[]): ChannelEntry {
  const desktop = records.filter((record) => record.host !== 'headless')
  const headless = records.filter((record) => record.host === 'headless')
  const owners = new Set(records.map(ownerOf))
  const devOnly = desktop.length > 0 && headless.length === 0 && desktop.every((record) => record.host === 'desktop-dev')
  const extra = devOnly ? { devOnly: true as const } : {}
  if (owners.size === 1) return { name, owner: [...owners][0], ...extra }

  const desktopOwners = new Set(desktop.map(ownerOf))
  const headlessOwners = new Set(headless.map(ownerOf))
  if (HEADLESS_FALLBACKS.has(name) && desktopOwners.size === 1 && headlessOwners.size === 1) {
    return { name, owner: [...desktopOwners][0], headlessOwner: [...headlessOwners][0], ...extra }
  }
  throw new Error(`conflicting owners for ${name}: ${[...owners].join(', ')}`)
}

function entries(records: ChannelRecord[]): ChannelEntry[] {
  const byName = new Map<string, ChannelRecord[]>()
  for (const record of records) byName.set(record.name, [...(byName.get(record.name) ?? []), record])
  return [...byName.keys()].sort().map((name) => entryFor(name, byName.get(name)!))
}

export function buildCatalog(records: ChannelRecord[]): ChannelCatalog {
  const removed = records.filter((record) => REMOVED_CHANNELS.includes(record.name))
  if (removed.length > 0) {
    throw new Error(`removed channels are registered again: ${removed.map((record) => record.name).join(', ')}`)
  }
  const kinds = new Map<string, Set<ChannelKind>>()
  for (const record of records) kinds.set(record.name, (kinds.get(record.name) ?? new Set()).add(record.kind))
  const mixed = [...kinds].filter(([, set]) => set.size > 1).map(([name]) => name)
  if (mixed.length > 0) throw new Error(`channels registered as both request and signal: ${mixed.join(', ')}`)

  return {
    requests: entries(records.filter((record) => record.kind === 'request')),
    signals: entries(records.filter((record) => record.kind === 'signal'))
  }
}
