import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createServer, type Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../debug', () => ({ log: vi.fn() }))
vi.mock('../../hooks', () => ({ cleanupTerminalLog: vi.fn() }))
vi.mock('../../persistence', () => ({
  saveTerminalHistory: vi.fn(),
  loadTerminalHistory: vi.fn(() => null),
  clearTerminalHistory: vi.fn()
}))

import { PtyManager } from '../../pty-manager'
import { Store } from '../../store'
import { initialState } from '../../../shared/state'
import { validateWorkflowDefinition, type ResolvedAgentStep } from '../../../shared/workflow-def'
import { PROMPT_INLINE_MAX_BYTES, createClaudeStepDriver, sanitizePasteText, stepPromptPath, type StepAttempt } from '.'

let hasPty = true
try {
  await import('node-pty')
} catch {
  hasPty = false
}

const FAKE_AGENT = fileURLToPath(new URL('../../../../scripts/fake-agent.mjs', import.meta.url))
const BRIDGE = fileURLToPath(new URL('../../../../resources/mcp-bridge.js', import.meta.url))
const BLOCK = '{"decision":"block","reason":"Call complete_step"}'
const STEP_SCHEMA = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] }

interface Control {
  port: number
  completions: Array<Record<string, unknown>>
  server: Server
}

function startControl(): Promise<Control> {
  return new Promise((resolve) => {
    const completions: Array<Record<string, unknown>> = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const reply = (status: number, body: unknown): void => {
          res.writeHead(status, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        if (req.url === '/scope') return reply(200, { scope: null, browser: { enabled: false, mode: 'view' } })
        if (req.url === '/workflow/step') return reply(200, { attemptId: 'att-1', stepId: 'plan', inputSchema: STEP_SCHEMA })
        if (req.url === '/workflow/complete') {
          completions.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>)
          return reply(200, { ok: true })
        }
        reply(404, { error: 'not found' })
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ port: typeof address === 'object' && address ? address.port : 0, completions, server })
    })
  })
}

function stopHook(dir: string, replies: string[]): string {
  replies.forEach((reply, i) => writeFileSync(join(dir, `reply-${i + 1}`), reply))
  const counter = join(dir, 'replies')
  writeFileSync(counter, '0')
  return [
    ': harness-status',
    `n=$(( $(cat "${counter}") + 1 )); printf "%s" "$n" > "${counter}"`,
    `cat > "${dir}/payload-$n.json"`,
    `cat "${dir}/reply-$n"`
  ].join('; ')
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

function turnTwoPrompt(): { prompt: string; note: string } {
  const filler = 'Ünïcödé 漢字 línea\tcon tab\n'.repeat(165)
  const note = `${'é漢'.repeat(400)} end\x1b[201~mid\x9b201~tail`
  const prompt = `Request changes:\r\n${filler}FAKE_AGENT_DATA_2={"verdict":"pass","note":"${note}"}\nthanks`
  return { prompt, note: sanitizePasteText(note) }
}

let home: string
let ptyManager: PtyManager
let control: Control | undefined

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'agent-pty-'))
  mkdirSync(join(home, '.claude'))
  ptyManager = new PtyManager()
})

afterEach(async () => {
  ptyManager.killAll('SIGKILL')
  if (control) await new Promise<void>((resolve) => control?.server.close(() => resolve()))
  control = undefined
  rmSync(home, { recursive: true, force: true })
})

describe.skipIf(!hasPty)('agent step continue on a real PTY', () => {
  it('delivers a large multi-line paste through the driver to the multi-turn fake agent', async () => {
    const ctl = await startControl()
    control = ctl
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: stopHook(home, [BLOCK, '', '', '']) }] }] } })
    )
    const mcpConfig = join(home, 'mcp.json')
    writeFileSync(
      mcpConfig,
      JSON.stringify({
        mcpServers: {
          'harness-control': {
            command: process.execPath,
            args: [BRIDGE],
            env: { HARNESS_PORT: String(ctl.port), HARNESS_TOKEN: 'tok', HARNESS_TERMINAL_ID: 'pty-step' }
          }
        }
      })
    )
    const agentLog = join(home, 'agent.log')
    const store = new Store({ ...initialState, hooks: { ...initialState.hooks, consent: 'accepted' } })
    const driver = createClaudeStepDriver({
      addTab: (worktreePath, tab, spawn) => {
        ptyManager.create(
          tab.id,
          worktreePath,
          process.execPath,
          [FAKE_AGENT, '--mcp-config', mcpConfig, '--session-id', spawn.sessionId ?? '', '--', spawn.initialPrompt ?? ''],
          { HOME: home, FAKE_AGENT_LOG: agentLog }
        )
      },
      hasTerminal: (id) => ptyManager.hasTerminal(id),
      onExit: (listener) => ptyManager.onExit(listener),
      kill: (id, signal) => ptyManager.kill(id, signal),
      onStopEvent: () => () => {},
      onPromptSubmit: () => () => {},
      store,
      checkFolderTrust: async () => ({ status: 'trusted' }),
      writeMarker: () => {},
      removeMarker: () => {},
      writePromptFile: async () => {
        throw new Error('the turn 2 prompt must stay inline')
      },
      write: (id, data) => ptyManager.write(id, data),
      newTabId: () => 'pty-step',
      newSessionId: () => randomUUID(),
      log: () => {}
    })
    const source = `name: pty
steps:
  - id: plan
    agent: claude
    permissions: edit
    prompt: "FAKE_AGENT_MODE=multi-turn FAKE_AGENT_DATA_1={\\"verdict\\":\\"fail\\"} one"
`
    const step = validateWorkflowDefinition(source).definition?.steps[0] as ResolvedAgentStep
    const attempt = (attemptId: string, n: number): StepAttempt => ({
      runId: 'run-1',
      stepId: 'plan',
      attemptId,
      n,
      worktreePath: home,
      inputs: {},
      step,
      scope: { inputs: {}, steps: {}, run: { id: 'run-1', worktree: home, contextPath: join(home, 'ctx.md') } },
      bind: () => true
    })

    const { executionId, sessionId } = await driver.start(attempt('att-1', 1))
    await waitFor(() => ctl.completions.length === 1, 'turn 1')
    driver.release(executionId)
    const { prompt, note } = turnTwoPrompt()
    const sanitizedBytes = Buffer.byteLength(sanitizePasteText(prompt), 'utf8')
    expect(sanitizedBytes).toBeGreaterThan(7000)
    expect(sanitizedBytes).toBeLessThanOrEqual(PROMPT_INLINE_MAX_BYTES)

    await driver.continue(attempt('att-2', 2), executionId, prompt)
    await waitFor(() => ctl.completions.length === 2, 'turn 2')

    expect(ctl.completions).toEqual([
      { summary: `PLAN-OK ${sessionId}`, verdict: 'fail' },
      { summary: `PLAN-OK ${sessionId}`, verdict: 'pass', note }
    ])
    expect(note).toContain('[201~mid201~tail')
    expect(existsSync(stepPromptPath(home, 'run-1', 'plan'))).toBe(false)
    await waitFor(() => readFileSync(agentLog, 'utf8').includes('turn 2 done'), 'turn 2 post Stop hook')
    expect(readFileSync(agentLog, 'utf8')).not.toContain('FAIL')
    expect(ptyManager.hasTerminal(executionId)).toBe(true)
    driver.dispose()
  }, 45_000)
})
