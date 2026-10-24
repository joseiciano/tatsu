import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { parse } from 'smol-toml'
import { log } from '../debug'
import { makeHookScript } from '../hooks'
import { resolveCodexHome } from '../folder-trust'
import {
  codexHookIdentityJson,
  readCodexHookTrust,
  type CodexHookGroup,
  type CodexHookHandler,
  type CodexHookTrustReport
} from '../codex-hook-trust'
import type { AgentSpawnOpts, HarnessMcpServerSpec } from './index'

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

// Codex strips unknown fields when it normalizes hooks.json, so dedup
// recognizes our entries by their command text instead of a sidecar
// marker: the script name for current entries, the status-dir path for
// legacy inline `bash -c` entries.
const HARNESS_HOOK_COMMAND_SIGNATURE = '/tmp/harness-status'
const HOOK_SCRIPT_NAME = 'harness-hook.sh'

export const defaultCommand = 'codex'
export const assignsSessionId = false

export const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop'
]

type CodexHookEntry = CodexHookGroup

interface CodexHooksFile {
  hooks?: Record<string, CodexHookEntry[]>
}

export function codexHomeDir(): string {
  return resolveCodexHome(process.env, homedir())
}

function globalHooksPath(): string {
  return join(codexHomeDir(), 'hooks.json')
}

function hookScriptPath(): string {
  return join(codexHomeDir(), HOOK_SCRIPT_NAME)
}

function sessionsDir(): string {
  return join(codexHomeDir(), 'sessions')
}

function codexConfigPath(): string {
  return join(codexHomeDir(), 'config.toml')
}

// Kept byte-stable on purpose: Codex skips a hook until the user trusts it
// in /hooks, keyed on this command's hash.
export function makeCodexHookCommand(event: string): string {
  return `bash ${shellQuote(hookScriptPath())} ${event}`
}

function worktreeHooksPath(worktreePath: string): string {
  return join(worktreePath, '.codex', 'hooks.json')
}

function readHooksFile(path: string): CodexHooksFile {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return {}
  }
}

function readHooksFileStrict(path: string): { ok: true; data: CodexHooksFile; existed: boolean } | { ok: false } {
  if (!existsSync(path)) return { ok: true, data: {}, existed: false }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false }
    return { ok: true, data: parsed as CodexHooksFile, existed: true }
  } catch {
    return { ok: false }
  }
}

function writeHooksFile(path: string, data: CodexHooksFile): void {
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2))
}

function writeHookScript(): void {
  const path = hookScriptPath()
  const content = makeHookScript()
  if (existsSync(path)) {
    try {
      if (readFileSync(path, 'utf-8') === content) return
    } catch {
      // unreadable: rewrite below
    }
  }
  const dir = join(path, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(path, content, { mode: 0o755 })
}

function makeHarnessHookEntry(command: string): CodexHookEntry {
  return {
    hooks: [{ type: 'command', command, timeout: 5 }]
  }
}

function isHarnessHookHandler(h: CodexHookHandler): boolean {
  return (
    typeof h.command === 'string' &&
    (h.command.includes(HOOK_SCRIPT_NAME) || h.command.includes(HARNESS_HOOK_COMMAND_SIGNATURE))
  )
}

function isHarnessHookEntry(entry: CodexHookEntry): boolean {
  return !!entry.hooks?.some(isHarnessHookHandler)
}

function isIdenticalHarnessEntry(event: string, entry: CodexHookEntry, desired: CodexHookEntry): boolean {
  if (!Array.isArray(entry.hooks) || entry.hooks.length !== 1) return false
  return codexHookIdentityJson(event, entry) === codexHookIdentityJson(event, desired)
}

export function codexHookTrustReport(): Promise<CodexHookTrustReport> {
  return readCodexHookTrust({
    hooksPath: globalHooksPath(),
    configPath: codexConfigPath(),
    isOwnedHandler: isHarnessHookHandler
  })
}

function removeOldHarnessEntries(entries: CodexHookEntry[]): CodexHookEntry[] {
  return entries.filter((entry) => !isHarnessHookEntry(entry))
}

function ensureCodexHooksEnabled(): void {
  const configPath = codexConfigPath()
  try {
    const content = existsSync(configPath) ? readFileSync(configPath, 'utf-8') : ''
    let parsed: unknown
    try {
      parsed = parse(content)
    } catch {
      log('hooks', 'codex config.toml unparseable; flag not written')
      return
    }
    const features = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).features : undefined
    if (features && typeof features === 'object' && ('hooks' in features || 'codex_hooks' in features)) return
    const line = 'hooks = true'
    // Appending to EOF would land the key in whichever table comes last,
    // so insert it directly under an existing [features] header.
    const header = /^[ \t]*\[features\][ \t]*(#.*)?$/m.exec(content)
    let next: string
    if (header) {
      const at = header.index + header[0].length
      next = content.slice(0, at) + '\n' + line + content.slice(at)
    } else {
      const sep = content && !content.endsWith('\n') ? '\n' : ''
      next = content + sep + '\n[features]\n' + line + '\n'
    }
    writeFileSync(configPath, next)
    log('hooks', `enabled [features] hooks in ${configPath}`)
  } catch (err) {
    log('hooks', 'failed to enable [features] hooks', err instanceof Error ? err.message : err)
  }
}

export function hooksInstalled(): boolean {
  const data = readHooksFile(globalHooksPath())
  const hooks = data.hooks
  if (!hooks) return false
  for (const entries of Object.values(hooks)) {
    for (const entry of entries) {
      if (isHarnessHookEntry(entry)) return true
    }
  }
  return false
}

export function installHooks(): void {
  const path = globalHooksPath()
  log('hooks', `installing Codex hooks into ${path}`)

  ensureCodexHooksEnabled()
  writeHookScript()

  const read = readHooksFileStrict(path)
  if (!read.ok) {
    log('hooks', 'codex hooks.json unreadable; not modified', { path })
    return
  }
  const data = read.data
  let changed = !read.existed
  if (!data.hooks) {
    data.hooks = {}
    changed = true
  }

  for (const event of Object.keys(data.hooks)) {
    if (hookEvents.includes(event)) continue
    const before = data.hooks[event].length
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length !== before) changed = true
  }

  for (const event of hookEvents) {
    const desired = makeHarnessHookEntry(makeCodexHookCommand(event))
    const arr = data.hooks[event] ?? []
    if (!data.hooks[event]) {
      data.hooks[event] = arr
      changed = true
    }
    const owned = arr.map((entry, j) => (isHarnessHookEntry(entry) ? j : -1)).filter((j) => j !== -1)
    let keep = owned.find((j) => isIdenticalHarnessEntry(event, arr[j], desired))
    if (keep === undefined) {
      if (owned.length > 0) {
        keep = owned[0]
        arr[keep] = desired
      } else {
        arr.push(desired)
        keep = arr.length - 1
      }
      changed = true
    }
    const extras = owned.filter((j) => j !== keep)
    if (extras.length > 0) {
      data.hooks[event] = arr.filter((_, j) => !extras.includes(j))
      changed = true
    }
  }

  if (changed) writeHooksFile(path, data)
}

export function uninstallHooks(): void {
  const script = hookScriptPath()
  if (existsSync(script)) unlinkSync(script)
  const path = globalHooksPath()
  if (!existsSync(path)) return
  const data = readHooksFile(path)
  if (!data.hooks) return
  for (const event of Object.keys(data.hooks)) {
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `uninstalled Codex hooks from ${path}`)
}

export function stripHooksFromWorktree(worktreePath: string): boolean {
  const path = worktreeHooksPath(worktreePath)
  if (!existsSync(path)) return false
  const data = readHooksFile(path)
  if (!data.hooks) return false
  let changed = false
  for (const event of Object.keys(data.hooks)) {
    const before = data.hooks[event].length
    data.hooks[event] = removeOldHarnessEntries(data.hooks[event])
    if (data.hooks[event].length !== before) changed = true
    if (data.hooks[event].length === 0) delete data.hooks[event]
  }
  if (!changed) return false
  if (Object.keys(data.hooks).length === 0) delete data.hooks
  writeHooksFile(path, data)
  log('hooks', `stripped legacy Harness Codex entries from ${path}`)
  return true
}

export function sessionFileExists(_cwd: string, sessionId: string): boolean {
  try {
    const walkDir = (dir: string): boolean => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (walkDir(join(dir, entry.name))) return true
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return true
        }
      }
      return false
    }
    return walkDir(sessionsDir())
  } catch {
    return false
  }
}

export function latestSessionId(_cwd: string): string | null {
  try {
    let bestId: string | null = null
    let bestMtime = -Infinity
    const walkDir = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walkDir(full)
        } else if (entry.name.endsWith('.jsonl')) {
          const mtime = statSync(full).mtimeMs
          if (mtime > bestMtime) {
            bestMtime = mtime
            const stem = entry.name.replace(/\.jsonl$/, '')
            const uuidMatch = stem.match(/([0-9a-f]{4,}-[0-9a-f-]+)$/)
            bestId = uuidMatch ? uuidMatch[1] : stem
          }
        }
      }
    }
    walkDir(sessionsDir())
    return bestId
  } catch {
    return null
  }
}

export function tomlValue(v: string | string[] | Record<string, string>): string {
  if (typeof v === 'string') return JSON.stringify(v).replace(/\u007f/g, '\\u007f')
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(',')}]`
  return `{${Object.entries(v)
    .map(([k, val]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k)}=${tomlValue(val)}`)
    .join(',')}}`
}

export function codexMcpOverrides(server: HarnessMcpServerSpec): string {
  const pairs = [
    `mcp_servers.harness-control.command=${tomlValue(server.command)}`,
    `mcp_servers.harness-control.args=${tomlValue(server.args)}`,
    `mcp_servers.harness-control.env=${tomlValue(server.env)}`
  ]
  return pairs.map((p) => ` -c ${shellQuote(p)}`).join('')
}

export function buildSpawnArgs(opts: AgentSpawnOpts): string {
  // Token stays in the 0600 per-terminal file; argv only carries its path.
  let cmd = opts.command
  if (opts.mcpServer && !opts.command.includes('mcp_servers.harness-control')) {
    cmd += codexMcpOverrides(opts.mcpServer)
  }
  if (opts.model && !opts.command.includes('--model') && !opts.command.includes('-m ')) {
    cmd += ` --model ${shellQuote(opts.model)}`
  }

  if (!opts.sessionId) {
    return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
  }

  const exists = sessionFileExists(opts.cwd, opts.sessionId)
  if (exists) return `${cmd} resume ${opts.sessionId}`

  return opts.initialPrompt ? `${cmd} ${shellQuote(opts.initialPrompt)}` : cmd
}
