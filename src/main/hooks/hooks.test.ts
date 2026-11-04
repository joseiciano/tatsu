import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cleanupTerminalLog,
  makeHookCommand,
  makeHookScript,
  onPromptSubmit,
  onStopEvent,
  splitNdjson,
  tailLog,
  type StopEvent
} from '.'
import type { Store } from '../store'

const fsCap = vi.hoisted(() => ({ maxRead: Infinity }))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs')
  return {
    ...actual,
    readSync: (fd: number, buf: Buffer, offset: number, length: number, position: number) =>
      actual.readSync(fd, buf, offset, Math.min(length, fsCap.maxRead), position)
  }
})

vi.mock('../debug', () => ({
  log: vi.fn()
}))

function runHook(argv: string[], terminalId: string, payload: string): string {
  const file = `/tmp/harness-status/${terminalId}.ndjson`
  rmSync(file, { force: true })
  execFileSync(argv[0], ['--noprofile', '--norc', ...argv.slice(1)], {
    input: payload,
    env: { PATH: process.env.PATH, HOME: tmpdir(), HARNESS_TERMINAL_ID: terminalId }
  })
  const out = readFileSync(file, 'utf-8')
  rmSync(file, { force: true })
  return out.replace(/"ts":\d+/, '"ts":0')
}

const legacyHookCommand = (event: string): string =>
  String.raw`bash -c 'h="$HARNESS_TERMINAL_ID"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0; d=/tmp/harness-status; mkdir -p "$d"; p=$(cat); [ -z "$p" ] && p=null; printf "{\"event\":\"${event}\",\"ts\":%s,\"payload\":%s}\n" "$(date +%s)" "$p" >> "$d/$h.ndjson"'`

describe('hook command pins', () => {
  it.each(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'SessionStart'])(
    'keeps the %s command byte-identical',
    (event) => {
      expect(makeHookCommand(event)).toBe(legacyHookCommand(event))
    }
  )

  it('changes only the Stop command and keeps the status-dir install signature in it', () => {
    const stop = makeHookCommand('Stop')
    expect(stop).not.toBe(legacyHookCommand('Stop'))
    expect(stop).toContain('/tmp/harness-status')
    expect(stop).toMatch(/^bash -c '[^']*'$/)
  })

  it('pins the standalone hook script, whose Stop path runs the same stop-check as the Claude Stop command', () => {
    const stopCheck =
      String.raw`if [ "$1" = Stop ] && [ -n "$m" ] && [ -f "${'$'}{m%.json}.step" ] && command -v curl >/dev/null 2>&1; then ` +
      String.raw`o=$(sed -n "s/^ *\"HARNESS_PORT\": \"\([0-9][0-9]*\)\",\{0,1\} *$/\1/p" "$m" 2>/dev/null); ` +
      String.raw`t=$(sed -n "s/^ *\"HARNESS_TOKEN\": \"\([0-9a-f][0-9a-f]*\)\",\{0,1\} *$/\1/p" "$m" 2>/dev/null); ` +
      String.raw`case "$o" in ""|*[!0-9]*) o=;; esac; case "$t" in ""|*[!0-9a-f]*) t=;; esac; ` +
      String.raw`case "$h" in *[!A-Za-z0-9._-]*) o=;; esac; ` +
      String.raw`if [ -n "$o" ] && [ -n "$t" ] && r=$(printf "%s" "$p" | curl -sf --connect-timeout 1 --max-time 2 ` +
      String.raw`-H "Content-Type: application/json" -H "X-Harness-Terminal-Id: $h" -H @/dev/fd/3 --data-binary @- ` +
      String.raw`"http://127.0.0.1:$o/workflow/stop-check" 3<<<"Authorization: Bearer $t" 2>/dev/null); then ` +
      String.raw`case "$r" in *\"decision\":\"block\"*) c=",\"continued\":true";; *) r=;; esac; else r=; fi; fi`
    expect(makeHookScript()).toBe(
      [
        '#!/bin/bash',
        '# Installed by Harness. Removed by Settings > Status hooks > Remove hooks.',
        'h="$HARNESS_TERMINAL_ID"; [ -z "$h" ] && h="$CLAUDE_HARNESS_ID"; [ -z "$h" ] && exit 0',
        'd=/tmp/harness-status; mkdir -p "$d"',
        'p=$(cat); [ -z "$p" ] && p=null',
        'r=; c=; m="$HARNESS_MCP_CONFIG"',
        stopCheck,
        String.raw`printf '{"event":"%s","ts":%s%s,"payload":%s}\n' "$1" "$(date +%s)" "$c" "$p" >> "$d/$h.ndjson"`,
        String.raw`[ -n "$r" ] && printf "%s\n" "$r"`,
        'exit 0',
        ''
      ].join('\n')
    )
    expect(makeHookCommand('Stop')).toContain(`; r=; c=; m="$HARNESS_MCP_CONFIG"; ${stopCheck.replace('[ "$1" = Stop ] && ', '')}; `)
  })
})

describe('makeHookScript', () => {
  it('writes the same NDJSON line as the inline hook command', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-hook-'))
    const script = join(dir, 'hook.sh')
    writeFileSync(script, makeHookScript())
    const payload = '{"session_id":"s1","note":"100% done"}'
    try {
      const fromScript = runHook(['bash', script, 'Stop'], `test-script-${process.pid}`, payload)
      const inline = makeHookCommand('Stop').replace(/^bash -c '/, '').replace(/'$/, '')
      const fromInline = runHook(['bash', '-c', inline], `test-inline-${process.pid}`, payload)
      expect(fromScript).toBe(fromInline)
      expect(JSON.parse(fromScript)).toEqual({
        event: 'Stop',
        ts: 0,
        payload: { session_id: 's1', note: '100% done' }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('exits without writing when no terminal id is set', () => {
    expect(() =>
      execFileSync('bash', ['--noprofile', '--norc', '-c', makeHookScript(), 'hook', 'Stop'], {
        input: '{}',
        env: { PATH: process.env.PATH, HOME: tmpdir() }
      })
    ).not.toThrow()
  })
})

const empty = Buffer.alloc(0)

describe('splitNdjson', () => {
  it('returns every complete line and an empty rest when input ends with a newline', () => {
    const { lines, rest } = splitNdjson(empty, Buffer.from('{"a":1}\n{"b":2}\n'))
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest.length).toBe(0)
  })

  it('holds a partial trailing line in rest and completes it with the next chunk', () => {
    const first = splitNdjson(empty, Buffer.from('{"a":1}\n{"b":'))
    expect(first.lines).toEqual(['{"a":1}'])
    expect(first.rest.toString('utf-8')).toBe('{"b":')

    const second = splitNdjson(first.rest, Buffer.from('2}\n'))
    expect(second.lines).toEqual(['{"b":2}'])
    expect(second.rest.length).toBe(0)
  })

  it('decodes a multi-byte character intact wherever the read boundary falls', () => {
    const line = Buffer.from('{"m":"a—b🙂c"}\n')
    for (let i = 1; i < line.length; i++) {
      const a = splitNdjson(empty, line.subarray(0, i))
      const b = splitNdjson(a.rest, line.subarray(i))
      const all = [...a.lines, ...b.lines]
      expect(all, `split at byte ${i}`).toHaveLength(1)
      expect(JSON.parse(all[0]).m, `split at byte ${i}`).toBe('a—b🙂c')
    }
  })
})

describe('tailLog', () => {
  let id: string
  let file: string
  let dispatch: ReturnType<typeof vi.fn>
  let store: Store
  let stops: StopEvent[]
  let off: () => void

  beforeEach(() => {
    id = 'vitest-hooks-' + randomUUID()
    mkdirSync('/tmp/harness-status', { recursive: true })
    file = `/tmp/harness-status/${id}.ndjson`
    dispatch = vi.fn()
    store = { dispatch } as unknown as Store
    stops = []
    off = onStopEvent((e) => stops.push(e))
  })

  afterEach(() => {
    off()
    cleanupTerminalLog(id)
    fsCap.maxRead = Infinity
  })

  function append(data: string | Buffer): void {
    appendFileSync(file, data)
    tailLog(id, store)
  }

  function stopLine(payload: unknown): string {
    return JSON.stringify({ event: 'Stop', ts: 1, payload }) + '\n'
  }

  function statusDispatches(): unknown[] {
    return dispatch.mock.calls
      .map((c) => c[0])
      .filter((e: { type: string }) => e.type === 'terminals/statusChanged')
  }

  const claudeLine =
    '{"event":"Stop","ts":1,"payload":{"session_id":"c1","transcript_path":"/tmp/c.jsonl","last_assistant_message":"Done.","stop_hook_active":false}}\n'

  it('emits one intact Stop when a >PIPE_BUF line is split mid-character across two reads', () => {
    const message = 'é'.repeat(6000)
    const line = Buffer.from(
      JSON.stringify({
        event: 'Stop',
        ts: 1,
        payload: { session_id: 's1', transcript_path: '/tmp/t.jsonl', last_assistant_message: message }
      }) + '\n'
    )
    const first = line.indexOf('é')
    const cut = first + 1 + 2 * 2100
    expect(line[cut] & 0xc0).toBe(0x80)
    expect(cut).toBeGreaterThan(4096)

    append(line.subarray(0, cut))
    expect(stops).toEqual([])
    expect(statusDispatches()).toEqual([])

    append(line.subarray(cut))
    expect(stops).toHaveLength(1)
    expect(stops[0].lastAssistantMessage).toBe(message)
    expect(stops[0].transcriptPath).toBe('/tmp/t.jsonl')
    expect(stops[0].sessionId).toBe('s1')
    expect(dispatch).toHaveBeenCalledWith({
      type: 'terminals/statusChanged',
      payload: { id, status: 'waiting', pendingTool: null }
    })
  })

  it('emits the Claude Stop shape with transcript path and final message', () => {
    append(claudeLine)
    expect(stops).toEqual([
      { terminalId: id, sessionId: 'c1', transcriptPath: '/tmp/c.jsonl', lastAssistantMessage: 'Done.', continued: false, stopHookActive: false, ts: 1 }
    ])
  })

  it.each([
    {
      name: 'null transcript path and null message',
      payload: { session_id: 'x1', transcript_path: null, last_assistant_message: null, turn_id: 't', stop_hook_active: false },
      transcriptPath: null,
      lastAssistantMessage: null
    },
    {
      name: 'message present, transcript_path key absent',
      payload: { session_id: 'x1', last_assistant_message: 'ok', turn_id: 't', stop_hook_active: false },
      transcriptPath: null,
      lastAssistantMessage: 'ok'
    },
    {
      name: 'empty message string',
      payload: { session_id: 'x1', transcript_path: null, last_assistant_message: '', turn_id: 't', stop_hook_active: false },
      transcriptPath: null,
      lastAssistantMessage: null
    }
  ])('emits a Codex Stop: $name', ({ payload, transcriptPath, lastAssistantMessage }) => {
    append(stopLine(payload))
    expect(stops).toEqual([{ terminalId: id, sessionId: 'x1', transcriptPath, lastAssistantMessage, continued: false, stopHookActive: false, ts: 1 }])
  })

  it('emits the opencode Stop shape without a transcript path, message unchanged', () => {
    append(stopLine({ session_id: 'o1', last_assistant_message: 'line1\nline2' }))
    expect(stops).toEqual([
      { terminalId: id, sessionId: 'o1', transcriptPath: null, lastAssistantMessage: 'line1\nline2', continued: false, stopHookActive: false, ts: 1 }
    ])
  })

  it.each([
    { name: 'null payload', payload: null },
    { name: 'payload without session_id', payload: { last_assistant_message: 'x' } }
  ])('emits no Stop but still marks waiting for $name', ({ payload }) => {
    append(stopLine(payload))
    expect(stops).toEqual([])
    expect(dispatch).toHaveBeenCalledWith({
      type: 'terminals/statusChanged',
      payload: { id, status: 'waiting', pendingTool: null }
    })
  })

  it('dispatches session discovery, processing, then needs-approval with the PreToolUse fallback tool', () => {
    append(
      '{"event":"PreToolUse","ts":1,"payload":{"session_id":"p1","tool_name":"Bash","tool_input":{"command":"ls"}}}\n' +
        '{"event":"Notification","ts":2,"payload":{"session_id":"p1","notification_type":"permission_prompt"}}\n'
    )
    expect(dispatch.mock.calls.map((c) => c[0])).toEqual([
      { type: 'terminals/sessionIdDiscovered', payload: { terminalId: id, sessionId: 'p1' } },
      { type: 'terminals/statusChanged', payload: { id, status: 'processing', pendingTool: null } },
      {
        type: 'terminals/statusChanged',
        payload: { id, status: 'needs-approval', pendingTool: { name: 'Bash', input: { command: 'ls' } } }
      }
    ])
    expect(stops).toEqual([])
  })

  it('marks a Stop continued only when the hook line carries continued: true', () => {
    append(JSON.stringify({ event: 'Stop', ts: 1, continued: true, payload: { session_id: 'c1' } }) + '\n')
    append(JSON.stringify({ event: 'Stop', ts: 2, continued: 'yes', payload: { session_id: 'c1' } }) + '\n')
    expect(stops.map((stop) => stop.continued)).toEqual([true, false])
  })

  it('carries stop_hook_active only when the payload holds literal true', () => {
    append(JSON.stringify({ event: 'Stop', ts: 1, payload: { session_id: 'c1', stop_hook_active: true } }) + '\n')
    append(JSON.stringify({ event: 'Stop', ts: 2, payload: { session_id: 'c1', stop_hook_active: 'true' } }) + '\n')
    append(JSON.stringify({ event: 'Stop', ts: 3, payload: { session_id: 'c1' } }) + '\n')
    expect(stops.map((stop) => stop.stopHookActive)).toEqual([true, false, false])
  })

  it('tells prompt-submit listeners about UserPromptSubmit for this terminal only', () => {
    const prompts: string[] = []
    const offPrompt = onPromptSubmit((e) => prompts.push(e.terminalId))
    try {
      append(
        '{"event":"UserPromptSubmit","ts":1,"payload":{"session_id":"u1","prompt":"hi"}}\n' +
          '{"event":"PostToolUse","ts":2,"payload":{"session_id":"u1"}}\n'
      )
    } finally {
      offPrompt()
    }
    expect(prompts).toEqual([id])
  })

  it('reads the whole appended line in one call even when readSync returns short reads', () => {
    fsCap.maxRead = 7
    append(claudeLine)
    expect(stops).toEqual([
      { terminalId: id, sessionId: 'c1', transcriptPath: '/tmp/c.jsonl', lastAssistantMessage: 'Done.', continued: false, stopHookActive: false, ts: 1 }
    ])
    expect(statusDispatches()).toEqual([
      { type: 'terminals/statusChanged', payload: { id, status: 'waiting', pendingTool: null } }
    ])
  })
})
