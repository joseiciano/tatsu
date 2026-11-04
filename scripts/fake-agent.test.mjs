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

function startControl({ stepStatus = 200, onComplete = () => {} } = {}) {
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
        if (req.url === '/workflow/complete') {
          onComplete()
          return json(res, 200, { ok: true })
        }
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

function spawnAgent({ home, mcpConfig, sessionId = 'sess-1', env = {}, prompt = 'Plan the work', stdin = false }) {
  const args = ['--allowedTools', 'Read,Grep', '--permission-mode', 'dontAsk', '--model', 'x', '--name', 'repo/main']
  if (mcpConfig) args.push('--mcp-config', mcpConfig)
  if (sessionId) args.push('--session-id', sessionId)
  args.push('--append-system-prompt', 'sys', '--', prompt)
  const child = spawn(process.execPath, [FAKE_AGENT, ...args], {
    env: { PATH: process.env.PATH, HOME: home, HARNESS_TERMINAL_ID: 'term-1', ...env },
    stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (c) => (stderr += c))
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, stderr })))
  return { child, exited, stderr: () => stderr }
}

function runAgent(options) {
  return spawnAgent(options).exited
}

const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

async function waitFor(check, what) {
  for (let i = 0; i < 200; i++) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`timed out waiting for ${what}`)
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

  async function setup({ firstReply = BLOCK, stepStatus = 200, onComplete } = {}) {
    control = await startControl({ stepStatus, onComplete })
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

  it('writes a priced transcript under the given dir and passes it to both Stop hooks, growing it after complete_step', async () => {
    const transcriptDir = join(dir, '.claude', 'projects', 'fake')
    const transcript = join(transcriptDir, 'sess-cost.jsonl')
    let linesAtComplete = 0
    const mcpConfig = await setup({
      onComplete: () => {
        linesAtComplete = readFileSync(transcript, 'utf-8').split('\n').filter(Boolean).length
      }
    })

    const { code, stderr } = await runAgent({
      home: dir,
      mcpConfig,
      sessionId: 'sess-cost',
      env: { FAKE_AGENT_TRANSCRIPT_DIR: transcriptDir }
    })

    if (code !== 0) throw new Error(stderr)
    expect(linesAtComplete).toBe(1)
    expect(payload(1).transcript_path).toBe(transcript)
    expect(payload(2).transcript_path).toBe(transcript)
    const lines = readFileSync(transcript, 'utf-8').split('\n')
    expect(lines.at(-1)).toBe('')
    const usages = lines.filter(Boolean).map((line) => JSON.parse(line))
    expect(usages).toHaveLength(2)
    for (const line of usages) {
      expect(line).toMatchObject({ type: 'assistant', message: { model: 'claude-sonnet-4-5' } })
      expect(line.message.usage.input_tokens).toBeGreaterThan(0)
    }
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

  it('a Claude-scoped marker picks the Claude mode', async () => {
    const mcpConfig = await setup()
    const scoped = await runAgent({ home: dir, mcpConfig, prompt: 'FAKE_AGENT_MODE_CLAUDE=exit-no-complete Leave' })
    expect(scoped.code).not.toBe(0)
    expect(scoped.stderr).toContain('mode=exit-no-complete')
    expect(completions()).toEqual([])
  })

  it('ignores a marker scoped to another kind', async () => {
    const mcpConfig = await setup()
    const other = await runAgent({ home: dir, mcpConfig, prompt: 'FAKE_AGENT_MODE_CODEX=hang Plan' })
    expect(other.stderr).toContain('mode=default')
    if (other.code !== 0) throw new Error(other.stderr)
    expect(completions()).toHaveLength(1)
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

  it('adds FAKE_AGENT_DATA fields to complete_step, the numbered marker winning', async () => {
    const mcpConfig = await setup()

    const { code, stderr } = await runAgent({
      home: dir,
      mcpConfig,
      sessionId: 'sess-d',
      prompt: 'FAKE_AGENT_DATA={"verdict":"fail","n":{"a":"}"}} FAKE_AGENT_DATA_1={"verdict":"pass"} go'
    })

    if (code !== 0) throw new Error(stderr)
    expect(completions()[0].body).toEqual({ summary: 'PLAN-OK sess-d', verdict: 'pass', n: { a: '}' } })
  })

  it('fails loudly on malformed data JSON without completing', async () => {
    const mcpConfig = await setup()

    for (const prompt of ['FAKE_AGENT_DATA={"verdict":', 'FAKE_AGENT_DATA_1=[1]', 'FAKE_AGENT_DATA={nope}']) {
      const { code, stderr } = await runAgent({ home: dir, mcpConfig, prompt })
      expect(code).not.toBe(0)
      expect(stderr).toContain('FAKE_AGENT_DATA')
    }
    expect(completions()).toEqual([])
  })

  describe('multi-turn mode', () => {
    async function setupMultiTurn({ turnTwoReply = BLOCK } = {}) {
      const mcpConfig = await setup()
      writeFileSync(join(dir, 'reply-3'), turnTwoReply)
      writeFileSync(join(dir, 'reply-4'), '')
      writeFileSync(join(dir, 'reply-5'), BLOCK)
      writeFileSync(join(dir, 'reply-6'), '')
      return mcpConfig
    }

    it('completes a second turn from a bracketed paste with that prompt markers, then exits on SIGHUP', async () => {
      const mcpConfig = await setupMultiTurn()
      const agent = spawnAgent({
        home: dir,
        mcpConfig,
        sessionId: 'sess-m',
        stdin: true,
        prompt: 'FAKE_AGENT_MODE=multi-turn FAKE_AGENT_DATA_1={"verdict":"fail"} FAKE_AGENT_DATA_2={"verdict":"ignored"} one'
      })

      await waitFor(() => completions().length === 1, 'turn 1')
      const half = `${PASTE_START}line one\nFAKE_AGENT_DATA_2={"verdict":"pass"}`
      agent.child.stdin.write(half)
      await new Promise((r) => setTimeout(r, 150))
      expect(completions()).toHaveLength(1)
      agent.child.stdin.write(`${PASTE_END}`)
      await new Promise((r) => setTimeout(r, 150))
      expect(completions()).toHaveLength(1)
      agent.child.stdin.write('\r')
      await waitFor(() => completions().length === 2, 'turn 2')
      await waitFor(() => existsSync(join(dir, 'payload-4.json')), 'turn 2 stop hook payload')
      agent.child.kill('SIGHUP')
      const { code, stderr } = await agent.exited

      if (code !== 0) throw new Error(stderr)
      expect(completions().map((c) => c.body)).toEqual([
        { summary: 'PLAN-OK sess-m', verdict: 'fail' },
        { summary: 'PLAN-OK sess-m', verdict: 'pass' }
      ])
      expect(payload(3).stop_hook_active).toBe(false)
      expect(payload(4).stop_hook_active).toBe(true)
    })

    it('completes turn 2 when its Stop hook does not block, and accepts LF after the paste end', async () => {
      const mcpConfig = await setupMultiTurn({ turnTwoReply: '' })
      const agent = spawnAgent({ home: dir, mcpConfig, stdin: true, prompt: 'FAKE_AGENT_MODE=multi-turn one' })

      await waitFor(() => completions().length === 1, 'turn 1')
      agent.child.stdin.write(`${PASTE_START}FAKE_AGENT_DATA={"verdict":"pass"}${PASTE_END}\n`)
      await waitFor(() => completions().length === 2, 'turn 2')
      agent.child.kill('SIGHUP')
      const { code, stderr } = await agent.exited

      if (code !== 0) throw new Error(stderr)
      expect(stderr).toContain('stop hook: no block on turn 2')
      expect(completions()[1].body).toEqual({ summary: 'PLAN-OK sess-1', verdict: 'pass' })
    })

    it('completes a turn from a plain line and exits 0 when stdin closes', async () => {
      const mcpConfig = await setupMultiTurn()
      const agent = spawnAgent({
        home: dir,
        mcpConfig,
        stdin: true,
        prompt: 'FAKE_AGENT_MODE=multi-turn FAKE_AGENT_DATA={"round":0} one'
      })

      await waitFor(() => completions().length === 1, 'turn 1')
      agent.child.stdin.write('\nFAKE_AGENT_DATA_2={"round":2}\n')
      await waitFor(() => completions().length === 2, 'turn 2')
      agent.child.stdin.end()
      const { code, stderr } = await agent.exited

      if (code !== 0) throw new Error(stderr)
      expect(completions().map((c) => c.body.round)).toEqual([0, 2])
    })

    it('fails when a bracketed paste is not followed by CR', async () => {
      const mcpConfig = await setupMultiTurn()
      const agent = spawnAgent({ home: dir, mcpConfig, stdin: true, prompt: 'FAKE_AGENT_MODE=multi-turn one' })

      await waitFor(() => completions().length === 1, 'turn 1')
      agent.child.stdin.write(`${PASTE_START}x${PASTE_END}y`)
      const { code, stderr } = await agent.exited

      expect(code).not.toBe(0)
      expect(stderr).toContain('not followed by CR or LF')
    })
  })
})
