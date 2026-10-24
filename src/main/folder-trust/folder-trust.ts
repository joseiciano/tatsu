import { readFile, realpath, lstat } from 'fs/promises'
import { existsSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, basename, join, resolve } from 'path'
import { parse } from 'smol-toml'
import { log } from '../debug'

export type TrustAgent = 'claude' | 'codex'
export type TrustStatus = 'trusted' | 'untrusted' | 'unknown'
export type TrustVia = 'env' | 'exact' | 'ancestor' | 'repo-root'
export type TrustReason =
  | 'no-entry'
  | 'explicitly-untrusted'
  | 'config-missing'
  | 'config-unreadable'
  | 'config-malformed'

export interface FolderTrustResult {
  agent: TrustAgent
  path: string
  status: TrustStatus
  via: TrustVia | null
  matchedKey: string | null
  reason: TrustReason | null
  configPath: string
}

export interface FolderTrustOptions {
  env?: NodeJS.ProcessEnv
  homeDir?: string
  claudeConfigPath?: string
  codexConfigPath?: string
}

type Projects = Record<string, unknown>
type ReadResult =
  | { ok: true; projects: Projects }
  | { ok: false; status: 'untrusted' | 'unknown'; reason: TrustReason }

interface GitLayout {
  toplevel: string
  commonDir: string
}

export function claudeGlobalConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim()
  const legacy = join(dir || join(homeDir, '.claude'), '.config.json')
  if (existsSync(legacy)) return legacy
  return join(dir || homeDir, '.claude.json')
}

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  const dir = env.CODEX_HOME?.trim()
  if (!dir) return join(homeDir, '.codex')
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

export function codexConfigPath(env: NodeJS.ProcessEnv = process.env, homeDir: string = homedir()): string {
  return join(resolveCodexHome(env, homeDir), 'config.toml')
}

async function resolvePath(p: string): Promise<string> {
  const abs = resolve(p)
  try {
    return await realpath(abs)
  } catch {
    return abs
  }
}

async function findGitLayout(realPath: string): Promise<GitLayout | null> {
  let dir = realPath
  for (;;) {
    const entry = join(dir, '.git')
    let st
    try {
      st = await lstat(entry)
    } catch {
      st = null
    }
    if (st && st.isDirectory()) {
      return { toplevel: await resolvePath(dir), commonDir: await resolvePath(entry) }
    }
    if (st && st.isFile()) {
      let content: string
      try {
        content = await readFile(entry, 'utf8')
      } catch {
        return null
      }
      const first = content.split('\n')[0]?.trim() ?? ''
      if (!first.startsWith('gitdir:')) return null
      const gitDir = resolve(dir, first.slice('gitdir:'.length).trim())
      let commonDir = gitDir
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        try {
          commonDir = resolve(gitDir, (await readFile(commondirFile, 'utf8')).trim())
        } catch {
          commonDir = gitDir
        }
      }
      return { toplevel: await resolvePath(dir), commonDir: await resolvePath(commonDir) }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function claudeCanonicalRoot(layout: GitLayout): string {
  return basename(layout.commonDir) === '.git' ? dirname(layout.commonDir) : layout.commonDir
}

function codexRepoRoot(layout: GitLayout): string {
  return dirname(layout.commonDir)
}

function parentChain(start: string, stopAt: string | null): string[] {
  const chain: string[] = []
  let cur = start
  for (;;) {
    chain.push(cur)
    if (stopAt !== null && cur === stopAt) break
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return chain
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p
}

function keyLookup(projects: Projects, candidate: string): string | null {
  const want = stripTrailingSlash(candidate)
  const wantNfc = want.normalize('NFC')
  for (const key of Object.keys(projects)) {
    const k = stripTrailingSlash(key)
    if (k === want || k.normalize('NFC') === wantNfc) return key
  }
  return null
}

function isTruthyEnv(value: string | undefined): boolean {
  if (!value) return false
  const v = value.trim().toLowerCase()
  return v !== '' && v !== '0' && v !== 'false'
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function readConfigText(configPath: string): Promise<{ text: string } | { failure: ReadResult }> {
  try {
    return { text: await readFile(configPath, 'utf8') }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { failure: { ok: false, status: 'untrusted', reason: 'config-missing' } }
    return { failure: { ok: false, status: 'unknown', reason: 'config-unreadable' } }
  }
}

async function readClaudeProjects(configPath: string): Promise<ReadResult> {
  const read = await readConfigText(configPath)
  if ('failure' in read) return read.failure
  let parsed: unknown
  try {
    parsed = JSON.parse(read.text)
  } catch {
    parsed = undefined
  }
  if (!isPlainObject(parsed)) {
    log('folder-trust', 'claude config malformed', { configPath })
    return { ok: false, status: 'unknown', reason: 'config-malformed' }
  }
  return { ok: true, projects: isPlainObject(parsed.projects) ? parsed.projects : {} }
}

async function readCodexProjects(configPath: string): Promise<ReadResult> {
  const read = await readConfigText(configPath)
  if ('failure' in read) return read.failure
  let parsed: unknown
  try {
    parsed = parse(read.text)
  } catch {
    log('folder-trust', 'codex config malformed', { configPath })
    return { ok: false, status: 'unknown', reason: 'config-malformed' }
  }
  const projects = isPlainObject(parsed) && isPlainObject(parsed.projects) ? parsed.projects : {}
  return { ok: true, projects }
}

function result(
  agent: TrustAgent,
  path: string,
  configPath: string,
  fields: Partial<Pick<FolderTrustResult, 'status' | 'via' | 'matchedKey' | 'reason'>>
): FolderTrustResult {
  return {
    agent,
    path,
    status: fields.status ?? 'untrusted',
    via: fields.via ?? null,
    matchedKey: fields.matchedKey ?? null,
    reason: fields.reason ?? null,
    configPath
  }
}

function claudeTrusts(projects: Projects, candidate: string): string | null {
  const key = keyLookup(projects, candidate)
  if (key === null) return null
  const entry = projects[key]
  return isPlainObject(entry) && entry.hasTrustDialogAccepted === true ? key : null
}

export async function checkClaudeFolderTrust(path: string, opts: FolderTrustOptions = {}): Promise<FolderTrustResult> {
  const env = opts.env ?? process.env
  const homeDir = opts.homeDir ?? homedir()
  const configPath = opts.claudeConfigPath ?? claudeGlobalConfigPath(env, homeDir)
  const real = await resolvePath(path)
  if (isTruthyEnv(env.CLAUDE_CODE_SANDBOXED)) {
    return result('claude', real, configPath, { status: 'trusted', via: 'env' })
  }
  const read = await readClaudeProjects(configPath)
  if (!read.ok) return result('claude', real, configPath, { status: read.status, reason: read.reason })
  const layout = await findGitLayout(real)
  if (layout) {
    const root = claudeCanonicalRoot(layout)
    const key = claudeTrusts(read.projects, root)
    if (key !== null) {
      return result('claude', real, configPath, {
        status: 'trusted',
        via: root === real ? 'exact' : 'repo-root',
        matchedKey: key
      })
    }
  }
  for (const cur of parentChain(real, layout ? layout.toplevel : null)) {
    const key = claudeTrusts(read.projects, cur)
    if (key !== null) {
      return result('claude', real, configPath, {
        status: 'trusted',
        via: cur === real ? 'exact' : 'ancestor',
        matchedKey: key
      })
    }
  }
  return result('claude', real, configPath, { status: 'untrusted', reason: 'no-entry' })
}

function codexLevel(projects: Projects, candidate: string): { key: string; level: 'trusted' | 'untrusted' } | null {
  const key = keyLookup(projects, candidate)
  if (key === null) return null
  const entry = projects[key]
  if (!isPlainObject(entry)) return null
  const level = entry.trust_level
  if (level === 'trusted' || level === 'untrusted') return { key, level }
  return null
}

async function codexRepoRootApplies(layout: GitLayout): Promise<boolean> {
  if (basename(layout.commonDir) === '.git') return true
  const marker = join(codexRepoRoot(layout), '.git')
  try {
    const st = await lstat(marker)
    if (!st.isFile()) return false
    const first = (await readFile(marker, 'utf8')).split('\n')[0]?.trim() ?? ''
    if (!first.startsWith('gitdir:')) return false
    const target = await resolvePath(resolve(codexRepoRoot(layout), first.slice('gitdir:'.length).trim()))
    return target === layout.commonDir
  } catch {
    return false
  }
}

export async function checkCodexFolderTrust(path: string, opts: FolderTrustOptions = {}): Promise<FolderTrustResult> {
  const env = opts.env ?? process.env
  const homeDir = opts.homeDir ?? homedir()
  const configPath = opts.codexConfigPath ?? codexConfigPath(env, homeDir)
  const real = await resolvePath(path)
  const read = await readCodexProjects(configPath)
  if (!read.ok) return result('codex', real, configPath, { status: read.status, reason: read.reason })
  const candidates: { path: string; via: TrustVia }[] = [{ path: real, via: 'exact' }]
  const layout = await findGitLayout(real)
  if (layout && (await codexRepoRootApplies(layout))) {
    const root = codexRepoRoot(layout)
    if (root !== real) candidates.push({ path: root, via: 'repo-root' })
  }
  for (const c of candidates) {
    const hit = codexLevel(read.projects, c.path)
    if (!hit) continue
    if (hit.level === 'trusted') {
      return result('codex', real, configPath, { status: 'trusted', via: c.via, matchedKey: hit.key })
    }
    return result('codex', real, configPath, {
      status: 'untrusted',
      reason: 'explicitly-untrusted',
      matchedKey: hit.key
    })
  }
  return result('codex', real, configPath, { status: 'untrusted', reason: 'no-entry' })
}

export async function checkFolderTrust(
  path: string,
  opts: FolderTrustOptions = {}
): Promise<Record<TrustAgent, FolderTrustResult>> {
  const [claude, codex] = await Promise.all([checkClaudeFolderTrust(path, opts), checkCodexFolderTrust(path, opts)])
  return { claude, codex }
}
