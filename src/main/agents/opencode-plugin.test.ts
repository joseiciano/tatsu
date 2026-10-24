import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../debug', () => ({
  log: () => {}
}))

import { makePluginContent } from './opencode'

const STATUS_DIR = '/tmp/harness-status'

const DRIVER = `const script = JSON.parse(process.argv[2]);
const { HarnessStatus } = await import('./plugin.mjs');
const client = {
  session: {
    messages: async () => {
      if (script.messagesThrow) throw new Error('boom');
      return { data: script.messages ?? [] };
    }
  }
};
const hooks = await HarnessStatus({ client });
for (const step of script.steps ?? []) {
  if ('event' in step) await hooks.event({ event: step.event });
  else await hooks[step.hook](step.input, step.output);
}
console.log(JSON.stringify({ keys: Object.keys(hooks) }));
`

type Step =
  | { event: unknown }
  | { hook: 'tool.execute.before' | 'tool.execute.after'; input?: unknown; output?: unknown }

interface Script {
  steps?: Step[]
  messages?: unknown[]
  messagesThrow?: boolean
}

interface Line {
  event: string
  ts: number
  payload: Record<string, unknown>
}

let dir: string
let drive: string
const createdFiles: string[] = []

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'harness-oc-'))
  writeFileSync(join(dir, 'plugin.mjs'), makePluginContent())
  drive = join(dir, 'drive.mjs')
  writeFileSync(drive, DRIVER)
})

afterEach(() => {
  while (createdFiles.length) rmSync(createdFiles.pop() as string, { force: true })
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

function newId(): string {
  const id = 'vitest-oc-' + randomUUID()
  createdFiles.push(join(STATUS_DIR, id + '.ndjson'))
  return id
}

function runDriver(script: Script, env: Record<string, string>): { keys: string[] } {
  const stdout = execFileSync(process.execPath, [drive, JSON.stringify(script)], {
    env: { PATH: process.env.PATH ?? '', ...env },
    encoding: 'utf-8'
  })
  return JSON.parse(stdout.trim().split('\n').pop() as string)
}

function readLines(id: string): Line[] {
  const path = join(STATUS_DIR, id + '.ndjson')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf-8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Line)
}

function run(script: Script): Line[] {
  const id = newId()
  runDriver(script, { HARNESS_TERMINAL_ID: id })
  return readLines(id)
}

const status = (sessionID: string, type: string): Step => ({
  event: { type: 'session.status', properties: { sessionID, status: { type } } }
})
const idle = (sessionID: string): Step => ({
  event: { type: 'session.idle', properties: { sessionID } }
})

describe('opencode status plugin (ESM, driven in Node)', () => {
  it('loads as an ES module and registers the event and tool hooks', () => {
    const id = newId()
    const { keys } = runDriver({}, { HARNESS_TERMINAL_ID: id })
    expect([...keys].sort()).toEqual(['event', 'tool.execute.after', 'tool.execute.before'])
  })

  it('registers no hooks and writes nothing when no terminal id is set', () => {
    const { keys } = runDriver({}, {})
    expect(keys).toEqual([])
  })

  it('falls back to CLAUDE_HARNESS_ID for the output file', () => {
    const id = newId()
    runDriver({ steps: [status('s1', 'busy')] }, { CLAUDE_HARNESS_ID: id })
    expect(readLines(id).map((l) => l.event)).toEqual(['UserPromptSubmit'])
  })

  it('emits UserPromptSubmit once per transition into busy', () => {
    const lines = run({
      steps: [status('s1', 'busy'), status('s1', 'busy'), status('s1', 'idle'), status('s1', 'busy')]
    })
    expect(lines.map((l) => [l.event, l.payload.session_id])).toEqual([
      ['UserPromptSubmit', 's1'],
      ['UserPromptSubmit', 's1']
    ])
    for (const line of lines) {
      expect(typeof line.ts).toBe('number')
      expect(Number.isInteger(line.ts)).toBe(true)
      expect(Math.abs(line.ts - Date.now() / 1000)).toBeLessThan(120)
    }
  })

  it('maps tool.execute.before/after hooks to PreToolUse/PostToolUse', () => {
    const lines = run({
      steps: [
        {
          hook: 'tool.execute.before',
          input: { tool: 'bash', sessionID: 's1', callID: 'c1' },
          output: { args: { command: 'ls' } }
        },
        {
          hook: 'tool.execute.after',
          input: { tool: 'bash', sessionID: 's1', callID: 'c1', args: { command: 'ls' } },
          output: { title: 'ls', output: 'a\nb', metadata: {} }
        }
      ]
    })
    expect(lines.map((l) => [l.event, l.payload])).toEqual([
      ['PreToolUse', { session_id: 's1', tool_name: 'bash', tool_input: { command: 'ls' } }],
      ['PostToolUse', { session_id: 's1', tool_name: 'bash', tool_input: { command: 'ls' } }]
    ])
  })

  it('puts the last assistant reply (non-synthetic text parts only) in the Stop payload', () => {
    const lines = run({
      steps: [idle('s1')],
      messages: [
        { info: { role: 'user' }, parts: [{ type: 'text', text: 'question' }] },
        {
          info: { role: 'assistant' },
          parts: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'x', synthetic: true },
            { type: 'tool' },
            { type: 'text', text: 'b' }
          ]
        }
      ]
    })
    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('Stop')
    expect(lines[0].payload).toEqual({ session_id: 's1', last_assistant_message: 'a\nb' })
  })

  it('emits Stop with a null last_assistant_message when fetching messages throws', () => {
    const lines = run({ steps: [idle('s1')], messagesThrow: true })
    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('Stop')
    expect(lines[0].payload).toEqual({ session_id: 's1', last_assistant_message: null })
  })

  it('attributes subagent activity to the root session and never emits Stop for a child', () => {
    const lines = run({
      steps: [
        { event: { type: 'session.created', properties: { info: { id: 'child', parentID: 's1' } } } },
        status('s1', 'busy'),
        status('child', 'busy'),
        idle('child'),
        {
          hook: 'tool.execute.before',
          input: { tool: 'read', sessionID: 'child', callID: 'c2' },
          output: { args: { filePath: '/x' } }
        }
      ]
    })
    expect(lines.map((l) => [l.event, l.payload.session_id])).toEqual([
      ['UserPromptSubmit', 's1'],
      ['PreToolUse', 's1']
    ])
  })

  it('maps permission.asked (v2), permission.updated (v1) and permission.replied', () => {
    const lines = run({
      steps: [
        {
          event: {
            type: 'permission.asked',
            properties: { id: 'per_1', sessionID: 's1', permission: 'bash', patterns: ['ls'], metadata: {} }
          }
        },
        {
          event: {
            type: 'permission.updated',
            properties: { id: 'per_2', type: 'bash', pattern: 'ls', sessionID: 's1', metadata: {} }
          }
        },
        {
          event: {
            type: 'permission.replied',
            properties: { sessionID: 's1', requestID: 'per_1', reply: 'once' }
          }
        }
      ]
    })
    expect(lines.map((l) => l.event)).toEqual(['Notification', 'Notification', 'UserPromptSubmit'])
    expect(lines[0].payload).toMatchObject({
      notification_type: 'permission_prompt',
      session_id: 's1',
      tool_name: 'bash',
      tool_input: { patterns: ['ls'] }
    })
    expect(lines[1].payload).toMatchObject({
      notification_type: 'permission_prompt',
      session_id: 's1',
      tool_name: 'bash'
    })
    expect(lines[2].payload).toEqual({ session_id: 's1' })
  })

  it('survives unknown events, missing properties and malformed hook input', () => {
    const lines = run({
      steps: [
        { event: { type: 'something.unknown', properties: { sessionID: 's1' } } },
        { event: { type: 'session.status' } },
        { event: { type: 'session.idle' } },
        { hook: 'tool.execute.before' },
        { hook: 'tool.execute.after' },
        status('s1', 'busy')
      ]
    })
    expect(lines.filter((l) => l.payload.session_id === 's1').map((l) => l.event)).toEqual([
      'UserPromptSubmit'
    ])
  })
})
