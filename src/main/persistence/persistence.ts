import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { userDataDir } from '../paths'
import {
  runMigrations,
  SCHEMA_VERSION,
  type AnyConfig
} from '../persistence-migrations'
import type { Config } from './types'
import {
  LOCAL_BACKEND_ID,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE
} from './constants'

export type { Config, QuestStep, BackendConnection, PersistedPane, PersistedPaneNode, PersistedTab } from './types'
export {
  LOCAL_BACKEND_ID,
  DEFAULT_WORKTREE_BASE,
  DEFAULT_MERGE_STRATEGY,
  DEFAULT_WORKTREE_DETAIL,
  AVAILABLE_THEMES,
  THEME_APP_BG,
  DEFAULT_CLAUDE_COMMAND,
  DEFAULT_HARNESS_SYSTEM_PROMPT,
  DEFAULT_HARNESS_SYSTEM_PROMPT_MAIN,
  DEFAULT_TERMINAL_FONT_FAMILY,
  DEFAULT_TERMINAL_FONT_SIZE
} from './constants'

const DEFAULT_CONFIG: Config = {
  schemaVersion: 0,
  windowBounds: null,
  repoRoots: []
}

function getConfigPath(): string {
  return join(userDataDir(), 'config.json')
}

export function loadConfig(): Config {
  let config: Config
  try {
    const data = readFileSync(getConfigPath(), 'utf-8')
    const parsed = JSON.parse(data) as AnyConfig
    runMigrations(parsed)
    config = { ...DEFAULT_CONFIG, ...(parsed as Partial<Config>), schemaVersion: SCHEMA_VERSION }
  } catch {
    config = { ...DEFAULT_CONFIG, schemaVersion: SCHEMA_VERSION }
  }
  return applyConnectionDefaults(config)
}

export function applyConnectionDefaults(config: Config, now: number = Date.now()): Config {
  const next: Config = { ...config }
  if (!next.connections || next.connections.length === 0) {
    next.connections = [
      {
        id: LOCAL_BACKEND_ID,
        label: 'Local',
        url: '',
        kind: 'local',
        addedAt: now
      }
    ]
  }
  if (!next.activeBackendId) {
    next.activeBackendId = LOCAL_BACKEND_ID
  }
  return next
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

export function saveConfig(config: Config): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    try {
      writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
    } catch (e) {
      console.error('Failed to save config:', e)
    }
  }, 500)
}

export function saveConfigSync(config: Config): void {
  try {
    writeFileSync(getConfigPath(), JSON.stringify(config, null, 2))
  } catch (e) {
    console.error('Failed to save config:', e)
  }
}

function getHistoryDir(): string {
  const dir = join(userDataDir(), 'terminal-history')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function historyPath(id: string): string {
  return join(getHistoryDir(), `${sanitizeId(id)}.txt`)
}

export function saveTerminalHistory(id: string, content: string): void {
  try {
    writeFileSync(historyPath(id), content)
  } catch (e) {
    console.error('Failed to save terminal history:', e)
  }
}

export function loadTerminalHistory(id: string): string | null {
  try {
    return readFileSync(historyPath(id), 'utf-8')
  } catch {
    return null
  }
}

export function clearTerminalHistory(id: string): void {
  try {
    unlinkSync(historyPath(id))
  } catch {
    // ignore missing file
  }
}

export function pruneTerminalHistory(keepIds: Set<string>): void {
  try {
    const dir = getHistoryDir()
    const keep = new Set(Array.from(keepIds).map((id) => `${sanitizeId(id)}.txt`))
    for (const file of readdirSync(dir)) {
      if (!keep.has(file)) {
        try { unlinkSync(join(dir, file)) } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}
