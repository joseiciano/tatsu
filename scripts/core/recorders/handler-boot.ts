import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { vi } from 'vitest'
import type { StateEvent } from '../../../src/shared/state'
import type { Worktree } from '../../../src/shared/state/worktrees'
import type { RequestHandler, SignalHandler } from '../../../src/shared/transport/transport'
import { loadAndSave } from './config'
import {
  CASE_ROOT_TOKEN,
  type HandlerCase,
  type HandlerExpected,
  type HandlerReply,
  type LogLine
} from './handler-types'

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const MAIN = join(ROOT, 'src/main')
const THEMES_FIXTURES = join(ROOT, 'fixtures/core/themes')
const realSetTimeout = globalThis.setTimeout.bind(globalThis)
const realSetImmediate = globalThis.setImmediate.bind(globalThis)

export const HOOKS_INSTALLER_ERROR = 'hooks installer failed (fixture)'
export const DEFAULT_WS_BOUND = { host: '127.0.0.1', port: 0 }
const CLIENT_ID = 'core-recorder'

class RecorderFault extends Error {}

interface CaseState {
  inHandler: boolean
  recording: boolean
  events: StateEvent[]
  saves: string[]
  dispatchCount: number
  store: { dispatch: (event: StateEvent) => void } | null
  requests: Map<string, RequestHandler>
  signals: Map<string, SignalHandler>
  secrets: Map<string, string>
  ids: string[]
  randomBytes: string[]
  bootRandomCount: number
  hooksInstaller: 'ok' | 'throw' | undefined
  worktrees: Worktree[]
  fault: string | null
  wsBound: { host: string; port: number } | null
}

const state: CaseState = freshState()

function freshState(): CaseState {
  return {
    inHandler: false,
    recording: false,
    events: [],
    saves: [],
    dispatchCount: 0,
    store: null,
    requests: new Map(),
    signals: new Map(),
    secrets: new Map(),
    ids: [],
    randomBytes: [],
    bootRandomCount: 0,
    hooksInstaller: undefined,
    worktrees: [],
    fault: null,
    wsBound: DEFAULT_WS_BOUND
  }
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function fault(message: string): never {
  state.fault = message
  throw new RecorderFault(message)
}

function nextId(): string {
  if (state.inHandler) {
    const id = state.ids.shift()
    if (id === undefined) fault('fixture `ids` exhausted: add more ids to the case')
    return id
  }
  state.bootRandomCount += 1
  return `00000000-0000-4000-8000-${state.bootRandomCount.toString().padStart(12, '0')}`
}

function nextBytes(size: number): Buffer {
  if (state.inHandler) {
    const hex = state.randomBytes.shift()
    if (hex === undefined) fault('fixture `randomBytes` exhausted: add more hex strings to the case')
    const bytes = Buffer.from(hex, 'hex')
    if (bytes.length !== size || bytes.toString('hex') !== hex.toLowerCase()) {
      fault(`fixture \`randomBytes\` entry must be ${size} bytes of hex, got ${JSON.stringify(hex)}`)
    }
    return bytes
  }
  return Buffer.alloc(size, 0x5a)
}

const mainPath = (pkg: string): string => join(MAIN, pkg, 'index.ts')

function registerMocks(): void {
  const cryptoFactory = async (importOriginal: () => Promise<typeof import('node:crypto')>) => {
    const actual = await importOriginal()
    const overrides = {
      randomUUID: () => nextId(),
      randomBytes: (size: number) => nextBytes(size)
    }
    return { ...actual, ...overrides, default: { ...actual, ...overrides } }
  }
  vi.doMock('crypto', cryptoFactory)
  vi.doMock('node:crypto', cryptoFactory)

  vi.doMock('electron', () => {
    const noop = (): void => {}
    return {
      app: {
        isPackaged: false,
        on: noop,
        whenReady: () => new Promise(() => {}),
        getPath: () => process.env.HARNESS_DATA_DIR,
        setPath: noop,
        getVersion: () => '0.0.0'
      },
      autoUpdater: { on: noop },
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null },
      dialog: {},
      Menu: { setApplicationMenu: noop, buildFromTemplate: () => ({}) },
      nativeImage: {},
      nativeTheme: { on: noop },
      screen: {},
      shell: {},
      session: {},
      ipcMain: { on: noop, handle: noop },
      WebContentsView: class {}
    }
  })
  vi.doMock('electron-updater', () => ({ autoUpdater: { on: () => {} } }))

  vi.doMock(mainPath('transport-compound'), () => ({
    CompoundServerTransport: class {
      onRequest(name: string, handler: RequestHandler): void {
        state.requests.set(name, handler)
      }
      onSignal(name: string, handler: SignalHandler): void {
        state.signals.set(name, handler)
      }
      start(): void {}
      stop(): void {}
      broadcastStateEvent(): void {}
      sendSignal(): void {}
      onClientDisconnect(): void {}
    }
  }))
  vi.doMock(mainPath('transport-websocket'), () => ({
    WebSocketServerTransport: class {
      private readonly token: string
      constructor(_store: unknown, opts: { token: string }) {
        this.token = opts.token
      }
      start(): void {}
      stop(): void {}
      getPort(): number {
        return state.wsBound?.port ?? 0
      }
      getToken(): string {
        return this.token
      }
      getHost(): string {
        return state.wsBound?.host ?? ''
      }
    }
  }))
  vi.doMock(mainPath('ws-token'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/ws-token')>()
    return {
      ...actual,
      getOrCreateWsToken: () => (state.wsBound === null ? '' : actual.getOrCreateWsToken())
    }
  })
  vi.doMock(mainPath('web-client-server'), () => ({
    createWebClientServer: () => ({ on: () => {}, listen: () => {}, address: () => null })
  }))
  vi.doMock(mainPath('path-fix'), () => ({ fixPathFromLoginShell: () => Promise.resolve() }))
  vi.doMock(mainPath('control-server'), () => ({ startControlServer: () => new Promise(() => {}) }))
  vi.doMock(mainPath('announcements-poller'), () => ({
    AnnouncementsPoller: class {
      start(): void {}
      stop(): void {}
    }
  }))
  vi.doMock(mainPath('github-auth'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/github-auth')>()),
    resolveGitHubToken: () => new Promise(() => {})
  }))
  vi.doMock(mainPath('hooks'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/hooks')>()),
    watchStatusDir: () => () => {},
    cleanupTerminalLog: () => {}
  }))
  vi.doMock(mainPath('worktree'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/worktree')>()),
    listWorktrees: async (repoRoot: string) => state.worktrees.filter((wt) => wt.repoRoot === repoRoot)
  }))
  vi.doMock(mainPath('mcp-config'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/mcp-config')>()),
    pruneMcpConfigs: () => {},
    writeMcpConfigForTerminal: () => {}
  }))
  vi.doMock(mainPath('secrets'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/secrets')>()),
    setSecret: (key: string, value: string) => void state.secrets.set(key, value),
    getSecret: (key: string) => state.secrets.get(key) ?? null,
    hasSecret: (key: string) => state.secrets.has(key),
    deleteSecret: (key: string) => void state.secrets.delete(key),
    resetSecretsBackendForTests: () => {}
  }))
  vi.doMock(mainPath('agents'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/agents')>()
    const installer = (): void => {
      if (state.inHandler && state.hooksInstaller === 'throw') throw new Error(HOOKS_INSTALLER_ERROR)
    }
    return {
      ...actual,
      getAgent: (kind: Parameters<typeof actual.getAgent>[0]) => ({
        ...actual.getAgent(kind),
        installHooks: installer,
        uninstallHooks: installer,
        hooksInstalled: () => false,
        stripHooksFromWorktree: () => false
      })
    }
  })
  vi.doMock(mainPath('persistence'), async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../src/main/persistence')>()),
    saveConfig: (config: unknown) => {
      state.saves.push(JSON.stringify(config, null, 2))
    }
  }))
  vi.doMock(mainPath('store'), async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../src/main/store')>()
    class RecordingStore extends actual.Store {
      constructor(...args: ConstructorParameters<typeof actual.Store>) {
        super(...args)
        state.store = this
      }
      override dispatch(event: StateEvent): void {
        state.dispatchCount += 1
        if (state.recording) state.events.push(clone(event))
        super.dispatch(event)
      }
    }
    return { ...actual, Store: RecordingStore }
  })
}

function assertInside(sandbox: string, path: string, what: string, allowEqual = false): void {
  const rel = relative(sandbox, resolve(path))
  if ((rel === '' && !allowEqual) || rel.startsWith('..')) {
    throw new Error(`${what} (${path}) is outside the recorder sandbox ${sandbox}`)
  }
}

export function sandboxRoot(): string {
  const sandbox = process.env.CORE_SANDBOX
  if (!sandbox || process.env.HOME !== sandbox || process.env.TMPDIR !== sandbox) {
    throw new Error('the handler recorder must run through `pnpm fixtures:record-core` (sandboxed HOME and TMPDIR)')
  }
  const realHome = resolve(userInfo().homedir)
  if (!relative(resolve(sandbox), realHome).startsWith('..')) {
    throw new Error(`the recorder sandbox ${sandbox} is or contains the real home ${realHome}`)
  }
  return sandbox
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [map(key), mapStrings(field, map)])
    )
  }
  return value
}

async function settle(isQuiet: () => boolean = () => true): Promise<void> {
  let stableRounds = 0
  let last = -1
  for (let round = 0; round < 200; round++) {
    for (let i = 0; i < 10; i++) await new Promise((done) => realSetImmediate(done))
    await new Promise((done) => realSetTimeout(done, 5))
    const now = state.dispatchCount * 100_000 + state.saves.length
    if (now === last && isQuiet()) {
      stableRounds += 1
      if (stableRounds >= 3) return
    } else {
      stableRounds = 0
      last = now
    }
  }
  throw new Error('src/main did not settle')
}

function fileOrNull(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function sizeOf(path: string): number {
  return existsSync(path) ? statSync(path).size : 0
}

function newLines(path: string, from: number, file: LogLine['file']): LogLine[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path).subarray(from).toString('utf8')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => ({ file, line: line.replace(/^\[\d\d:\d\d:\d\d\.\d{3}\]/, '[<ts>]') }))
}

export async function recordHandlerCase(fixture: HandlerCase): Promise<HandlerExpected> {
  const sandbox = sandboxRoot()
  Object.assign(state, freshState())

  const caseRoot = mkdtempSync(join(sandbox, 'case-'))
  const dataDir = join(caseRoot, 'data')
  const homeDir = join(caseRoot, 'home')
  const reposDir = join(caseRoot, 'repos')
  for (const dir of [dataDir, homeDir, reposDir]) mkdirSync(dir)
  const toCase = (text: string): string => text.replaceAll(CASE_ROOT_TOKEN, caseRoot)
  const fromCase = (text: string): string => text.replaceAll(caseRoot, CASE_ROOT_TOKEN)

  const configBefore = toCase(fixture.configBefore)
  const canonical = loadAndSave({ name: fixture.name, now: fixture.now, input: configBefore }).expected
  if (canonical !== configBefore) {
    throw new Error(
      `${fixture.name}: configBefore is not canonical; use these bytes (loadConfig + saveConfigSync at \`now\`):\n${JSON.stringify(fromCase(canonical))}`
    )
  }
  writeFileSync(join(dataDir, 'config.json'), configBefore)
  if (fixture.themesDir !== undefined) {
    cpSync(join(THEMES_FIXTURES, fixture.themesDir), join(dataDir, 'themes'), { recursive: true })
  }
  if (fixture.activityBefore !== undefined) writeFileSync(join(dataDir, 'activity.json'), fixture.activityBefore)
  if (fixture.debugLogBefore !== undefined) writeFileSync(join(dataDir, 'debug.log'), fixture.debugLogBefore)
  const repoPath = (key: string): string => join(reposDir, key, '.harness.json')
  for (const [key, bytes] of Object.entries(fixture.repoFiles ?? {})) {
    assertInside(reposDir, join(reposDir, key), `repoFiles key ${key}`)
    mkdirSync(join(reposDir, key), { recursive: true })
    if (bytes !== null) writeFileSync(repoPath(key), toCase(bytes))
  }
  for (const [key, value] of Object.entries(fixture.secretsBefore ?? {})) {
    if (value !== null) state.secrets.set(key, value)
  }
  state.ids = [...(fixture.ids ?? [])]
  state.randomBytes = [...(fixture.randomBytes ?? [])]
  state.hooksInstaller = fixture.hooksInstaller
  state.worktrees = mapStrings(fixture.worktrees ?? [], toCase) as Worktree[]
  state.wsBound = fixture.wsBound === undefined ? DEFAULT_WS_BOUND : fixture.wsBound

  const saved = {
    home: process.env.HOME,
    data: process.env.HARNESS_DATA_DIR,
    argv: process.argv
  }
  const listeners = {
    SIGINT: process.listeners('SIGINT'),
    SIGTERM: process.listeners('SIGTERM')
  }
  process.env.HOME = homeDir
  process.env.HARNESS_DATA_DIR = dataDir
  process.argv = [process.execPath, 'harness-server', '--port', '0', '--host', '127.0.0.1']
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
    fault(`src/main called process.exit(${String(code)})`)
  })
  const uuidSpy = vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => nextId() as `${string}-${string}-${string}-${string}-${string}`
  )
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.useFakeTimers({ now: fixture.now, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })

  try {
    vi.resetModules()
    registerMocks()
    const paths = await import('../../../src/main/paths')
    assertInside(sandbox, paths.userDataDir(), 'userDataDir()')
    assertInside(sandbox, homedir(), 'os.homedir()')
    assertInside(sandbox, tmpdir(), 'os.tmpdir()', true)
    await import('../../../src/main')
    await settle(() => state.requests.size > 0)
    for (const bytes of state.saves) {
      if (bytes !== configBefore) {
        throw new Error(
          `${fixture.name}: boot rewrote config.json; add the boot's changes to configBefore:\n${JSON.stringify(fromCase(bytes))}`
        )
      }
    }

    for (const event of fixture.setup ?? []) {
      state.store?.dispatch(mapStrings(event, toCase) as StateEvent)
    }
    await settle()

    const debugLog = join(dataDir, 'debug.log')
    const perfLog = join(dataDir, 'perf.log')
    const logStart = { debug: sizeOf(debugLog), perf: sizeOf(perfLog) }
    state.saves = []
    state.events = []
    state.recording = true
    state.inHandler = true
    let reply: HandlerReply | undefined
    try {
      reply = await invoke(fixture, toCase)
    } finally {
      state.inHandler = false
    }
    await settle()
    state.recording = false
    if (state.fault !== null) throw new Error(`${fixture.name}: ${state.fault}`)

    const expected: HandlerExpected = {
      configAfter: state.saves.length > 0 ? state.saves[state.saves.length - 1] : null,
      events: state.events
    }
    if (reply !== undefined) expected.reply = reply
    if (fixture.repoFiles !== undefined) {
      expected.repoFilesAfter = Object.fromEntries(
        Object.keys(fixture.repoFiles).map((key) => [key, fileOrNull(repoPath(key))])
      )
    }
    if (fixture.secretsBefore !== undefined) {
      expected.secretsAfter = Object.fromEntries(
        Object.keys(fixture.secretsBefore).map((key) => [key, state.secrets.get(key) ?? null])
      )
    }
    const logLines = [
      ...newLines(debugLog, logStart.debug, 'debug.log'),
      ...newLines(perfLog, logStart.perf, 'perf.log')
    ]
    if (logLines.length > 0) expected.logLines = logLines
    if (fixture.debugLogBefore !== undefined && !readFileSync(debugLog, 'utf8').startsWith(fixture.debugLogBefore)) {
      throw new Error(`${fixture.name}: debugLogBefore did not survive at the start of debug.log`)
    }
    if (fixture.activityBefore !== undefined) {
      vi.advanceTimersByTime(1000)
      expected.activityAfter = fileOrNull(join(dataDir, 'activity.json'))
    }
    return mapStrings(expected, fromCase) as HandlerExpected
  } finally {
    vi.useRealTimers()
    logSpy.mockRestore()
    uuidSpy.mockRestore()
    exitSpy.mockRestore()
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!listeners[signal].includes(listener)) process.off(signal, listener)
      }
    }
    process.env.HOME = saved.home
    process.env.HARNESS_DATA_DIR = saved.data
    process.argv = saved.argv
  }
}

async function invoke(fixture: HandlerCase, toCase: (text: string) => string): Promise<HandlerReply | undefined> {
  const args = mapStrings(fixture.args ?? [], toCase) as unknown[]
  const ctx = { clientId: CLIENT_ID }
  if (fixture.kind === 'event') {
    if (!fixture.event) throw new Error(`${fixture.name}: kind "event" needs \`event\``)
    state.store?.dispatch(mapStrings(fixture.event, toCase) as StateEvent)
    return undefined
  }
  if (!fixture.channel) throw new Error(`${fixture.name}: kind "${fixture.kind}" needs \`channel\``)
  if (fixture.kind === 'signal') {
    const handler = state.signals.get(fixture.channel)
    if (!handler) throw new Error(`${fixture.name}: no signal handler registered for ${fixture.channel}`)
    handler(ctx, ...args)
    return undefined
  }
  const handler = state.requests.get(fixture.channel)
  if (!handler) throw new Error(`${fixture.name}: no request handler registered for ${fixture.channel}`)
  return replyOf(() => handler(ctx, ...args))
}

export async function replyOf(run: () => unknown): Promise<HandlerReply> {
  try {
    const value = await run()
    return value === undefined ? { noValue: true } : { value: clone(value) }
  } catch (err) {
    if (err instanceof RecorderFault) throw err
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
