import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createServer } from 'http'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { AGENT_REGISTRY } from '../src/shared/agent-registry'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BRIDGE = join(__dirname, 'mcp-bridge.js')

function startStub(handler) {
  return new Promise((resolve) => {
    const captured = []
    const server = createServer((req, res) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
        captured.push({
          method: req.method,
          url: req.url,
          auth: req.headers.authorization,
          terminalId: req.headers['x-harness-terminal-id'],
          body
        })
        try {
          handler(req, body, res, captured)
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: String(e) }))
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      resolve({ port, captured, close: () => new Promise((r) => server.close(() => r())) })
    })
  })
}

function spawnBridge(port, token) {
  return spawnBridgeWith([], {
    ...process.env,
    HARNESS_PORT: String(port),
    HARNESS_TOKEN: token,
    HARNESS_TERMINAL_ID: 'test-terminal'
  })
}

function envWithoutHarness(extra = {}) {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('HARNESS_')) env[k] = v
  return { ...env, ...extra }
}

function spawnBridgeWith(extraArgs, env) {
  const proc = spawn(process.execPath, [BRIDGE, ...extraArgs], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdoutBuf = ''
  let stderr = ''
  let exitCode
  const responses = []
  const pending = []
  const exited = new Promise((resolve) => {
    proc.once('exit', (code) => {
      exitCode = code
      while (pending.length) {
        pending.shift().reject(new Error(`bridge exited with code ${code}: ${stderr}`))
      }
      resolve({ code, stderr })
    })
  })
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString()
    let idx
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx)
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (pending.length) {
          pending.shift().resolve(msg)
        } else {
          responses.push(msg)
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  })
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString()
  })
  function send(msg) {
    if (exitCode === undefined) proc.stdin.write(JSON.stringify(msg) + '\n')
  }
  function next() {
    return new Promise((resolve, reject) => {
      if (responses.length) resolve(responses.shift())
      else if (exitCode !== undefined) reject(new Error(`bridge exited with code ${exitCode}: ${stderr}`))
      else pending.push({ resolve, reject })
    })
  }
  function kill() {
    if (exitCode !== undefined) return Promise.resolve()
    proc.kill()
    return exited.then(() => undefined)
  }
  return { send, next, kill, proc, exited }
}

describe('mcp-bridge create_worktree', () => {
  let stub
  let bridge

  afterEach(async () => {
    if (bridge) await bridge.kill()
    if (stub) await stub.close()
  })

  it('forwards prNumber to POST /worktrees and reports PR # in result text', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt', branch: 'feature/pr-head' }))
    })
    bridge = spawnBridge(stub.port, 'secret-token')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 47, initialPrompt: 'review please' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    expect(response.result.content[0].text).toContain('PR #47')
    expect(response.result.content[0].text).toContain('/tmp/wt')
    expect(response.result.content[0].text).toContain('feature/pr-head')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.auth).toBe('Bearer secret-token')
    expect(postCall.terminalId).toBe('test-terminal')
    expect(postCall.body.prNumber).toBe(47)
    expect(postCall.body.initialPrompt).toBe('review please')
  })

  it('still supports the new-branch flow when prNumber is absent', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-new', branch: 'mybranch' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'mybranch' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    const text = response.result.content[0].text
    expect(text).toContain('/tmp/wt-new')
    expect(text).toContain('mybranch')
    expect(text).not.toContain('PR #')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall.body.branchName).toBe('mybranch')
    expect(postCall.body.prNumber).toBeUndefined()
  })

  it('returns an error when neither branchName nor prNumber is provided', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: {} }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/branchName or prNumber/)
  })

  it('rejects non-integer prNumber locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'create_worktree', arguments: { prNumber: -3 } }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/positive integer/)
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it.each([
    { agentKind: 'claude', displayLabel: 'Claude' },
    { agentKind: 'codex', displayLabel: 'Codex' },
    { agentKind: 'opencode', displayLabel: 'OpenCode' },
    { agentKind: 'pi', displayLabel: 'Pi' }
  ])('forwards $agentKind and reports $displayLabel in result text', async ({ agentKind, displayLabel }) => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-agent', branch: 'feat' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind, model: 'test-model' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    const text = response.result.content[0].text
    expect(text).toContain(displayLabel)
    expect(text).toContain('test-model')

    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.body.agentKind).toBe(agentKind)
    expect(postCall.body.model).toBe('test-model')
  })
  it('rejects unknown agentKind locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: 'gemini' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/claude.*codex/i)
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it('normalises a padded mixed-case agentKind before forwarding it', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-agent', branch: 'feat' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: '  OpenCode ' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    expect(response.result.content[0].text).toContain('OpenCode chat tab')
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.body.agentKind).toBe('opencode')
  })

  it('treats an empty agentKind as unset and omits it from the POST body', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ path: '/tmp/wt-agent', branch: 'feat' }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: '' }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBeFalsy()
    expect(response.result.content[0].text).toContain('new agent chat tab')
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeDefined()
    expect(postCall.body).not.toHaveProperty('agentKind')
  })

  it('rejects a non-string agentKind locally without hitting the server', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { branchName: 'feat', agentKind: 42 }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('agentKind must be a string')
    const postCall = stub.captured.find((c) => c.method === 'POST' && c.url === '/worktrees')
    expect(postCall).toBeUndefined()
  })

  it('advertises exactly the AGENT_REGISTRY kinds in the create_worktree agentKind enum', async () => {
    stub = await startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const response = await bridge.next()

    const tool = response.result.tools.find((t) => t.name === 'create_worktree')
    expect(tool.inputSchema.properties.agentKind.enum).toEqual(AGENT_REGISTRY.map((a) => a.kind))
  })

  it('surfaces server-side PR failures back to the caller', async () => {
    stub = await startStub((req, body, res) => {
      if (req.url === '/scope') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
      }
      res.writeHead(422, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: "Couldn't fetch PR #99999 from GitHub" }))
    })
    bridge = spawnBridge(stub.port, 'tok')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await bridge.next()
    bridge.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_worktree',
        arguments: { prNumber: 99999 }
      }
    })
    const response = await bridge.next()

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toMatch(/HTTP 422/)
    expect(response.result.content[0].text).toMatch(/99999/)
  })
})

describe('mcp-bridge --config', () => {
  let stub
  let bridge
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-bridge-config-'))
  })

  afterEach(async () => {
    if (bridge) await bridge.kill()
    bridge = undefined
    if (stub) await stub.close()
    stub = undefined
    rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(name, contents) {
    const file = join(dir, name)
    writeFileSync(file, JSON.stringify(contents))
    return file
  }

  function harnessConfig(port) {
    return {
      mcpServers: {
        'harness-control': {
          command: process.execPath,
          args: [BRIDGE],
          env: {
            HARNESS_PORT: String(port),
            HARNESS_TOKEN: 'file-tok',
            HARNESS_TERMINAL_ID: 'file-term'
          }
        }
      }
    }
  }

  function reposStub() {
    return startStub((req, body, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (req.url === '/repos') return res.end(JSON.stringify({ repos: [] }))
      res.end(JSON.stringify({ scope: null, browser: { enabled: true, mode: 'full' } }))
    })
  }

  async function callListRepos(b) {
    b.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await b.next()
    b.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_repos', arguments: {} } })
    return b.next()
  }

  it('loads port, token and terminal id from the config file when the spawn env has none', async () => {
    stub = await reposStub()
    const file = writeConfig('term.json', harnessConfig(stub.port))
    bridge = spawnBridgeWith(['--config', file], envWithoutHarness())

    const response = await callListRepos(bridge)

    expect(response.result.isError).toBeFalsy()
    const call = stub.captured.find((c) => c.method === 'GET' && c.url === '/repos')
    expect(call).toBeDefined()
    expect(call.auth).toBe('Bearer file-tok')
    expect(call.terminalId).toBe('file-term')
  })

  it('prefers config file values over HARNESS_* already in the spawn env', async () => {
    stub = await reposStub()
    const file = writeConfig('term.json', harnessConfig(stub.port))
    bridge = spawnBridgeWith(
      ['--config', file],
      envWithoutHarness({
        HARNESS_PORT: String(stub.port),
        HARNESS_TOKEN: 'env-tok',
        HARNESS_TERMINAL_ID: 'env-term'
      })
    )

    await callListRepos(bridge)

    const call = stub.captured.find((c) => c.method === 'GET' && c.url === '/repos')
    expect(call).toBeDefined()
    expect(call.auth).toBe('Bearer file-tok')
    expect(call.terminalId).toBe('file-term')
  })

  it.each([
    { name: 'a missing file', makeFile: () => '/nonexistent.json' },
    {
      name: 'a file without mcpServers.harness-control.env',
      makeFile: () => writeConfig('no-env.json', { mcpServers: { 'harness-control': { command: 'x' } } })
    },
    { name: 'a file that is not JSON', makeFile: () => { const f = join(dir, 'bad.json'); writeFileSync(f, '{nope'); return f } }
  ])('exits 1 on $name even when the spawn env would work', async ({ makeFile }) => {
    stub = await reposStub()
    bridge = spawnBridgeWith(
      ['--config', makeFile()],
      envWithoutHarness({ HARNESS_PORT: String(stub.port), HARNESS_TOKEN: 'env-tok' })
    )
    bridge.proc.stdin.end()

    const { code, stderr } = await bridge.exited

    expect(code).toBe(1)
    expect(stderr).toContain('cannot read --config')
  })
})
