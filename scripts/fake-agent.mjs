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
//
// A `FAKE_AGENT_MODE=<mode>` marker in the prompt picks another behaviour,
// because one shim serves every scenario of a server launch:
//   hang              stay alive, never run the Stop hook or complete_step;
//                     SIGHUP (agent cancel) ends it, a 5 min cap bounds leaks
//   exit-no-complete  run the Stop hook once (expects a block), then exit 1
//                     without complete_step, so the step fails by exit
//   multi-turn        Claude kind only. Turn 1 is the argv prompt and runs as
//                     the default mode does. After each completed turn the
//                     agent stays alive and reads stdin for the next prompt,
//                     then runs the Stop hook, calls complete_step again
//                     through a fresh bridge and runs the post-turn Stop hook.
//                     The pre-complete Stop hook must block on turn 1 only;
//                     on later turns the real stop-check may not block, so
//                     either reply is accepted and logged. The post-complete
//                     hook (stop_hook_active true) must never block. Turns are numbered from 1. The
//                     mode is read from the argv prompt only. SIGHUP or stdin
//                     EOF exits 0; the 5 min cap fails a leaked agent.
//                     A prompt is complete in one of two framings:
//                       bracketed  ESC[200~ <text> ESC[201~ immediately
//                                  followed by CR (\r) or LF (\n, what a
//                                  cooked tty turns CR into); the markers
//                                  are stripped, text may span lines
//                       plain      one line ended by CR (\r) or LF (\n)
//                     Empty lines between prompts are skipped. Anything
//                     other than CR or LF right after ESC[201~ fails the agent.
//                     When stdin is a TTY (a PTY) it is put in raw mode first,
//                     so there is no line buffering, CR to LF mapping or echo.
// `FAKE_AGENT_MODE_<KIND>=<mode>` (KIND = CLAUDE, CODEX or OPENCODE) applies
// only to that kind and wins over the plain marker, so one prompt can fail on
// one harness and complete on another.
//
// Output data (Claude kind only; Codex and opencode stay single-turn and
// ignore these markers): `FAKE_AGENT_DATA=<json>` in a turn's prompt adds the
// fields of that JSON object to the turn's complete_step arguments, and
// `FAKE_AGENT_DATA_<n>=<json>` applies only to turn n and wins over the plain
// marker per field. The JSON must be one object starting right after `=` and
// ending at its balanced closing brace (no whitespace after `=`); it may
// contain nested values and braces inside strings. Anything else fails the
// agent. Data fields win over the default `summary`. Markers are read from the
// prompt of the turn being run.
//
// FAKE_AGENT_TRANSCRIPT_DIR=<dir> (Claude kind only) makes each turn append a
// Claude-format assistant line with token usage to <dir>/<session id>.jsonl
// before the pre-complete Stop hook and another after complete_step, and pass
// that file as `transcript_path` in both Stop payloads, so cost tracking has
// usage to read. Unset, no transcript is written. With it set, the default
// mode stays alive briefly after the last Stop hook, as a real TUI does: the
// server deletes a terminal's status file when its process exits, so a Stop
// line written just before exit can go unread.
//
// FAKE_AGENT_KIND=codex (set by the `codex` shim) stands in for the `codex`
// CLI instead: it reads the harness-control MCP server from the
// `-c mcp_servers.harness-control.*` TOML overrides, requires the sandbox,
// approval and model flags, runs `$CODEX_HOME/harness-hook.sh` through the
// hooks.json commands (SessionStart with a fresh session id, then Stop) and
// calls complete_step. Only the default mode exists for Codex.
//
// FAKE_AGENT_KIND=opencode (set by the `opencode` shim) stands in for the
// `opencode` TUI: it requires `--agent harness-step` and `--model`, checks
// that OPENCODE_CONFIG_CONTENT defines that agent and the harness-control MCP
// server without the control token, loads the installed Tatsu plugin from
// $XDG_CONFIG_HOME/opencode/plugins with a fake client, fires a root
// session.idle and expects one promptAsync to harness-step, then calls
// complete_step through the bridge from OPENCODE_CONFIG_CONTENT. Only the
// default mode exists for opencode.

import { spawn, spawnSync } from 'child_process'
import { randomBytes, randomUUID } from 'crypto'
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { parse as parseToml } from 'smol-toml'

const TIMEOUT_MS = 30_000
const HANG_LIFETIME_MS = 5 * 60_000
const MODES = new Set(['default', 'hang', 'exit-no-complete', 'multi-turn'])
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
const HOOK_SIGNATURE = 'harness-status'
const CODEX_SERVER_PREFIX = 'mcp_servers.harness-control.'
const CODEX_DISCOVERY_SLACK_MS = 1500
const OPENCODE_STEP_AGENT = 'harness-step'
const OPENCODE_PLUGIN_SIGNATURE = '// harness-opencode-plugin'
const OPENCODE_ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const TRANSCRIPT_MODEL = 'claude-sonnet-4-5'
const PRE_COMPLETE_USAGE = { input_tokens: 10_000, output_tokens: 2_000 }
const POST_COMPLETE_USAGE = { input_tokens: 5_000, output_tokens: 1_000 }
const TRANSCRIPT_LINGER_MS = 1_000

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

function modeFrom(prompt, kind) {
  const scoped = new RegExp(`FAKE_AGENT_MODE_${kind.toUpperCase()}=([a-z-]+)`).exec(prompt ?? '')
  const match = scoped ?? /FAKE_AGENT_MODE=([a-z-]+)/.exec(prompt ?? '')
  const mode = match ? match[1] : 'default'
  if (!MODES.has(mode)) fail(`unknown FAKE_AGENT_MODE ${mode}`)
  return mode
}

function transcriptPath(sessionId) {
  const dir = process.env.FAKE_AGENT_TRANSCRIPT_DIR
  if (!dir) return null
  mkdirSync(dir, { recursive: true })
  return join(dir, `${sessionId}.jsonl`)
}

function appendUsage(path, text, usage) {
  if (!path) return
  const line = { type: 'assistant', message: { model: TRANSCRIPT_MODEL, usage, content: [{ type: 'text', text }] } }
  appendFileSync(path, JSON.stringify(line) + '\n')
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

function serverFromConfig(mcpConfigPath) {
  let config
  try {
    config = JSON.parse(readFileSync(mcpConfigPath, 'utf-8'))
  } catch (err) {
    fail(`cannot read MCP config ${mcpConfigPath}: ${err.message}`)
  }
  return config?.mcpServers?.['harness-control']
}

function startBridge(server) {
  if (!server || typeof server.command !== 'string') fail('no harness-control MCP server')
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

function balancedObjectEnd(text, start) {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return i + 1
  }
  return -1
}

function dataMarker(prompt, name) {
  const needle = `${name}=`
  const at = (prompt ?? '').indexOf(needle)
  if (at === -1) return {}
  const start = at + needle.length
  const end = prompt[start] === '{' ? balancedObjectEnd(prompt, start) : -1
  if (end === -1) fail(`${name} must be a JSON object right after =`)
  try {
    return JSON.parse(prompt.slice(start, end))
  } catch (err) {
    return fail(`${name} is not valid JSON: ${err.message}`)
  }
}

function turnData(prompt, turn) {
  return { ...dataMarker(prompt, 'FAKE_AGENT_DATA'), ...dataMarker(prompt, `FAKE_AGENT_DATA_${turn}`) }
}

function promptReader() {
  let buffer = ''
  let ended = false
  let wake = null
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    wake?.()
  })
  process.stdin.on('end', () => {
    ended = true
    wake?.()
  })
  function take() {
    buffer = buffer.replace(/^[\r\n]+/, '')
    if (buffer.startsWith(PASTE_START)) {
      const end = buffer.indexOf(PASTE_END)
      if (end === -1 || buffer.length === end + PASTE_END.length) return null
      if (!/[\r\n]/.test(buffer[end + PASTE_END.length])) fail('bracketed paste is not followed by CR or LF')
      const text = buffer.slice(PASTE_START.length, end)
      buffer = buffer.slice(end + PASTE_END.length + 1)
      return text
    }
    const eol = buffer.search(/[\r\n]/)
    if (eol === -1) return null
    const text = buffer.slice(0, eol)
    buffer = buffer.slice(eol + 1)
    return text
  }
  return async function next() {
    for (;;) {
      const text = take()
      if (text !== null) return text
      if (ended) return null
      await new Promise((resolve) => {
        wake = resolve
      })
      wake = null
    }
  }
}

async function completeStep(server, summary, data = {}) {
  const bridge = startBridge(server)
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
  const called = await bridge.request('tools/call', { name: 'complete_step', arguments: { summary, ...data } })
  if (called.error || called.result?.isError) fail(`complete_step failed: ${JSON.stringify(called)}`)
  log('complete_step: ok')
  bridge.close()
}

function parseCodexArgs(argv) {
  const out = { overrides: {}, sandbox: null, approval: null, model: null, resume: null, prompt: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-c') {
      const pair = argv[++i] ?? ''
      const eq = pair.indexOf('=')
      if (eq <= 0) fail(`malformed -c override ${JSON.stringify(pair)}`)
      try {
        out.overrides[pair.slice(0, eq)] = parseToml(`value = ${pair.slice(eq + 1)}`).value
      } catch (err) {
        fail(`-c ${pair.slice(0, eq)} is not a TOML value: ${err.message}`)
      }
    } else if (arg === '--sandbox') out.sandbox = argv[++i] ?? null
    else if (arg === '--ask-for-approval') out.approval = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === 'resume') out.resume = argv[++i] ?? null
    else if (arg.startsWith('-')) fail(`unexpected codex flag ${arg}`)
    else if (out.prompt === null) out.prompt = arg
    else fail('more than one positional prompt')
  }
  return out
}

function codexHookCommand(codexHome, event) {
  const path = join(codexHome, 'hooks.json')
  let hooks
  try {
    hooks = JSON.parse(readFileSync(path, 'utf-8'))
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`)
  }
  const expected = `bash '${join(codexHome, 'harness-hook.sh')}' ${event}`
  const entries = Array.isArray(hooks?.hooks?.[event]) ? hooks.hooks[event] : []
  for (const entry of entries) {
    for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
      if (hook?.command === expected) return hook.command
    }
  }
  fail(`no Tatsu ${event} hook ${JSON.stringify(expected)} in ${path}`)
}

async function mainCodex() {
  const args = parseCodexArgs(process.argv.slice(2))
  const mode = modeFrom(args.prompt, 'codex')
  if (mode !== 'default') fail(`codex supports only the default mode, got ${mode}`)
  if (!args.prompt) fail('missing prompt')
  if (args.sandbox !== 'read-only') fail(`--sandbox ${args.sandbox}, expected read-only`)
  if (args.approval !== 'never') fail(`--ask-for-approval ${args.approval}, expected never`)
  if (!args.model) fail('missing --model')
  const server = {
    command: args.overrides[`${CODEX_SERVER_PREFIX}command`],
    args: args.overrides[`${CODEX_SERVER_PREFIX}args`],
    env: args.overrides[`${CODEX_SERVER_PREFIX}env`]
  }
  if (!Array.isArray(server.args) || typeof server.env !== 'object') fail('incomplete harness-control overrides')
  if (args.overrides[`${CODEX_SERVER_PREFIX}default_tools_approval_mode`] !== 'approve') {
    fail('harness-control tools are not pre-approved')
  }
  const codexHomeEnv = process.env.CODEX_HOME
  if (!codexHomeEnv) fail('CODEX_HOME is not set')
  const codexHome = realpathSync(codexHomeEnv)
  const sessionId = args.resume ?? randomUUID()
  log(
    `start codex session=${sessionId} terminal=${process.env.HARNESS_TERMINAL_ID ?? ''} model=${args.model} sandbox=${args.sandbox}`
  )

  runStopHook(codexHookCommand(codexHome, 'SessionStart'), {
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    source: args.resume ? 'resume' : 'startup',
    cwd: process.cwd()
  })
  await new Promise((resolve) => setTimeout(resolve, CODEX_DISCOVERY_SLACK_MS))

  const stop = codexHookCommand(codexHome, 'Stop')
  const summary = `PLAN-OK ${sessionId}`
  const reply = runStopHook(stop, { session_id: sessionId, hook_event_name: 'Stop', last_assistant_message: summary })
  if (isBlock(reply)) {
    log('stop hook: block')
  } else if (curlPresent()) {
    fail(`Stop hook did not return a block: ${JSON.stringify(reply)}`)
  } else {
    log('::warning::curl is missing, so the Stop hook could not ask for a continuation')
  }

  await completeStep(server, summary)

  const after = runStopHook(stop, { session_id: sessionId, hook_event_name: 'Stop', last_assistant_message: summary })
  if (isBlock(after)) fail(`Stop hook blocked again after complete_step: ${after}`)
  log('done')
  process.exit(0)
}

function parseOpencodeArgs(argv) {
  const out = { agent: null, model: null, prompt: null, session: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--agent') out.agent = argv[++i] ?? null
    else if (arg === '--model') out.model = argv[++i] ?? null
    else if (arg === '--prompt') out.prompt = argv[++i] ?? null
    else if (arg === '--session') out.session = argv[++i] ?? null
    else fail(`unexpected opencode argument ${arg}`)
  }
  return out
}

function opencodeSessionId() {
  const bytes = randomBytes(26)
  return 'ses_' + Array.from(bytes, (b) => OPENCODE_ID_CHARS[b % OPENCODE_ID_CHARS.length]).join('')
}

function controlToken() {
  const path = process.env.HARNESS_MCP_CONFIG
  if (!path) fail('HARNESS_MCP_CONFIG is not set')
  const token = serverFromConfig(path)?.env?.HARNESS_TOKEN
  if (typeof token !== 'string' || !token) fail('no control token in the MCP config')
  return token
}

async function loadOpencodePlugin() {
  const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config')
  const path = join(configHome, 'opencode', 'plugins', 'harness-status.js')
  let content
  try {
    content = readFileSync(path, 'utf-8')
  } catch (err) {
    fail(`cannot read opencode plugin ${path}: ${err.message}`)
  }
  if (content.split('\n')[0] !== OPENCODE_PLUGIN_SIGNATURE) fail(`${path} is not the Tatsu plugin`)
  const mod = await import('data:text/javascript;base64,' + Buffer.from(content).toString('base64'))
  if (typeof mod.HarnessStatus !== 'function') fail('plugin does not export HarnessStatus')
  return mod.HarnessStatus
}

async function mainOpencode() {
  const args = parseOpencodeArgs(process.argv.slice(2))
  const mode = modeFrom(args.prompt, 'opencode')
  if (mode !== 'default') fail(`opencode supports only the default mode, got ${mode}`)
  if (!args.prompt) fail('missing --prompt')
  if (args.agent !== OPENCODE_STEP_AGENT) fail(`--agent ${args.agent}, expected ${OPENCODE_STEP_AGENT}`)
  if (!args.model) fail('missing --model')
  const raw = process.env.OPENCODE_CONFIG_CONTENT
  if (!raw) fail('OPENCODE_CONFIG_CONTENT is not set')
  const token = controlToken()
  if (raw.includes(token) || process.argv.some((arg) => arg.includes(token))) {
    fail('the control token leaked into OPENCODE_CONFIG_CONTENT or argv')
  }
  const config = JSON.parse(raw)
  const stepAgent = config?.agent?.[OPENCODE_STEP_AGENT]
  if (!stepAgent?.permission) fail(`OPENCODE_CONFIG_CONTENT has no ${OPENCODE_STEP_AGENT} agent permission map`)
  if (stepAgent.model !== args.model) fail(`${OPENCODE_STEP_AGENT} model ${stepAgent.model}, expected ${args.model}`)
  const mcp = config?.mcp?.['harness-control']
  if (!Array.isArray(mcp?.command) || mcp.command.length === 0) fail('no harness-control MCP server in OPENCODE_CONFIG_CONTENT')
  const server = { command: mcp.command[0], args: mcp.command.slice(1), env: mcp.environment ?? {} }

  const sessionId = args.session ?? opencodeSessionId()
  const summary = `PLAN-OK ${sessionId}`
  log(`start opencode session=${sessionId} terminal=${process.env.HARNESS_TERMINAL_ID ?? ''} model=${args.model}`)
  const prompts = []
  const client = {
    session: {
      messages: async () => ({ data: [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: summary }] }] }),
      promptAsync: async (request) => {
        prompts.push(request)
      }
    }
  }
  const HarnessStatus = await loadOpencodePlugin()
  const hooks = await HarnessStatus({ client })
  const fire = (type, properties) => hooks.event({ event: { type, properties } })
  const busy = () => fire('session.status', { sessionID: sessionId, status: { type: 'busy' } })

  await busy()
  await new Promise((resolve) => setTimeout(resolve, CODEX_DISCOVERY_SLACK_MS))
  await fire('session.idle', { sessionID: sessionId })
  if (prompts.length !== 1) fail(`expected one promptAsync after the first idle, got ${prompts.length}`)
  if (prompts[0]?.body?.agent !== OPENCODE_STEP_AGENT || prompts[0]?.path?.id !== sessionId) {
    fail(`promptAsync went to the wrong agent or session: ${JSON.stringify(prompts[0])}`)
  }
  log('plugin: promptAsync to harness-step')

  await busy()
  await completeStep(server, summary)
  await fire('session.idle', { sessionID: sessionId })
  if (prompts.length !== 1) fail(`plugin prompted again after complete_step (${prompts.length} prompts)`)
  log('done')
  process.exit(0)
}

async function main() {
  if (process.env.FAKE_AGENT_KIND === 'codex') return mainCodex()
  if (process.env.FAKE_AGENT_KIND === 'opencode') return mainOpencode()
  const args = parseArgs(process.argv.slice(2))
  if (!args.mcpConfig) fail('missing --mcp-config')
  if (!args.sessionId) fail('missing --session-id')
  const mode = modeFrom(args.prompt, 'claude')
  log(`start session=${args.sessionId} terminal=${process.env.HARNESS_TERMINAL_ID ?? ''} mode=${mode}`)

  if (mode === 'hang') {
    clearTimeout(timer)
    setTimeout(() => fail(`hang mode still alive after ${HANG_LIFETIME_MS} ms`), HANG_LIFETIME_MS)
    log('hang: waiting for a signal')
    return
  }

  const hook = stopHookCommand()
  const summary = `PLAN-OK ${args.sessionId}`
  const server = serverFromConfig(args.mcpConfig)
  const transcript = transcriptPath(args.sessionId)
  const transcriptField = transcript ? { transcript_path: transcript } : {}

  async function runTurn(prompt, turn) {
    const strict = turn === 1
    const data = turnData(prompt, turn)
    appendUsage(transcript, summary, PRE_COMPLETE_USAGE)
    const reply = runStopHook(hook, {
      session_id: args.sessionId,
      ...transcriptField,
      last_assistant_message: summary,
      stop_hook_active: false
    })
    if (isBlock(reply)) {
      log('stop hook: block')
    } else if (!strict) {
      log(`stop hook: no block on turn ${turn}`)
    } else if (curlPresent()) {
      fail(`Stop hook did not return a block: ${JSON.stringify(reply)}`)
    } else {
      log('::warning::curl is missing, so the Stop hook could not ask for a continuation')
    }

    if (mode === 'exit-no-complete') {
      log('exit-no-complete: exiting without complete_step')
      process.exit(1)
    }

    await completeStep(server, summary, data)

    appendUsage(transcript, summary, POST_COMPLETE_USAGE)
    const after = runStopHook(hook, {
      session_id: args.sessionId,
      ...transcriptField,
      last_assistant_message: summary,
      stop_hook_active: true
    })
    if (isBlock(after)) fail(`Stop hook blocked again after complete_step: ${after}`)
  }

  if (mode === 'multi-turn') {
    clearTimeout(timer)
    setTimeout(() => fail(`multi-turn still alive after ${HANG_LIFETIME_MS} ms`), HANG_LIFETIME_MS)
    process.on('SIGHUP', () => {
      log('multi-turn: SIGHUP')
      process.exit(0)
    })
    if (process.stdin.isTTY) process.stdin.setRawMode(true)
    const nextPrompt = promptReader()
    let prompt = args.prompt
    for (let turn = 1; ; turn++) {
      await runTurn(prompt, turn)
      log(`turn ${turn} done`)
      prompt = await nextPrompt()
      if (prompt === null) {
        log('multi-turn: stdin closed')
        process.exit(0)
      }
    }
  }

  await runTurn(args.prompt, 1)
  if (transcript) await new Promise((resolve) => setTimeout(resolve, TRANSCRIPT_LINGER_MS))
  log('done')
  process.exit(0)
}

const timer = setTimeout(() => fail(`timed out after ${TIMEOUT_MS} ms`), TIMEOUT_MS)
timer.unref()
main().catch((err) => fail(err instanceof Error ? err.stack ?? err.message : String(err)))
