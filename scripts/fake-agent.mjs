#!/usr/bin/env node
// Stand-in for the `claude` CLI in the headless workflow smoke test.
//
// Accepts the flags Tatsu passes to Claude and ignores the ones it does not
// need. One turn: run the installed Stop hook (expects a continuation block),
// then call complete_step through the MCP bridge named in --mcp-config, then
// run the Stop hook again as the post-turn status line and exit 0.
//
// FAKE_AGENT_LOG=<file> appends progress lines to a file (the PTY output is
// otherwise only visible in the terminal history). Without curl the Stop hook
// cannot reach the stop-check route and fails open, so a missing block only
// warns; FAKE_AGENT_CURL=present|absent overrides the curl detection.

import { spawn, spawnSync } from 'child_process'
import { appendFileSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

const TIMEOUT_MS = 30_000
const HOOK_SIGNATURE = 'harness-status'

function log(message) {
  const line = `[fake-agent] ${message}`
  process.stderr.write(line + '\n')
  const file = process.env.FAKE_AGENT_LOG
  if (file) {
    try {
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Logging must not change the outcome.
    }
  }
}

function fail(message) {
  log(`FAIL: ${message}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = { mcpConfig: null, sessionId: null, prompt: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      out.prompt = argv.slice(i + 1).join(' ')
      break
    }
    if (arg === '--mcp-config') out.mcpConfig = argv[++i] ?? null
    else if (arg === '--session-id') out.sessionId = argv[++i] ?? null
  }
  return out
}

function stopHookCommand() {
  const path = join(process.env.HOME || homedir(), '.claude', 'settings.json')
  let settings
  try {
    settings = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`)
  }
  const entries = Array.isArray(settings?.hooks?.Stop) ? settings.hooks.Stop : []
  for (const entry of entries) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (typeof hook?.command === 'string' && hook.command.includes(HOOK_SIGNATURE)) return hook.command
    }
  }
  fail(`no Tatsu Stop hook in ${path}`)
}

function curlPresent() {
  const forced = process.env.FAKE_AGENT_CURL
  if (forced === 'present') return true
  if (forced === 'absent') return false
  return spawnSync('bash', ['-c', 'command -v curl'], { stdio: 'ignore' }).status === 0
}

function runStopHook(command, payload) {
  const result = spawnSync('bash', ['-c', command], {
    input: JSON.stringify(payload),
    encoding: 'utf-8',
    timeout: 10_000
  })
  if (result.error) fail(`Stop hook did not run: ${result.error.message}`)
  if (result.status !== 0) fail(`Stop hook exited ${result.status}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function isBlock(reply) {
  if (!reply) return false
  try {
    return JSON.parse(reply).decision === 'block'
  } catch {
    return false
  }
}

function startBridge(mcpConfigPath) {
  let config
  try {
    config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
  } catch (err) {
    fail(`cannot read MCP config ${mcpConfigPath}: ${err.message}`)
  }
  const server = config?.mcpServers?.['harness-control']
  if (!server || typeof server.command !== 'string') fail('MCP config has no harness-control server')
  const child = spawn(server.command, Array.isArray(server.args) ? server.args : [], {
    env: { ...process.env, ...(server.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit']
  })
  const waiting = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf-8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const resolve = waiting.get(msg.id)
      if (resolve) {
        waiting.delete(msg.id)
        resolve(msg)
      }
    }
  })
  child.on('error', (err) => fail(`MCP bridge did not start: ${err.message}`))
  child.on('exit', (code) => {
    if (waiting.size > 0) fail(`MCP bridge exited (${code}) with requests pending`)
  })
  let nextId = 1
  return {
    request(method, params) {
      const id = nextId++
      return new Promise((resolve) => {
        waiting.set(id, resolve)
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    },
    close() {
      child.stdin.end()
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.mcpConfig) fail('missing --mcp-config')
  if (!args.sessionId) fail('missing --session-id')
  log(`start session=${args.sessionId} terminal=${process.env.HARNESS_TERMINAL_ID ?? ''}`)

  const hook = stopHookCommand()
  const summary = `PLAN-OK ${args.sessionId}`
  const reply = runStopHook(hook, {
    session_id: args.sessionId,
    last_assistant_message: summary,
    stop_hook_active: false
  })
  if (isBlock(reply)) {
    log('stop hook: block')
  } else if (curlPresent()) {
    fail(`Stop hook did not return a block: ${JSON.stringify(reply)}`)
  } else {
    log('::warning::curl is missing, so the Stop hook could not ask for a continuation')
  }

  const bridge = startBridge(args.mcpConfig)
  const init = await bridge.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fake-agent', version: '0' }
  })
  if (init.error) fail(`initialize failed: ${JSON.stringify(init.error)}`)
  const listed = await bridge.request('tools/list', {})
  const tools = listed.result?.tools ?? []
  if (!tools.some((tool) => tool.name === 'complete_step')) {
    fail(`complete_step not listed (tools: ${tools.map((tool) => tool.name).join(',')})`)
  }
  const called = await bridge.request('tools/call', { name: 'complete_step', arguments: { summary } })
  if (called.error || called.result?.isError) fail(`complete_step failed: ${JSON.stringify(called)}`)
  log('complete_step: ok')
  bridge.close()

  const after = runStopHook(hook, { session_id: args.sessionId, last_assistant_message: summary, stop_hook_active: true })
  if (isBlock(after)) fail(`Stop hook blocked again after complete_step: ${after}`)
  log('done')
  process.exit(0)
}

const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS)
timer.unref()
main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))
