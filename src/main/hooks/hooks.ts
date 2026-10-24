import {
  watch,
  openSync,
  fstatSync,
  readSync,
  closeSync,
  unlinkSync,
  mkdirSync
} from 'fs'
import { join } from 'path'
import type { PtyStatus } from '../pty-manager'
import type { Store } from '../store'
import { log } from '../debug'

// This path is also the signature we use to recognize Harness-installed
// hook entries when deduping at install time. If you change it, update
// HARNESS_HOOK_COMMAND_SIGNATURE in src/main/agents/{claude,codex}.ts
// to match, or older installed entries become unrecognizable and
// re-installs will append duplicates.
const STATUS_DIR = '/tmp/harness-status'

export interface PendingTool {
  name: string
  input: Record<string, unknown>
}

// Emit a bash command that appends one NDJSON line per event to the
// terminal's log file at /tmp/harness-status/<id>.ndjson. The line wraps
// the full stdin payload Claude Code sends to the hook, so the main process
// has access to the raw event and can do all classification in TypeScript.
//
// Gated on $HARNESS_TERMINAL_ID / $CLAUDE_HARNESS_ID — these are only set
// by PtyManager when it spawns a terminal on our behalf. Sessions started
// outside Harness (plain `claude` in a terminal, CI, etc.) hit the exit 0
// on the first line and do nothing. That inert-by-default behavior is why
// a global user-scope install is safe.
//
// POSIX only — no jq, no python. The bash reads stdin into a shell var,
// defaults empty to `null`, then printf appends one line to the file.
// Lines often exceed PIPE_BUF (4096 bytes): Stop carries
// last_assistant_message and PreToolUse carries whole file contents, so a
// line can land in several write(2) calls. That is safe because each
// terminal's file has a single writer, the one agent running in that
// terminal, and the reader in tailLog holds a partial trailing line until
// its newline arrives.
export function makeHookCommand(event: string): string {
  const inner =
    `h="${'$HARNESS_TERMINAL_ID'}"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0; ` +
    `d=${STATUS_DIR}; mkdir -p "$d"; ` +
    `p=$(cat); [ -z "$p" ] && p=null; ` +
    `printf "{\\"event\\":\\"${event}\\",\\"ts\\":%s,\\"payload\\":%s}\\n" ` +
    `"$(date +%s)" "$p" >> "$d/$h.ndjson"`
  return `bash -c '${inner}'`
}

// Same NDJSON writer as makeHookCommand, as a standalone script that takes
// the event name as $1. Codex trusts hooks by the hash of their command
// text, so its hooks.json entries point at this script with a fixed
// command; logic changes ship by rewriting the script, not the command,
// and don't send the user back to /hooks to re-approve.
export function makeHookScript(): string {
  return [
    '#!/bin/bash',
    '# Installed by Harness. Removed by Settings > Status hooks > Remove hooks.',
    'h="$HARNESS_TERMINAL_ID"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0',
    `d=${STATUS_DIR}; mkdir -p "$d"`,
    'p=$(cat); [ -z "$p" ] && p=null',
    'printf \'{"event":"%s","ts":%s,"payload":%s}\\n\' "$1" "$(date +%s)" "$p" >> "$d/$h.ndjson"',
    ''
  ].join('\n')
}

interface HookEvent {
  event: string
  ts: number
  payload: Record<string, unknown> | null
}

// Most recently seen PreToolUse tool info per terminal. Used as a fallback
// source of `tool_name`/`tool_input` when a permission_prompt Notification
// arrives without those fields embedded in its own payload.
const lastPreTool = new Map<string, PendingTool>()

interface StatusUpdate {
  status: PtyStatus
  pendingTool: PendingTool | null
}

function readPendingTool(p: Record<string, unknown> | null): PendingTool | null {
  if (!p) return null
  const name = p.tool_name
  if (typeof name !== 'string' || !name) return null
  const rawInput = p.tool_input
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : {}
  return { name, input }
}

function deriveStatus(terminalId: string, ev: HookEvent): StatusUpdate | null {
  switch (ev.event) {
    case 'PreToolUse': {
      const tool = readPendingTool(ev.payload)
      if (tool) lastPreTool.set(terminalId, tool)
      return { status: 'processing', pendingTool: null }
    }
    case 'UserPromptSubmit':
    case 'PostToolUse':
      return { status: 'processing', pendingTool: null }
    case 'Stop':
      return { status: 'waiting', pendingTool: null }
    case 'Notification': {
      const p = ev.payload as Record<string, unknown> | null
      const t = p?.notification_type
      if (t === 'permission_prompt' || t === 'elicitation_dialog') {
        const fromNotification = readPendingTool(p)
        const pendingTool = fromNotification ?? lastPreTool.get(terminalId) ?? null
        return { status: 'needs-approval', pendingTool }
      }
      if (t === 'idle_prompt') return { status: 'waiting', pendingTool: null }
      return null
    }
    default:
      return null
  }
}

// Per-terminal byte offset into the NDJSON log. Tail from here on each
// fs.watch firing; advance to EOF after successful read.
const offsets = new Map<string, number>()
// Bytes after the last newline from the previous read: a line still being written. Kept as bytes so a multi-byte character split across reads decodes intact.
const residual = new Map<string, Buffer>()
// Terminals whose session ID has already been discovered and dispatched.
// Prevents repeated dispatches on every subsequent hook event.
const sessionIdDiscovered = new Set<string>()

export interface StopEvent {
  terminalId: string
  sessionId: string
  transcriptPath: string | null
  lastAssistantMessage: string | null
  ts: number
}

type StopListener = (ev: StopEvent) => void
const stopListeners = new Set<StopListener>()

/** Subscribe to Stop hook events: session id, transcript_path when the agent has one, and the turn's final assistant message. Used by CostTracker to re-tail a session jsonl. Returns an unsubscribe fn. */
export function onStopEvent(listener: StopListener): () => void {
  stopListeners.add(listener)
  return () => {
    stopListeners.delete(listener)
  }
}

function emitStopIfRelevant(terminalId: string, ev: HookEvent): void {
  if (ev.event !== 'Stop') return
  const p = ev.payload
  if (!p || typeof p !== 'object') return
  const sessionId = p.session_id
  if (typeof sessionId !== 'string' || !sessionId) return
  const transcriptPath = typeof p.transcript_path === 'string' && p.transcript_path ? p.transcript_path : null
  const lastAssistantMessage =
    typeof p.last_assistant_message === 'string' && p.last_assistant_message ? p.last_assistant_message : null
  log(
    'hooks',
    `stop terminal=${terminalId} transcript=${transcriptPath ? 'yes' : 'no'} lastMessageChars=${lastAssistantMessage?.length ?? 0}`
  )
  const payload: StopEvent = { terminalId, sessionId, transcriptPath, lastAssistantMessage, ts: ev.ts }
  for (const l of stopListeners) {
    try {
      l(payload)
    } catch (err) {
      log('hooks', 'stop listener error', err instanceof Error ? err.message : err)
    }
  }
}

export function splitNdjson(pending: Buffer, chunk: Buffer): { lines: string[]; rest: Buffer } {
  const data = pending.length ? Buffer.concat([pending, chunk]) : chunk
  const lines: string[] = []
  let start = 0
  let nl = data.indexOf(0x0a, start)
  while (nl !== -1) {
    lines.push(data.toString('utf-8', start, nl))
    start = nl + 1
    nl = data.indexOf(0x0a, start)
  }
  return { lines, rest: Buffer.from(data.subarray(start)) }
}

export function tailLog(terminalId: string, store: Store): void {
  const path = join(STATUS_DIR, `${terminalId}.ndjson`)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return
  }
  try {
    const { size } = fstatSync(fd)
    let off = offsets.get(terminalId) ?? 0
    if (size < off) {
      // File was truncated or replaced — start over.
      off = 0
      residual.delete(terminalId)
    }
    if (size === off) return
    const len = size - off
    const buf = Buffer.alloc(len)
    let n = 0
    while (n < len) {
      const r = readSync(fd, buf, n, len - n, off + n)
      if (r === 0) break
      n += r
    }
    offsets.set(terminalId, off + n)

    const { lines, rest } = splitNdjson(residual.get(terminalId) ?? Buffer.alloc(0), buf.subarray(0, n))
    if (rest.length) residual.set(terminalId, rest)
    else residual.delete(terminalId)

    for (const line of lines) {
      if (!line.trim()) continue
      let ev: HookEvent
      try {
        ev = JSON.parse(line) as HookEvent
      } catch (err) {
        log('hooks', `parse error for ${terminalId}: ${err instanceof Error ? err.message : err}`, line)
        continue
      }
      log('hooks', `event terminal=${terminalId} event=${ev.event}`)
      // Discover the agent-assigned session ID from the first hook event
      // that carries one. This is how Codex (and future agents that don't
      // let you set the session ID up front) get their ID stored on the tab.
      if (!sessionIdDiscovered.has(terminalId) && ev.payload) {
        const sid = (ev.payload as Record<string, unknown>).session_id
        if (typeof sid === 'string' && sid) {
          sessionIdDiscovered.add(terminalId)
          store.dispatch({
            type: 'terminals/sessionIdDiscovered',
            payload: { terminalId, sessionId: sid }
          })
        }
      }
      emitStopIfRelevant(terminalId, ev)
      const update = deriveStatus(terminalId, ev)
      if (update) {
        store.dispatch({
          type: 'terminals/statusChanged',
          payload: {
            id: terminalId,
            status: update.status,
            pendingTool: update.pendingTool
          }
        })
      }
    }
  } finally {
    closeSync(fd)
  }
}

/** Watch the status directory and dispatch terminal status transitions
 *  through the main-process store. The store's event transport fans the
 *  events out to every client that subscribes. */
export function watchStatusDir(store: Store): () => void {
  mkdirSync(STATUS_DIR, { recursive: true })

  log('hooks', `watching status dir: ${STATUS_DIR}`)

  const watcher = watch(STATUS_DIR, (_eventType, filename) => {
    if (!filename || !filename.endsWith('.ndjson')) return
    if (filename.startsWith('.')) return
    const terminalId = filename.replace(/\.ndjson$/, '')
    try {
      tailLog(terminalId, store)
    } catch (err) {
      log('hooks', `tail failed for ${terminalId}`, err instanceof Error ? err.message : err)
    }
  })

  return () => watcher.close()
}

/** Called on terminal death — drop the log file and reset tailing state. */
export function cleanupTerminalLog(terminalId: string): void {
  offsets.delete(terminalId)
  residual.delete(terminalId)
  lastPreTool.delete(terminalId)
  sessionIdDiscovered.delete(terminalId)
  try {
    unlinkSync(join(STATUS_DIR, `${terminalId}.ndjson`))
  } catch {
    // file may not exist; ignore
  }
}
