import { readFile } from 'fs/promises'
import { watch, existsSync, type FSWatcher } from 'fs'
import { createHash } from 'crypto'
import { parse } from 'smol-toml'
import type { CodexHookTrustSummary } from '../../shared/state/hooks'
import { log } from '../debug'

export type { CodexHookTrustSummary }

export type CodexHookTrustStatus = 'trusted' | 'modified' | 'untrusted' | 'disabled'

export interface CodexHookHandler {
  type: string
  command: string
  timeout?: number
  async?: boolean
  statusMessage?: string
}

export interface CodexHookGroup {
  matcher?: string
  hooks: CodexHookHandler[]
}

export interface CodexHookTrustEntry {
  event: string
  groupIndex: number
  handlerIndex: number
  key: string
  hash: string
  storedHash: string | null
  status: CodexHookTrustStatus
}

export interface CodexHookTrustReport {
  hooksPath: string
  configPath: string
  readable: boolean
  entries: CodexHookTrustEntry[]
}

export interface ReadCodexHookTrustOptions {
  hooksPath: string
  configPath: string
  isOwnedHandler: (handler: CodexHookHandler) => boolean
}

const MATCHERLESS_EVENTS = new Set(['UserPromptSubmit', 'Stop', 'Interrupt'])

export function codexEventSnake(event: string): string {
  return event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

export function codexHookKey(hooksPath: string, event: string, groupIndex: number, handlerIndex: number): string {
  return `${hooksPath}:${codexEventSnake(event)}:${groupIndex}:${handlerIndex}`
}

function identityEventName(event: string): string {
  return codexEventSnake(event)
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function codexHookIdentityJson(event: string, group: CodexHookGroup, handlerIndex = 0): string {
  const h = group.hooks[handlerIndex]
  const handler: Record<string, unknown> = {
    type: h.type,
    command: h.command,
    timeout: Math.max(1, h.timeout ?? 600),
    async: h.async ?? false
  }
  if (h.statusMessage !== undefined) handler.statusMessage = h.statusMessage
  const identity: Record<string, unknown> = { event_name: identityEventName(event), hooks: [handler] }
  if (group.matcher !== undefined && !MATCHERLESS_EVENTS.has(event)) identity.matcher = group.matcher
  return canonicalJson(identity)
}

export function codexHookHash(event: string, group: CodexHookGroup, handlerIndex = 0): string {
  return 'sha256:' + createHash('sha256').update(codexHookIdentityJson(event, group, handlerIndex), 'utf8').digest('hex')
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

type StoredState = Record<string, { trusted_hash?: unknown; enabled?: unknown }>

async function readStoredState(configPath: string): Promise<{ ok: true; state: StoredState } | { ok: false }> {
  let text: string
  try {
    text = await readFile(configPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, state: {} }
    log('codex-hook-trust', 'config unreadable', { configPath })
    return { ok: false }
  }
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    log('codex-hook-trust', 'config unreadable', { configPath })
    return { ok: false }
  }
  const hooks = isPlainObject(parsed) && isPlainObject(parsed.hooks) ? parsed.hooks : {}
  const state = isPlainObject(hooks.state) ? hooks.state : {}
  const out: StoredState = {}
  for (const [key, value] of Object.entries(state)) {
    if (isPlainObject(value)) out[key] = { trusted_hash: value.trusted_hash, enabled: value.enabled }
  }
  return { ok: true, state: out }
}

export async function readCodexHookTrust(opts: ReadCodexHookTrustOptions): Promise<CodexHookTrustReport> {
  const base = { hooksPath: opts.hooksPath, configPath: opts.configPath }
  let hooksText: string
  try {
    hooksText = await readFile(opts.hooksPath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ...base, readable: true, entries: [] }
    return { ...base, readable: false, entries: [] }
  }
  let data: unknown
  try {
    data = JSON.parse(hooksText)
  } catch {
    return { ...base, readable: false, entries: [] }
  }
  const stored = await readStoredState(opts.configPath)
  if (!stored.ok) return { ...base, readable: false, entries: [] }
  const hooks = isPlainObject(data) && isPlainObject(data.hooks) ? data.hooks : {}
  const entries: CodexHookTrustEntry[] = []
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue
    groups.forEach((group, groupIndex) => {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) return
      const g = group as unknown as CodexHookGroup
      g.hooks.forEach((handler, handlerIndex) => {
        if (!isPlainObject(handler) || !opts.isOwnedHandler(handler as unknown as CodexHookHandler)) return
        const key = codexHookKey(opts.hooksPath, event, groupIndex, handlerIndex)
        const hash = codexHookHash(event, g, handlerIndex)
        const st = stored.state[key]
        const storedHash = typeof st?.trusted_hash === 'string' ? st.trusted_hash : null
        let status: CodexHookTrustStatus
        if (st?.enabled === false) status = 'disabled'
        else if (storedHash === hash) status = 'trusted'
        else if (storedHash !== null) status = 'modified'
        else status = 'untrusted'
        entries.push({ event, groupIndex, handlerIndex, key, hash, storedHash, status })
      })
    })
  }
  return { ...base, readable: true, entries }
}

export function summarizeCodexHookTrust(
  report: CodexHookTrustReport,
  expectedEvents: readonly string[]
): CodexHookTrustSummary {
  if (!report.readable) return { state: 'unknown', reviewEvents: [] }
  if (report.entries.length === 0) return { state: 'not-installed', reviewEvents: [] }
  const reviewEvents = [
    ...new Set(report.entries.filter((e) => e.status !== 'trusted').map((e) => e.event))
  ]
    .filter((e) => expectedEvents.includes(e))
    .sort()
  return { state: reviewEvents.length ? 'needs-review' : 'ok', reviewEvents }
}

const UNKNOWN: CodexHookTrustSummary = { state: 'unknown', reviewEvents: [] }

export function startCodexHookTrustMonitor(opts: {
  watchDir: string
  compute: () => Promise<CodexHookTrustSummary>
  onChange: (summary: CodexHookTrustSummary) => void
  debounceMs?: number
}): { refresh: () => Promise<void>; stop: () => void } {
  const debounceMs = opts.debounceMs ?? 250
  let watcher: FSWatcher | null = null
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let inFlight: Promise<void> | null = null
  let lastSent: string | null = null

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      void refresh()
    }, debounceMs)
  }

  const ensureWatch = (): void => {
    if (watcher || stopped || !existsSync(opts.watchDir)) return
    try {
      watcher = watch(opts.watchDir, { persistent: false }, (_type, filename) => {
        const name = filename === null ? null : String(filename)
        if (name === null || name === 'config.toml' || name === 'hooks.json') schedule()
      })
      watcher.on('error', () => {
        watcher?.close()
        watcher = null
      })
    } catch {
      watcher = null
    }
  }

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight
    inFlight = (async () => {
      ensureWatch()
      let summary: CodexHookTrustSummary
      try {
        summary = await opts.compute()
      } catch {
        summary = UNKNOWN
      }
      const json = JSON.stringify(summary)
      if (json !== lastSent) {
        lastSent = json
        opts.onChange(summary)
      }
    })().finally(() => {
      inFlight = null
    })
    return inFlight
  }

  const stop = (): void => {
    stopped = true
    if (timer) clearTimeout(timer)
    timer = null
    watcher?.close()
    watcher = null
  }

  void refresh()
  return { refresh, stop }
}
