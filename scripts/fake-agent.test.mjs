import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const here = dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT = join(here, 'fake-agent.mjs')
const BRIDGE = join(here, '..', 'resources', 'mcp-bridge.js')
const STEP_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }
const BLOCK = '{"decision":"block","reason":"Call complete_step"}'

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function startControl({ stepStatus = 200 } = {}) {
  return new Promise((resolve) => {
    const captured = []
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
        captured.push({ method: req.method, url: req.url, terminalId: req.headers['x-harness-terminal-id'], body })
        if (req.url === '/scope') return json(res, 200, { scope: null, browser: { enabled: false, mode: 'view' } })
        if (req.url === '/workflow/step') {
          if (stepStatus === 200) return json(res, 200, { attemptId: 'att-1', stepId: 'plan', inputSchema: STEP_SCHEMA })
          return json(res, 404, { error: 'not a workflow step' })
        }
        if (req.url === '/workflow/complete') return json(res, 200, { ok: true })
        json(res, 404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, captured, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

function stopHook(dir, firstReply) {
  const replies = join(dir, 'replies')
  writeFileSync(join(dir, 'reply-1'), firstReply)
  writeFileSync(join(dir, 'reply-2'), '')
  writeFileSync(replies, '0')
  return [
    `: harness-status`,
    `n=$(( $(cat "${replies}") + 1 )); printf "%s" "$n" > "${replies}"`,
    `cat > "${dir}/payload-$n.json"`,
    `cat "${dir}/reply-$n"`
  ].join('; ')
}

function spawnAgent({ home, mcpConfig, sessionId = 'sess-1', env = {}, prompt = 'Plan the work' }) {
  const args = ['--allowedTools', 'Read,Grep', '--permission-mode', 'dontAsk', '--model', 'x', '--name', 'repo/main']
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  if (sessionId) args.push('--session-id', sessionId)
  args.push('--append-system-prompt', 'sys', '--', prompt)
  const child = spawn(process.execPath, [FAKE_AGENT, ...args], {
    env: { PATH: process.env.PATH, HOME: home, HARNESS_TERMINAL_ID: 'term-1', ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })))
  return { child, exited, stderr: () => stderr }
}

function runAgent(options) {
  return spawnAgent(options).exited
}

describe('fake-agent', () => {
  let dir
  let control

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-agent-'))
    mkdirSync(join(dir, '.claude'))
  })

  afterEach(async () => {
    await control?.close()
    control = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  async function setup({ firstReply = BLOCK, stepStatus = 200 } = {}) {
    control = await startControl({ stepStatus })
    writeFileSync(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [
            { hooks: [{ type: 'command', command: 'exit 7' }] },
            { hooks: [{ type: 'command', command: stopHook(dir, firstReply) }] }
          ]
        }
      })
    )
    const mcpConfig = join(dir, 'mcp.json')
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          'harness-control': {
            command: process.execPath,
            args: [BRIDGE],
            env: { HARNESS_PORT: String(control.port), HARNESS_TOKEN: 'tok', HARNESS_TERMINAL_ID: 'term-1' }
          }
        }
      })
    )
    return mcpConfig
  }

  const payload = (n) => JSON.parse(readFileSync(join(dir, `payload-${n}.json`), 'utf-8'))
  const completions = () => control.captured.filter((c) => c.url === '/workflow/complete')

  it('runs the Stop hook, completes the step through the bridge and exits 0', async () => {
    const mcpConfig = await setup()

    const { code, stderr } = await runAgent({ home: dir, mcpConfig, sessionId: 'sess-42' })

    expect(stderr).toContain('stop hook: block')
    if (code !== 0) throw new Error(stderr)
    expect(payload(1)).toEqual({ session_id: 'sess-42', last_assistant_message: 'PLAN-OK sess-42', stop_hook_active: false })
    expect(completions()).toEqual([
      expect.objectContaining({ method: 'POST', terminalId: 'term-1', body: { summary: 'PLAN-OK sess-42' } })
    ])
    expect(payload(2).stop_hook_active).toBe(true)
  })

  it('fails without completing when the Stop hook does not block and curl is present', async () => {
    const mcpConfig = await setup({ firstReply: '' })

    const { code, stderr } = await runAgent({ home: dir, mcpConfig, env: { FAKE_AGENT_CURL: 'present' } })

    expect(code).not.toBe(0)
    expect(stderr).toContain('did not return a block')
    expect(completions()).toEqual([])
  })

  it('warns and still completes when the Stop hook does not block and curl is absent', async () => {
    const mcpConfig = await setup({ firstReply: '' })

    const { code, stderr } = await runAgent({ home: dir, mcpConfig, env: { FAKE_AGENT_CURL: 'absent' } })

    if (code !== 0) throw new Error(stderr)
    expect(stderr).toContain('::warning::')
    expect(completions()).toHaveLength(1)
  })

  it('fails when the bridge does not list complete_step', async () => {
    const mcpConfig = await setup({ stepStatus: 404 })

    const { code, stderr } = await runAgent({ home: dir, mcpConfig })

    expect(code).not.toBe(0)
    expect(stderr).toContain('complete_step not listed')
    expect(completions()).toEqual([])
  })

  it('fails when no Tatsu Stop hook is installed', async () => {
    const mcpConfig = await setup()
    writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }))

    const { code, stderr } = await runAgent({ home: dir, mcpConfig })

    expect(code).not.toBe(0)
    expect(stderr).toContain('no Tatsu Stop hook')
    expect(existsSync(join(dir, 'payload-1.json'))).toBe(false)
  })

  it('hang mode stays alive without completing until SIGHUP ends it', async () => {
    const mcpConfig = await setup()

    const agent = spawnAgent({ home: dir, mcpConfig, prompt: 'FAKE_AGENT_MODE=hang Stay alive' })
    const early = await Promise.race([agent.exited, new Promise((r) => setTimeout(() => r('alive'), 1000))])
    expect(early).toBe('alive')
    expect(agent.stderr()).toContain('mode=hang')
    agent.child.kill('SIGHUP')
    const { signal } = await agent.exited

    expect(signal).toBe('SIGHUP')
    expect(completions()).toEqual([])
    expect(existsSync(join(dir, 'payload-1.json'))).toBe(false)
  })

  it('exit-no-complete mode runs the Stop hook once and exits non-zero without completing', async () => {
    const mcpConfig = await setup()

    const { code, stderr } = await runAgent({ home: dir, mcpConfig, prompt: 'FAKE_AGENT_MODE=exit-no-complete Leave' })

    expect(code).not.toBe(0)
    expect(stderr).toContain('stop hook: block')
    expect(stderr).toContain('exit-no-complete: exiting without complete_step')
    expect(existsSync(join(dir, 'payload-1.json'))).toBe(true)
    expect(existsSync(join(dir, 'payload-2.json'))).toBe(false)
    expect(completions()).toEqual([])
  })

  it('exit-no-complete mode reports a missing block when curl is present', async () => {
    const mcpConfig = await setup({ firstReply: '' })

    const { code, stderr } = await runAgent({
      home: dir,
      mcpConfig,
      prompt: 'FAKE_AGENT_MODE=exit-no-complete Leave',
      env: { FAKE_AGENT_CURL: 'present' }
    })

    expect(code).not.toBe(0)
    expect(stderr).toContain('did not return a block')
    expect(completions()).toEqual([])
  })
})
