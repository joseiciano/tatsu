import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest'
import { spawn, execFileSync } from 'child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { randomBytes, randomUUID } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AddressInfo } from 'net'
import { makeHookCommand } from '.'

vi.mock('../debug', () => ({ log: vi.fn() }))

const BASH = '/bin/bash'
const SYSTEM_PATH = '/usr/bin:/bin'

function which(tool: string): string | null {
  try {
    return execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { env: { PATH: SYSTEM_PATH } })
      .toString()
      .trim()
  } catch {
    return null
  }
}

const REAL_CURL = which('curl')
const canRun = existsSync(BASH) && REAL_CURL !== null

const BLOCK_REPLY = '{"decision":"block","reason":"Call complete_step with your result, or with status needs-input and what you need."}'
const PAYLOAD = JSON.stringify({ session_id: 's1', stop_hook_active: false, last_assistant_message: 'it is 100% "done"' })

interface Received {
  url: string
  method: string
  headers: IncomingMessage['headers']
  body: string
  ndjsonAtArrival: string
}

interface RunResult {
  code: number | null
  stdout: string
  ms: number
}

function stopInner(): string {
  return makeHookCommand('Stop').replace(/^bash -c '/, '').replace(/'$/, '')
}

function runStop(env: Record<string, string>, payload = PAYLOAD): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(BASH, ['--noprofile', '--norc', '-c', stopInner()], { env, stdio: ['pipe', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }))
    child.stdin.end(payload)
  })
}

describe.skipIf(!canRun)('Stop hook command with a stub control server', () => {
  let scratch: string
  let configDir: string
  let shimDir: string
  let noCurlDir: string
  let curlLog: string
  let server: Server
  let port = 0
  let reply: (res: ServerResponse) => void
  let pendingTimers: NodeJS.Timeout[] = []
  let received: Received[] = []
  let terminalId = ''
  let token = ''
  let configPath = ''
  let ndjson = ''

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'stop-hook-'))
    shimDir = join(scratch, 'shim')
    noCurlDir = join(scratch, 'no-curl')
    mkdirSync(shimDir)
    mkdirSync(noCurlDir)
    curlLog = join(scratch, 'curl-args.log')
    const shim = join(shimDir, 'curl')
    writeFileSync(shim, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${curlLog}'\nexec '${REAL_CURL}' "$@"\n`)
    chmodSync(shim, 0o755)
    for (const tool of ['cat', 'sed', 'mkdir', 'date']) {
      const real = which(tool)
      if (real) symlinkSync(real, join(noCurlDir, tool))
    }
    server = createServer((req, res) => {
      const chunks: Buffer[] = []
      const ndjsonAtArrival = existsSync(ndjson) ? readFileSync(ndjson, 'utf-8') : ''
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received.push({
          url: req.url ?? '',
          method: req.method ?? '',
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf-8'),
          ndjsonAtArrival
        })
        reply(res)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(scratch, { recursive: true, force: true })
  })

  beforeEach(() => {
    received = []
    pendingTimers = []
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(BLOCK_REPLY)
    }
    terminalId = `vitest-stop-${randomUUID()}`
    token = randomBytes(32).toString('hex')
    configDir = mkdtempSync(join(scratch, 'configs-'))
    configPath = writeConfig(port)
    writeFileSync(`${configPath.replace(/\.json$/, '')}.step`, '{}', { mode: 0o600 })
    ndjson = `/tmp/harness-status/${terminalId}.ndjson`
    rmSync(curlLog, { force: true })
  })

  afterEach(() => {
    for (const timer of pendingTimers) clearTimeout(timer)
    server.closeAllConnections()
    rmSync(ndjson, { force: true })
    rmSync(configDir, { recursive: true, force: true })
  })

  function writeConfig(configPort: number): string {
    const path = join(configDir, `${terminalId}.json`)
    const config = {
      mcpServers: {
        'harness-control': {
          command: '/bin/false',
          args: ['/bundle/mcp-bridge.js'],
          env: {
            ELECTRON_RUN_AS_NODE: '1',
            HARNESS_PORT: String(configPort),
            HARNESS_TOKEN: token,
            HARNESS_TERMINAL_ID: terminalId,
            HARNESS_SESSION_ID: terminalId
          }
        }
      }
    }
    writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 })
    return path
  }

  function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
    const base: Record<string, string | undefined> = {
      PATH: `${shimDir}:${SYSTEM_PATH}`,
      HOME: scratch,
      HARNESS_TERMINAL_ID: terminalId,
      HARNESS_MCP_CONFIG: configPath,
      ...overrides
    }
    return Object.fromEntries(Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined))
  }

  function ndjsonLines(): Array<Record<string, unknown>> {
    return readFileSync(ndjson, 'utf-8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  function expectPlainStopLine(): void {
    const lines = ndjsonLines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toEqual({ event: 'Stop', ts: expect.any(Number), payload: JSON.parse(PAYLOAD) })
  }

  it('prints the block reply, sends the payload with header auth, and appends the NDJSON line after the request', async () => {
    const result = await runStop(env())
    expect(result.code).toBe(0)
    expect(result.stdout).toBe(`${BLOCK_REPLY}\n`)
    expect(received).toHaveLength(1)
    const [request] = received
    expect(request.method).toBe('POST')
    expect(request.url).toBe('/workflow/stop-check')
    expect(request.body).toBe(PAYLOAD)
    expect(request.headers.authorization).toBe(`Bearer ${token}`)
    expect(request.headers['x-harness-terminal-id']).toBe(terminalId)
    expect(request.ndjsonAtArrival).toBe('')
    const lines = ndjsonLines()
    expect(lines).toEqual([{ event: 'Stop', ts: expect.any(Number), continued: true, payload: JSON.parse(PAYLOAD) }])
  })

  it('never puts the token on argv', async () => {
    await runStop(env())
    expect(received).toHaveLength(1)
    const args = readFileSync(curlLog, 'utf-8')
    expect(args).toContain('/workflow/stop-check')
    expect(args).not.toContain(token)
    expect(args).not.toContain('Authorization')
    expect(args).not.toContain('100%')
    expect(makeHookCommand('Stop')).not.toContain(token)
  })

  it('prints nothing and writes a plain line when the server answers with no block', async () => {
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    }
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(received).toHaveLength(1)
    expectPlainStopLine()
  })

  it('prints nothing when the server rejects the request with an error body', async () => {
    reply = (res) => {
      res.writeHead(401)
      res.end(BLOCK_REPLY)
    }
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expectPlainStopLine()
  })

  it.each([
    { name: 'the MCP config env is unset', overrides: { HARNESS_MCP_CONFIG: undefined } },
    { name: 'curl is not on PATH', overrides: {} as Record<string, string>, noCurl: true }
  ])('exits 0 silently without a request when $name', async ({ overrides, noCurl }) => {
    const result = await runStop(env(noCurl ? { ...overrides, PATH: noCurlDir } : overrides))
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.ms).toBeLessThan(2500)
    expect(received).toEqual([])
    expectPlainStopLine()
  })

  it('exits 0 silently without a request when the step marker is absent', async () => {
    rmSync(`${configPath.replace(/\.json$/, '')}.step`)
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.ms).toBeLessThan(2500)
    expect(received).toEqual([])
    expectPlainStopLine()
  })

  it('exits 0 silently within 2.5 s when the server is down', async () => {
    const dead = createServer()
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve))
    const deadPort = (dead.address() as AddressInfo).port
    await new Promise<void>((resolve) => dead.close(() => resolve()))
    writeConfig(deadPort)
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.ms).toBeLessThan(2500)
    expectPlainStopLine()
  })

  it('exits 0 silently within 2.5 s when the server replies after 5 s', async () => {
    reply = (res) => {
      pendingTimers.push(
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(BLOCK_REPLY)
        }, 5000)
      )
    }
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(result.ms).toBeLessThan(2500)
    expect(received).toHaveLength(1)
    expectPlainStopLine()
  })

  it('makes no request when the config holds a port or token outside the expected charset', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { x: { env: { HARNESS_PORT: `${port}`, HARNESS_TOKEN: 'NOT-HEX\r\nX-Evil: 1' } } } }, null, 2)
    )
    const result = await runStop(env())
    expect(result).toMatchObject({ code: 0, stdout: '' })
    expect(received).toEqual([])
    expectPlainStopLine()
  })
})
