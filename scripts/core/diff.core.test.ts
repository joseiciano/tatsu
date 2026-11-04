import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, it } from 'vitest'
import { WebSocket as WSClient } from 'ws'
import { WebSocketClientTransport } from '../../src/shared/transport/transport-websocket'
import { buildTestServer, passthroughShellHome, startTestServer } from './testserver'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const NODE_ENTRY = join(REPO_ROOT, 'dist-headless', 'main', 'index.js')
const SCRIPTS_DIR = join(REPO_ROOT, 'fixtures', 'core', 'scripts')
const NodeWebSocket = WSClient as unknown as typeof WebSocket

const CORE_EVENT_PREFIXES = ['settings/', 'onboarding/', 'hooks/', 'repoConfigs/', 'scratchpad/']
// Node's GitHub module resolves auth at boot (a `gh auth token` probe with a
// 3 s timeout) and reports it as these settings/* events, which can land after
// the quiet period. The core test server has no GitHub module, so they are not
// core-owned; with no token both snapshots keep these fields at null.
const GITHUB_OWNED_SETTINGS_EVENTS = new Set([
  'settings/githubAuthSourceChanged',
  'settings/hasGithubTokenChanged',
  'settings/viewerLoginChanged',
  'settings/harnessStarredChanged'
])
const CORE_SLICES = ['settings', 'onboarding', 'hooks', 'repoConfigs', 'scratchpad'] as const
const DATA_DIR_COPIES = ['config.json', 'activity.json', 'secrets.enc', '.secret-key', 'themes']
const NODE_URL_LINE = /\[web-client\] open http:\/\/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9]+)/
const QUIET_MS = 1_500
const QUIET_TIMEOUT_MS = 30_000
// Longer than both sides' write delays: config save debounce (500 ms) and the
// activity.json save delay (1000 ms).
const FLUSH_MS = 1_500
const BARRIER_CHANNEL = 'connections:getActive'
const START_TIMEOUT_MS = 30_000
const STOP_TIMEOUT_MS = 5_000
const TEST_TIMEOUT_MS = 600_000
const SCRUBBED_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'OPENCODE_CONFIG_DIR',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_HOST',
  'HARNESS_WS_TRANSPORT',
  'HARNESS_WS_PORT',
  'HARNESS_WS_HOST',
  'HARNESS_DATA_DIR',
  'ZDOTDIR',
  'GH_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME'
]

const DEFAULT_CONFIG = {
  schemaVersion: 9,
  windowBounds: null,
  repoRoots: [],
  harnessConfig: { version: 1, resources: [] },
  connections: [{ id: 'local', label: 'Local', url: '', kind: 'local', addedAt: 1767225600000 }],
  activeBackendId: 'local',
  hooksConsent: 'pending',
  hooksMigratedToGlobal: true
}

type Step =
  | { channel: string; args?: unknown[] }
  | { signal: string; args?: unknown[] }
  | { wait: number }

interface Script {
  note?: string
  data?: Record<string, unknown>
  files?: Record<string, unknown>
  steps: Step[]
}

type Reply = { value: unknown } | { noValue: true } | { error: string }

interface StepResult {
  label: string
  reply?: Reply
  events: unknown[]
}

interface SideResult {
  steps: StepResult[]
  slices: Record<string, unknown>
  files: Record<string, string | null>
}

interface Sandbox {
  root: string
  dataA: string
  dataB: string
  repos: string
  tmp: string
}

interface Backend {
  url: string
  token: string
  stop: () => Promise<void>
}

function scriptPaths(): string[] {
  const one = process.env.CORE_DIFF_SCRIPT
  if (one) return [resolve(REPO_ROOT, one)]
  return readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => join(SCRIPTS_DIR, f))
}

function substitute(text: string, sandbox: Sandbox): string {
  return text.split('$SANDBOX').join(sandbox.root)
}

function loadScript(path: string, sandbox: Sandbox): Script {
  return JSON.parse(substitute(readFileSync(path, 'utf8'), sandbox)) as Script
}

function writeSeed(base: string, files: Record<string, unknown> | undefined): void {
  for (const [rel, content] of Object.entries(files ?? {})) {
    const path = join(base, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
  }
}

function makeSandbox(script: string): { sandbox: Sandbox; script: Script } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tatsu-core-diff-')))
  const sandbox: Sandbox = {
    root,
    dataA: join(root, 'data-node'),
    dataB: join(root, 'data-rust'),
    repos: join(root, 'repos'),
    tmp: join(root, 'tmp')
  }
  for (const dir of [sandbox.dataA, sandbox.dataB, sandbox.repos, sandbox.tmp]) mkdirSync(dir)
  const parsed = loadScript(script, sandbox)
  writeSeed(sandbox.dataA, { 'config.json': DEFAULT_CONFIG, ...parsed.data })
  writeSeed(sandbox.root, parsed.files)
  return { sandbox, script: parsed }
}

function backendEnv(sandbox: Sandbox): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: sandbox.tmp }
  for (const key of SCRUBBED_ENV) delete env[key]
  return env
}

function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((done) => {
    const timer = setTimeout(() => done(false), ms)
    child.once('exit', () => {
      clearTimeout(timer)
      done(true)
    })
  })
}

async function startNode(sandbox: Sandbox): Promise<Backend> {
  const home = passthroughShellHome()
  const child = spawn(process.execPath, [NODE_ENTRY, '--port', '0', '--host', '127.0.0.1'], {
    cwd: sandbox.tmp,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...backendEnv(sandbox),
      HARNESS_DATA_DIR: sandbox.dataA,
      HOME: home,
      SHELL: join(home, 'fake-login-shell')
    }
  })
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM')
    if (!(await waitForExit(child, STOP_TIMEOUT_MS))) {
      child.kill('SIGKILL')
      await waitForExit(child, STOP_TIMEOUT_MS)
    }
    rmSync(home, { recursive: true, force: true })
  }
  try {
    const [, port, token] = await new Promise<RegExpExecArray>((done, fail) => {
      let out = ''
      const timer = setTimeout(() => fail(new Error(`Node backend printed no URL: ${out}`)), START_TIMEOUT_MS)
      const onData = (chunk: Buffer): void => {
        out += chunk.toString()
        const match = NODE_URL_LINE.exec(out)
        if (match) {
          clearTimeout(timer)
          done(match)
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.once('exit', (code) => fail(new Error(`Node backend exited (${code}): ${out}`)))
    })
    return { url: `ws://127.0.0.1:${port}`, token, stop }
  } catch (e) {
    await stop()
    throw e
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function isCoreEvent(event: unknown): boolean {
  const type = (event as { type?: unknown }).type
  return (
    typeof type === 'string' &&
    !GITHUB_OWNED_SETTINGS_EVENTS.has(type) &&
    CORE_EVENT_PREFIXES.some((p) => type.startsWith(p))
  )
}

interface Session {
  transport: WebSocketClientTransport
  events: unknown[]
  lastEventAt: () => number
}

async function connect(backend: Backend): Promise<Session> {
  const transport = new WebSocketClientTransport({
    url: backend.url,
    token: backend.token,
    WebSocketCtor: NodeWebSocket,
    initialBackoffMs: 20,
    maxBackoffMs: 100
  })
  await transport.connect()
  const events: unknown[] = []
  let last = Date.now()
  transport.onStateEvent((event) => {
    if (!isCoreEvent(event)) return
    last = Date.now()
    events.push(event)
  })
  return { transport, events, lastEventAt: () => last }
}

async function waitQuiet(session: Session): Promise<void> {
  const deadline = Date.now() + QUIET_TIMEOUT_MS
  while (Date.now() - session.lastEventAt() < QUIET_MS) {
    if (Date.now() > deadline) throw new Error('Node backend never went quiet on core-owned events')
    await sleep(100)
  }
}

async function request(session: Session, channel: string, args: unknown[]): Promise<Reply> {
  try {
    const value = await session.transport.request(channel, ...args)
    return value === undefined ? { noValue: true } : { value }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

async function runSteps(session: Session, steps: Step[]): Promise<StepResult[]> {
  const results: StepResult[] = []
  for (const [i, step] of steps.entries()) {
    session.events.length = 0
    if ('wait' in step) {
      await sleep(step.wait)
      results.push({ label: `step ${i}: wait ${step.wait}`, events: session.events.splice(0) })
      continue
    }
    const args = step.args ?? []
    if ('signal' in step) {
      session.transport.send(step.signal, ...args)
      // Signals have no reply; a read-only request behind it marks the point
      // where the server has handled the signal and sent its events.
      await request(session, BARRIER_CHANNEL, [])
      results.push({ label: `step ${i}: signal ${step.signal} ${JSON.stringify(args)}`, events: session.events.splice(0) })
      continue
    }
    const reply = await request(session, step.channel, args)
    results.push({ label: `step ${i}: ${step.channel} ${JSON.stringify(args)}`, reply, events: session.events.splice(0) })
  }
  return results
}

function readTree(dir: string, name: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name === name) out[relative(dir, path)] = readFileSync(path, 'utf8')
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function readOptional(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

async function runSide(backend: Backend, steps: Step[], sandbox: Sandbox, dataDir: string): Promise<SideResult> {
  const session = await connect(backend)
  let stepResults: StepResult[]
  let slices: Record<string, unknown>
  try {
    stepResults = await runSteps(session, steps)
    const snapshot = await session.transport.getStateSnapshot()
    const state = snapshot.state as unknown as Record<string, unknown>
    slices = Object.fromEntries(CORE_SLICES.map((s) => [s, state[s]]))
    await sleep(FLUSH_MS)
  } finally {
    session.transport.close()
    await backend.stop()
  }
  const files: Record<string, string | null> = { 'config.json': readOptional(join(dataDir, 'config.json')) }
  for (const [rel, text] of Object.entries(readTree(sandbox.repos, '.harness.json'))) files[`repos/${rel}`] = text
  return { steps: stepResults, slices, files }
}

async function runNode(sandbox: Sandbox, steps: Step[]): Promise<{ result: SideResult; token: string }> {
  const backend = await startNode(sandbox)
  const session = await connect(backend).catch(async (e) => {
    await backend.stop()
    throw e
  })
  try {
    await waitQuiet(session)
  } catch (e) {
    session.transport.close()
    await backend.stop()
    throw e
  }
  session.transport.close()
  for (const name of DATA_DIR_COPIES) {
    const from = join(sandbox.dataA, name)
    if (existsSync(from)) cpSync(from, join(sandbox.dataB, name), { recursive: true })
  }
  cpSync(sandbox.repos, `${sandbox.repos}.boot`, { recursive: true })
  const result = await runSide(backend, steps, sandbox, sandbox.dataA)
  return { result, token: backend.token }
}

// Both sides run one after the other against the same repos folder, so the
// repo paths in requests, replies, events and files are identical. The Node
// run's repos are set aside and the post-boot copy is put back for Rust.
function resetRepos(sandbox: Sandbox): void {
  renameSync(sandbox.repos, `${sandbox.repos}.node`)
  renameSync(`${sandbox.repos}.boot`, sandbox.repos)
}

async function runRust(sandbox: Sandbox, steps: Step[], token: string): Promise<SideResult> {
  const server = await startTestServer({ dataDir: sandbox.dataB, tokenInDataDir: token, env: backendEnv(sandbox) })
  return runSide(server, steps, sandbox, sandbox.dataB)
}

const show = (v: unknown): string => JSON.stringify(v, null, 2) ?? 'undefined'

function byteDiff(name: string, node: string | null, rust: string | null, sandbox: Sandbox): string {
  const dir = join(sandbox.root, 'byte-diff')
  mkdirSync(dir, { recursive: true })
  const a = join(dir, 'node')
  const b = join(dir, 'rust')
  writeFileSync(a, node ?? '')
  writeFileSync(b, rust ?? '')
  const out = spawnSync('diff', ['-u', '--label', `node/${name}`, '--label', `rust/${name}`, a, b], { encoding: 'utf8' })
  const missing = [node === null ? 'missing on node' : '', rust === null ? 'missing on rust' : ''].filter(Boolean)
  return `file ${name}${missing.length ? ` (${missing.join(', ')})` : ''}\n${out.stdout}`
}

function differences(node: SideResult, rust: SideResult, sandbox: Sandbox): string[] {
  const out: string[] = []
  for (const [i, n] of node.steps.entries()) {
    const r = rust.steps[i]
    const parts: string[] = []
    if (show(n.reply) !== show(r.reply)) parts.push(`  expected reply (node): ${show(n.reply)}\n  actual reply (rust):   ${show(r.reply)}`)
    if (show(n.events) !== show(r.events)) parts.push(`  expected events (node): ${show(n.events)}\n  actual events (rust):   ${show(r.events)}`)
    if (parts.length) out.push(`${n.label}\n${parts.join('\n')}`)
  }
  for (const slice of CORE_SLICES) {
    if (show(node.slices[slice]) !== show(rust.slices[slice])) {
      out.push(`snapshot slice ${slice}\n  expected (node): ${show(node.slices[slice])}\n  actual (rust):   ${show(rust.slices[slice])}`)
    }
  }
  const names = [...new Set([...Object.keys(node.files), ...Object.keys(rust.files)])].sort()
  for (const name of names) {
    const a = node.files[name] ?? null
    const b = rust.files[name] ?? null
    if (a !== b) out.push(byteDiff(name, a, b, sandbox))
  }
  return out
}

beforeAll(() => {
  if (!existsSync(NODE_ENTRY)) throw new Error(`${NODE_ENTRY} is missing; run pnpm build:headless first`)
  buildTestServer()
}, TEST_TIMEOUT_MS)

describe('core differential: Node headless backend vs Rust core test server', () => {
  const sandboxes: string[] = []
  afterAll(() => {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
  })

  for (const path of scriptPaths()) {
    it(
      relative(REPO_ROOT, path),
      async () => {
        const { sandbox, script } = makeSandbox(path)
        sandboxes.push(sandbox.root)
        const { result: node, token } = await runNode(sandbox, script.steps)
        resetRepos(sandbox)
        const rust = await runRust(sandbox, script.steps, token)
        const diffs = differences(node, rust, sandbox)
        if (diffs.length > 0) throw new Error(`${diffs.length} difference(s) between Node and Rust:\n\n${diffs.join('\n\n')}`)
      },
      TEST_TIMEOUT_MS
    )
  }
})
