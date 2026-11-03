import { describe, it, expect, vi, beforeAll, afterAll, afterEach, beforeEach } from 'vitest'
import { execFile, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type IncomingHttpHeaders } from 'http'
import type { AddressInfo, Socket } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { promisify } from 'util'

vi.mock('../debug', () => ({
  log: () => {}
}))

import { makePluginContent } from './opencode'

const STATUS_DIR = '/tmp/harness-status'
const execFileAsync = promisify(execFile)

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

const STOP_CHECK_DRIVER = `const [scriptJson, pluginUrl] = process.argv.slice(2);
const script = JSON.parse(scriptJson);
const { HarnessStatus } = await import(pluginUrl);
const calls = [];
const client = {
  session: {
    messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'partial' }] }] }),
    promptAsync: async (arg) => {
      calls.push(arg);
      if (script.promptThrows) throw new Error('prompt failed');
      if (script.promptError) return { error: { name: 'NotFoundError', data: {} } };
      return { data: undefined };
    }
  }
};
if (script.noPromptAsync) delete client.session.promptAsync;
const hooks = await HarnessStatus({ client });
for (const event of script.events) await hooks.event({ event });
console.log(JSON.stringify({ calls }));
`

const BLOCK_REASON = 'Call complete_step before stopping.'
const TOKEN = 'ab'.repeat(32)

interface StopCheckRequest {
  method: string | undefined
  url: string | undefined
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

interface StubServer {
  port: number
  requests: StopCheckRequest[]
  reply: (body: Record<string, unknown>) => { delayMs?: number; json: unknown }
  close(): Promise<void>
}

async function startStub(): Promise<StubServer> {
  const stub: Pick<StubServer, 'requests' | 'reply'> = {
    requests: [],
    reply: (body) => ({
      json: body.stop_hook_active === true ? {} : { decision: 'block', reason: BLOCK_REASON }
    })
  }
  const sockets = new Set<Socket>()
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => (raw += chunk))
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      stub.requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const { delayMs = 0, json } = stub.reply(body)
      setTimeout(() => {
        if (res.destroyed) return
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(json))
      }, delayMs)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return Object.assign(stub, {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      })
  })
}

describe('opencode plugin workflow stop-check (child process, stub control server)', () => {
  let scratch: string
  let statusDir: string
  let pluginUrl: string
  let stopDrive: string
  let stub: StubServer

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'harness-oc-stop-'))
    statusDir = join(scratch, 'status')
    const content = makePluginContent()
    const literal = "const STATUS_DIR = '/tmp/harness-status'"
    if (!content.includes(literal)) throw new Error('plugin no longer sets the status dir')
    const pluginPath = join(scratch, 'plugin.mjs')
    writeFileSync(pluginPath, content.replace(literal, `const STATUS_DIR = ${JSON.stringify(statusDir)}`))
    pluginUrl = pathToFileURL(pluginPath).href
    stopDrive = join(scratch, 'drive-stop.mjs')
    writeFileSync(stopDrive, STOP_CHECK_DRIVER)
  })

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true })
  })

  beforeEach(async () => {
    stub = await startStub()
  })

  afterEach(async () => {
    await stub.close()
  })

  function writeStepConfig(
    terminalId: string,
    { port = String(stub.port), token = TOKEN, marker = true }: { port?: string; token?: string; marker?: boolean } = {}
  ): string {
    const configPath = join(scratch, `${terminalId}.json`)
    const config = {
      mcpServers: {
        'harness-control': {
          command: process.execPath,
          args: ['/bridge.js'],
          env: { ELECTRON_RUN_AS_NODE: '1', HARNESS_PORT: port, HARNESS_TOKEN: token, HARNESS_TERMINAL_ID: terminalId }
        }
      }
    }
    writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    if (marker) {
      writeFileSync(join(scratch, `${terminalId}.step`), JSON.stringify({ runId: 'r', stepId: 's', attemptId: 'a' }), {
        mode: 0o600
      })
    }
    return configPath
  }

  async function idleRun(
    events: unknown[],
    env: Record<string, string>,
    options: { promptThrows?: boolean; promptError?: boolean; noPromptAsync?: boolean } = {}
  ): Promise<{ calls: Array<Record<string, unknown>>; lines: Array<Line & { continued?: boolean }>; elapsedMs: number }> {
    const started = Date.now()
    const { stdout } = await execFileAsync(
      process.execPath,
      [stopDrive, JSON.stringify({ events, ...options }), pluginUrl],
      { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8', timeout: 15_000 }
    )
    const elapsedMs = Date.now() - started
    const { calls } = JSON.parse(stdout.trim().split('\n').pop() as string)
    const file = join(statusDir, `${env.HARNESS_TERMINAL_ID}.ndjson`)
    const lines = existsSync(file)
      ? readFileSync(file, 'utf-8')
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => JSON.parse(l))
      : []
    return { calls, lines, elapsedMs }
  }

  const idleEvent = (sessionID: string) => ({ type: 'session.idle', properties: { sessionID } })
  const busyEvent = (sessionID: string) => ({
    type: 'session.status',
    properties: { sessionID, status: { type: 'busy' } }
  })
  const stepTerminal = () => 'oc-step-' + randomUUID()

  it('on a block reply sends one promptAsync to harness-step and writes a continued Stop line', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)

    const { calls, lines } = await idleRun([idleEvent('ses_root1')], {
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath
    })

    expect(calls).toEqual([
      { path: { id: 'ses_root1' }, body: { agent: 'harness-step', parts: [{ type: 'text', text: BLOCK_REASON }] } }
    ])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ event: 'Stop', continued: true })
    expect(lines[0].payload).toEqual({ session_id: 'ses_root1', last_assistant_message: 'partial' })
    expect(stub.requests).toHaveLength(1)
    const [request] = stub.requests
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/workflow/stop-check')
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(request.headers['x-harness-terminal-id']).toBe(terminalId)
    expect(request.headers['content-type']).toBe('application/json')
    expect(request.body).toEqual({
      session_id: 'ses_root1',
      last_assistant_message: 'partial',
      stop_hook_active: false
    })
  })

  it('reports the continuation turn as stop_hook_active so the next idle does not prompt again', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)

    const { calls, lines } = await idleRun([idleEvent('ses_root1'), busyEvent('ses_root1'), idleEvent('ses_root1')], {
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath
    })

    expect(calls).toHaveLength(1)
    expect(stub.requests.map((r) => r.body.stop_hook_active)).toEqual([false, true])
    expect(lines.map((l) => [l.event, l.continued])).toEqual([
      ['Stop', true],
      ['UserPromptSubmit', undefined],
      ['Stop', undefined]
    ])
  })

  it.each([
    ['no step marker', { marker: false }, true],
    ['no HARNESS_MCP_CONFIG', {}, false],
    ['a non-hex token', { token: 'not-a-token' }, true],
    ['a non-numeric port', { port: '80; rm -rf /' }, true]
  ])('with %s makes no request and writes a plain Stop line', async (_name, config, withEnv) => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId, config)
    const env: Record<string, string> = { HARNESS_TERMINAL_ID: terminalId }
    if (withEnv) env.HARNESS_MCP_CONFIG = configPath

    const { calls, lines } = await idleRun([idleEvent('ses_root1')], env)

    expect(stub.requests).toEqual([])
    expect(calls).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0].event).toBe('Stop')
    expect(lines[0]).not.toHaveProperty('continued')
  })

  it('fails open when the control server is down', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)
    await stub.close()

    const { calls, lines } = await idleRun([idleEvent('ses_root1')], {
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath
    })

    expect(calls).toEqual([])
    expect(lines.map((l) => [l.event, l.continued])).toEqual([['Stop', undefined]])
  })

  it('gives up after about 2 s on a slow control server and writes a plain Stop line', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)
    stub.reply = () => ({ delayMs: 5000, json: { decision: 'block', reason: BLOCK_REASON } })

    const { calls, lines, elapsedMs } = await idleRun([idleEvent('ses_root1')], {
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath
    })

    expect(stub.requests).toHaveLength(1)
    expect(calls).toEqual([])
    expect(lines.map((l) => [l.event, l.continued])).toEqual([['Stop', undefined]])
    expect(elapsedMs).toBeGreaterThanOrEqual(1900)
    expect(elapsedMs).toBeLessThan(4500)
  }, 15_000)

  it('does not prompt on a non-block reply', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)
    stub.reply = () => ({ json: {} })

    const { calls, lines } = await idleRun([idleEvent('ses_root1')], {
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath
    })

    expect(stub.requests).toHaveLength(1)
    expect(calls).toEqual([])
    expect(lines.map((l) => [l.event, l.continued])).toEqual([['Stop', undefined]])
  })

  it('writes a plain Stop line when promptAsync throws', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)

    const { calls, lines } = await idleRun(
      [idleEvent('ses_root1')],
      { HARNESS_TERMINAL_ID: terminalId, HARNESS_MCP_CONFIG: configPath },
      { promptThrows: true }
    )

    expect(calls).toHaveLength(1)
    expect(lines.map((l) => [l.event, l.continued])).toEqual([['Stop', undefined]])
  })

  it.each([
    ['resolves with an error result', { promptError: true }, 1],
    ['is missing from the client', { noPromptAsync: true }, 0]
  ])('writes a plain Stop line and re-asks on the next idle when promptAsync %s', async (_name, options, prompts) => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)

    const { calls, lines } = await idleRun(
      [idleEvent('ses_root1'), idleEvent('ses_root1')],
      { HARNESS_TERMINAL_ID: terminalId, HARNESS_MCP_CONFIG: configPath },
      options
    )

    expect(calls).toHaveLength(prompts * 2)
    expect(stub.requests.map((r) => r.body.stop_hook_active)).toEqual([false, false])
    expect(lines.map((l) => [l.event, l.continued])).toEqual([
      ['Stop', undefined],
      ['Stop', undefined]
    ])
  })

  it('never asks the control server about a subagent idle', async () => {
    const terminalId = stepTerminal()
    const configPath = writeStepConfig(terminalId)

    const { calls, lines } = await idleRun(
      [{ type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_root1' } } }, idleEvent('ses_child')],
      { HARNESS_TERMINAL_ID: terminalId, HARNESS_MCP_CONFIG: configPath }
    )

    expect(stub.requests).toEqual([])
    expect(calls).toEqual([])
    expect(lines).toEqual([])
  })
})
